import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {fallbackHook, handleHook, evaluateHook} from './steer.mjs';
import {normalizeLocalTool, WAIT_TOOL_MATCHER} from './local-tools.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-with-taste-hook-'));
  for (const source of ['user', 'sub', 'agent']) fs.writeFileSync(path.join(dir, `${source}-steer.zh-CN.md`), `${source.toUpperCase()} WHOLE SOURCE\n`);
  t.after(() => fs.rmSync(dir, {recursive: true}));
  return dir;
}
function context(event, route, dir) {
  const input = structuredClone(event);
  const output = handleHook(event, dir);
  assert.deepEqual(event, input, 'Original request/result object must not change');
  assert.deepEqual(output, {continue: true, hookSpecificOutput: {
    hookEventName: event.hook_event_name,
    additionalContext: `<gpt-with-taste-${route}-steer>\n${route.toUpperCase()} WHOLE SOURCE\n</gpt-with-taste-${route}-steer>`
  }});
}
test('each input source targets only its own consumer', t => {
  const dir = fixture(t);
  context({hook_event_name: 'UserPromptSubmit', session_id: 'main', prompt: 'ordinary human request'}, 'user', dir);
  context({hook_event_name: 'SubagentStart', session_id: 'parent', agent_id: 'child', agent_type: 'explore'}, 'sub', dir);
  context({hook_event_name: 'UserPromptSubmit', session_id: 'child', agent_id: 'child', prompt: 'parent follow-up'}, 'sub', dir);
  for (const tool_name of ['wait_agent', 'multi_agent_v1wait_agent']) {
    context({hook_event_name: 'PostToolUse', tool_name, tool_response: JSON.stringify({status: {child: {completed: 'Full unmodified receipt'}}, timed_out: false})}, 'agent', dir);
    assert.deepEqual(handleHook({hook_event_name: 'PostToolUse', tool_name, agent_id: 'child', tool_response: {status: {other: {completed: 'receipt'}}, timed_out: false}}, dir), {continue: true});
    assert.deepEqual(handleHook({hook_event_name: 'PostToolUse', tool_name, tool_response: {status: {child: {running: true}}, timed_out: true}}, dir), {continue: true});
  }
});
test('shell, MCP, subagent stop, spawn ids, timeouts and child tool results receive no main agent steer', t => {
  const dir = fixture(t);
  for (const event of [
    {hook_event_name: 'SubagentStop', last_assistant_message: 'receipt'},
    {hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: {status: {child: {completed: 'receipt'}}}},
    {hook_event_name: 'PostToolUse', tool_name: 'mcp__server__wait_agent', tool_response: {status: {child: {completed: 'receipt'}}}},
    {hook_event_name: 'PostToolUse', tool_name: 'spawn_agent', tool_response: {agent_id: 'child'}},
    {hook_event_name: 'PostToolUse', tool_name: 'wait_agent', tool_response: {status: {}, timed_out: true}},
    {hook_event_name: 'PostToolUse', tool_name: 'wait_agent', tool_response: {status: {child: {running: true}}}},
    {hook_event_name: 'PostToolUse', tool_name: 'wait_agent', tool_response: 'Error: unavailable'},
    {hook_event_name: 'PostToolUse', tool_name: 'wait_agent', tool_response: {status: {child: {completed: 'partial'}}, timed_out: true}},
    {hook_event_name: 'PostToolUse', tool_name: 'wait_agent', agent_id: 'child', tool_response: {status: {other: {completed: 'receipt'}}, timed_out: false}},
    {hook_event_name: 'PreToolUse', tool_name: 'send_input', tool_input: {id: 'child', message: 'Parent brief stays intact'}},
  ]) assert.deepEqual(handleHook(event, dir), {continue: true});
});
test('malformed event and missing source fail visibly', t => {
  assert.throws(() => handleHook('{'), SyntaxError);
  assert.throws(() => handleHook(null), /event object/);
  assert.throws(() => fallbackHook('unknown'), /Invalid --route fallback/);
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, 'sub-steer.zh-CN.md'));
  assert.throws(() => handleHook({hook_event_name: 'SubagentStart'}, dir), /ENOENT/);
});

function runCli(args, input, audit, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'steer.mjs'), ...args], {
      env: {...process.env, ...(audit ? {GPT_WITH_TASTE_HOOK_AUDIT: audit} : {}), ...environment},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
    child.stdin.end(input);
  });
}

test('empty stdin fails with missing metadata for every route and never synthesizes context', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-with-taste-cli-'));
  t.after(() => fs.rmSync(dir, {recursive: true}));
  for (const route of ['user', 'sub', 'agent']) {
    const audit=path.join(dir,`${route}.jsonl`);
    const result=await runCli(['--route',route],'',audit);
    assert.equal(result.code,1);
    assert.equal(result.stdout,'');
    assert.match(result.stderr,/\[MISSING_METADATA\].*requires event JSON/);
    const record=JSON.parse(fs.readFileSync(audit,'utf8'));
    assert.equal(record.reason,'MISSING_METADATA');assert.equal(record.injected,false);
  }
});

test('empty stdin without an explicit route remains a visible failure', async () => {
  const result = await runCli([], '', null);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Expected a Codex hook event JSON object/);
});

test('valid JSON keeps the original route selection and does not use fallback', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-with-taste-valid-'));
  t.after(() => fs.rmSync(dir, {recursive: true}));
  const audit = path.join(dir, 'event.jsonl');
  const result = await runCli(['--route', 'agent'], JSON.stringify({hook_event_name: 'UserPromptSubmit', prompt: 'request'}) + '\n', audit);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /<gpt-with-taste-user-steer>/);
  const record = JSON.parse(fs.readFileSync(audit, 'utf8'));
  assert.equal(record.route, 'user');
  assert.equal(record.fallback, false);
});


test('a child first turn gets Sub once while later parent messages keep their reminder', t => {
  const prompts = fixture(t);
  const data = path.join(prompts, 'plugin-data');
  const identity = {session_id: 'parent', agent_id: 'child', turn_id: 'first'};
  const start = handleHook({...identity, hook_event_name: 'SubagentStart'}, prompts, data);
  assert.match(start.hookSpecificOutput.additionalContext, /<gpt-with-taste-sub-steer>/);
  assert.deepEqual(handleHook({...identity, hook_event_name: 'UserPromptSubmit'}, prompts, data), {continue: true});
  const followup = handleHook({...identity, turn_id: 'second', hook_event_name: 'UserPromptSubmit'}, prompts, data);
  assert.match(followup.hookSpecificOutput.additionalContext, /<gpt-with-taste-sub-steer>/);
  // A start record must never suppress a different turn, even if its first input was absent.
  handleHook({...identity, agent_id: 'other', hook_event_name: 'SubagentStart'}, prompts, data);
  assert.match(handleHook({...identity, agent_id: 'other', turn_id: 'later', hook_event_name: 'UserPromptSubmit'}, prompts, data).hookSpecificOutput.additionalContext, /<gpt-with-taste-sub-steer>/);
});


test('formal local function names normalize without accepting shell or MCP lookalikes', t => {
  const dir = fixture(t), matcher = new RegExp(WAIT_TOOL_MATCHER);
  for (const name of ['wait_agent', 'multi_agent_v1.wait_agent', 'multi_agent_v1wait_agent', 'collaboration.wait_agent', 'collaborationwait_agent']) {
    assert.equal(normalizeLocalTool(name), 'wait_agent');
    assert.equal(matcher.test(name), true);
    context({hook_event_name:'PostToolUse',tool_name:name,tool_response:{status:{child:{completed:'whole receipt'}},timed_out:false}}, 'agent', dir);
  }
  for (const name of ['Bash','mcp__server__wait_agent','multi_agent_v1.wait','multi_agent_v2wait_agent','prefix_wait_agent','multi_agent_v1Xwait_agent']) {
    assert.equal(normalizeLocalTool(name), null);
    assert.equal(matcher.test(name), false);
  }
});

test('event outcomes distinguish unsupported, incomplete, deduplicated and missing metadata', t => {
  const dir = fixture(t), data = path.join(dir,'data');
  assert.equal(evaluateHook({hook_event_name:'SessionStart'},dir).reason,'UNSUPPORTED_EVENT');
  assert.equal(evaluateHook({hook_event_name:'PostToolUse',tool_name:'Bash'},dir).reason,'UNSUPPORTED_TOOL');
  assert.equal(evaluateHook({hook_event_name:'PostToolUse',tool_name:'multi_agent_v1wait_agent',tool_response:{status:{child:'not_found'},timed_out:false}},dir).reason,'NOT_COMPLETED');
  assert.equal(evaluateHook({hook_event_name:'PostToolUse',tool_name:'wait_agent',agent_id:'child'},dir).reason,'CHILD_RESULT');
  for (const event of [{}, {hook_event_name:'PostToolUse'}, {hook_event_name:'PostToolUse',tool_name:'wait_agent'}, {hook_event_name:'SubagentStart',agent_id:'child'}]) {
    assert.throws(()=>evaluateHook(event,dir,data), {code:'MISSING_METADATA'});
  }
  const identity={session_id:'parent',agent_id:'child',turn_id:'first'};
  assert.equal(evaluateHook({...identity,hook_event_name:'SubagentStart'},dir,data).reason,'INJECTED');
  assert.equal(evaluateHook({...identity,hook_event_name:'UserPromptSubmit'},dir,data).reason,'DEDUPLICATED');
  assert.equal(evaluateHook({...identity,turn_id:'later',hook_event_name:'UserPromptSubmit'},dir,data).reason,'INJECTED');
  fs.unlinkSync(path.join(dir,'user-steer.zh-CN.md'));
  assert.throws(()=>evaluateHook({hook_event_name:'UserPromptSubmit'},dir),{code:'MISSING_SOURCE'});
});

test('optional audit failure keeps normal context; required child state failure is explicit', async t => {
  const dir=fixture(t), event={hook_event_name:'UserPromptSubmit',session_id:'main',turn_id:'turn'};
  const optional=await runCli(['--route','user'],JSON.stringify(event),dir);
  assert.equal(optional.code,0);
  assert.match(JSON.parse(optional.stdout).hookSpecificOutput.additionalContext,/<gpt-with-taste-user-steer>/);
  assert.match(optional.stderr,/\[AUDIT_WRITE_FAILED\]/);
  const blocked=path.join(dir,'not-a-directory');fs.writeFileSync(blocked,'owned fixture');
  const required=await runCli(['--route','sub'],JSON.stringify({hook_event_name:'SubagentStart',session_id:'main',agent_id:'child',turn_id:'first'}),null,{PLUGIN_DATA:blocked});
  assert.equal(required.code,1);assert.equal(required.stdout,'');
  assert.match(required.stderr,/\[STATE_IO_FAILED\]/);
  assert.ok(required.stderr.includes(blocked));
  const malformed=await runCli([],JSON.stringify({hook_event_name:'PostToolUse'}),null);
  assert.equal(malformed.code,1);assert.match(malformed.stderr,/\[MISSING_METADATA\].*tool_name/);
});


test('CLI child routes require plugin state while valid state preserves initial dedup and followups', async t => {
  const dir=fixture(t), identity={session_id:'main',agent_id:'child',turn_id:'first'};
  for (const hook_event_name of ['SubagentStart','UserPromptSubmit']) {
    const input=JSON.stringify({...identity,hook_event_name});
    for (const PLUGIN_DATA of [undefined,'']) {
      const missing=await runCli(['--route','sub'],input,null,{PLUGIN_DATA});
      assert.equal(missing.code,1);assert.equal(missing.stdout,'');
      assert.match(missing.stderr,/\[MISSING_METADATA\].*PLUGIN_DATA/);
    }
  }
  const environment={PLUGIN_DATA:path.join(dir,'data')};
  const start=await runCli(['--route','sub'],JSON.stringify({...identity,hook_event_name:'SubagentStart'}),null,environment);
  assert.equal(start.code,0,start.stderr);assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext,/<gpt-with-taste-sub-steer>/);
  const initial=await runCli(['--route','user'],JSON.stringify({...identity,hook_event_name:'UserPromptSubmit'}),null,environment);
  assert.equal(initial.code,0,initial.stderr);assert.deepEqual(JSON.parse(initial.stdout),{continue:true});
  const later=await runCli(['--route','user'],JSON.stringify({...identity,turn_id:'later',hook_event_name:'UserPromptSubmit'}),null,environment);
  assert.equal(later.code,0,later.stderr);assert.match(JSON.parse(later.stdout).hookSpecificOutput.additionalContext,/<gpt-with-taste-sub-steer>/);
});

test('CLI remembers child session identity without agent_id across startup, followups and child results', async t => {
  const dir = fixture(t), audit = path.join(dir, 'events.jsonl');
  const environment = {PLUGIN_DATA: path.join(dir, 'data')};
  const call = async event => {
    const result = await runCli([], JSON.stringify(event), audit, environment);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const freshMain = await call({hook_event_name: 'UserPromptSubmit', session_id: 'parent', turn_id: 'parent-first'});
  assert.match(freshMain.hookSpecificOutput.additionalContext, /<gpt-with-taste-user-steer>/);
  const start = await call({hook_event_name: 'SubagentStart', session_id: 'parent', agent_id: 'child', turn_id: 'child-first'});
  assert.match(start.hookSpecificOutput.additionalContext, /<gpt-with-taste-sub-steer>/);
  assert.deepEqual(await call({hook_event_name: 'UserPromptSubmit', session_id: 'child', turn_id: 'child-first', prompt: 'PRIVATE_BODY'}), {continue: true});
  for (const turn_id of ['child-second', 'child-third']) {
    const later = await call({hook_event_name: 'UserPromptSubmit', session_id: 'child', turn_id, prompt: 'parent followup'});
    assert.match(later.hookSpecificOutput.additionalContext, /<gpt-with-taste-sub-steer>/);
  }
  const main = await call({hook_event_name: 'UserPromptSubmit', session_id: 'parent', turn_id: 'parent-later'});
  assert.match(main.hookSpecificOutput.additionalContext, /<gpt-with-taste-user-steer>/);
  const receipt = {status: {other: {completed: 'PRIVATE_RESULT'}}, timed_out: false};
  assert.deepEqual(await call({hook_event_name: 'PostToolUse', session_id: 'child', tool_name: 'wait_agent', tool_response: receipt}), {continue: true});
  const result = await call({hook_event_name: 'PostToolUse', session_id: 'parent', tool_name: 'wait_agent', tool_response: receipt});
  assert.match(result.hookSpecificOutput.additionalContext, /<gpt-with-taste-agent-steer>/);
  const rawAudit = fs.readFileSync(audit, 'utf8');
  assert.equal(rawAudit.includes('PRIVATE_BODY'), false);
  assert.equal(rawAudit.includes('PRIVATE_RESULT'), false);
  for (const record of rawAudit.trim().split('\n').map(JSON.parse)) {
    assert.equal(typeof record.emitted, 'boolean');
    assert.equal(record.injected, record.emitted, 'Keep the legacy audit field for existing consumers');
  }
});

test('CLI keeps separate child identities and never suppresses a later turn when the paired input was absent', async t => {
  const dir = fixture(t), environment = {PLUGIN_DATA: path.join(dir, 'data')};
  const call = async event => {
    const result = await runCli([], JSON.stringify(event), null, environment);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const agent_id of ['one', 'two']) await call({hook_event_name: 'SubagentStart', session_id: 'parent', agent_id, turn_id: 'first'});
  const later = await call({hook_event_name: 'UserPromptSubmit', session_id: 'one', turn_id: 'later'});
  assert.match(later.hookSpecificOutput.additionalContext, /<gpt-with-taste-sub-steer>/);
  assert.deepEqual(await call({hook_event_name: 'UserPromptSubmit', session_id: 'two', turn_id: 'first'}), {continue: true});
  const followup = await call({hook_event_name: 'UserPromptSubmit', session_id: 'two', turn_id: 'later'});
  assert.match(followup.hookSpecificOutput.additionalContext, /<gpt-with-taste-sub-steer>/);
});

test('CLI migrates an existing paired-start record when its explicit child input arrives', async t => {
  const dir = fixture(t), data = path.join(dir, 'data'), directory = path.join(data, 'steer-start');
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'parent--child.json'), JSON.stringify({turnId: 'first'}));
  const environment = {PLUGIN_DATA: data};
  const initial = await runCli([], JSON.stringify({hook_event_name: 'UserPromptSubmit', session_id: 'parent', agent_id: 'child', turn_id: 'first'}), null, environment);
  assert.equal(initial.code, 0, initial.stderr);
  assert.deepEqual(JSON.parse(initial.stdout), {continue: true});
  const later = await runCli([], JSON.stringify({hook_event_name: 'UserPromptSubmit', session_id: 'child', turn_id: 'later'}), null, environment);
  assert.equal(later.code, 0, later.stderr);
  assert.match(JSON.parse(later.stdout).hookSpecificOutput.additionalContext, /<gpt-with-taste-sub-steer>/);
});

test('CLI known-child inputs report missing turn metadata and unusable identity state instead of emitting User', async t => {
  const dir = fixture(t), data = path.join(dir, 'data'), environment = {PLUGIN_DATA: data};
  const start = await runCli([], JSON.stringify({hook_event_name: 'SubagentStart', session_id: 'parent', agent_id: 'child', turn_id: 'first'}), null, environment);
  assert.equal(start.code, 0, start.stderr);
  const missing = await runCli([], JSON.stringify({hook_event_name: 'UserPromptSubmit', session_id: 'child'}), null, environment);
  assert.equal(missing.code, 1); assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /\[MISSING_METADATA\]/);
  for (const blocked of [data, path.join(data, 'steer-start')]) {
    fs.rmSync(data, {recursive: true});
    fs.mkdirSync(path.dirname(blocked), {recursive: true});
    fs.writeFileSync(blocked, 'not a directory');
    const unusable = await runCli([], JSON.stringify({hook_event_name: 'UserPromptSubmit', session_id: 'child', turn_id: 'later'}), null, environment);
    assert.equal(unusable.code, 1); assert.equal(unusable.stdout, '');
    assert.match(unusable.stderr, /\[STATE_IO_FAILED\]/);
  }
});


test('current collaboration mailbox wakes get a consumption reminder without asserting a completed receipt', t => {
  const dir = fixture(t);
  for (const tool_name of ['collaboration.wait_agent', 'collaborationwait_agent']) {
    const event = {hook_event_name: 'PostToolUse', tool_name, tool_response: JSON.stringify({message: 'Wait completed.', timed_out: false})};
    context(event, 'agent', dir);
    assert.equal(evaluateHook(event, dir).reason, 'MAILBOX_UPDATE');
  }
  for (const tool_response of [
    {message: 'Wait completed.', timed_out: true},
    {message: 'No agents found.', timed_out: false},
    {message: 'Wait completed.', timed_out: false, status: {child: {running: true}}},
  ]) assert.deepEqual(handleHook({hook_event_name: 'PostToolUse', tool_name: 'collaborationwait_agent', tool_response}, dir), {continue: true});
  for (const tool_name of ['collaborationXwait_agent', 'mcp__collaboration__wait_agent']) {
    assert.equal(new RegExp(WAIT_TOOL_MATCHER).test(tool_name), false);
    assert.deepEqual(handleHook({hook_event_name: 'PostToolUse', tool_name, tool_response: {message: 'Wait completed.', timed_out: false}}, dir), {continue: true});
  }
});
