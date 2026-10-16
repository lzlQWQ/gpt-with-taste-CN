import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {run} from './install.mjs';
import {setInstructions} from '../src/toml-overlay.mjs';
import {WAIT_TOOL_MATCHER} from '../hooks/local-tools.mjs';
import {hookGroup, installHook, ROUTES} from '../src/hooks-overlay.mjs';
import {MARKET, MARKET_ROOT, ID, pluginBundle} from '../src/codex-plugin.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=path.join(repo,'.tmp/install-test');
const receipt=root=>path.join(root,'.gpt-with-taste/install-receipt.json');
async function put(file,text){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
async function exists(file){return fs.access(file).then(()=>true,()=>false);}
async function fixture(t){
  await fs.mkdir(scratch,{recursive:true});const dir=await fs.mkdtemp(path.join(scratch,'case-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'clone'),home=path.join(dir,'Codex Home');await fs.mkdir(home,{recursive:true});
  for(const [name,text]of Object.entries({main:'FIXTURE MAIN — no behavioral claim',sub:'FIXTURE SUB','user-steer':'FIXTURE USER STEER','sub-steer':'FIXTURE SUB STEER','agent-steer':'FIXTURE AGENT STEER'})){
    await put(path.join(root,`prompts/${name}.zh-CN.md`),text+'\n');
    await put(path.join(root,`prompts/${name}.md`),text+'\n');
  }
  for(const file of ['hooks/steer.mjs','hooks/local-tools.mjs','plugin/plugin.json','plugin/marketplace.json'])await put(path.join(root,file),await fs.readFile(path.join(repo,file)));
  const state={market:null,plugin:null},calls=[];
  const api={
    async inventory(){calls.push('inventory');return structuredClone(state);},
    async install(marketRoot){calls.push('install');state.market={name:MARKET,root:marketRoot};state.plugin={pluginId:ID,installed:true,enabled:true};const installedPath=path.join(home,'plugins','cache',MARKET,'gpt-with-taste','0.1.0');await fs.rm(installedPath,{recursive:true,force:true});await fs.cp(path.join(marketRoot,'plugins','gpt-with-taste'),installedPath,{recursive:true});return {installedPath};},
    async remove(){calls.push('remove');state.plugin=null;await fs.rm(path.join(home,'plugins','cache',MARKET),{recursive:true,force:true});},
    async removeMarket(){calls.push('removeMarket');state.market=null;},
  };
  const services={plugin:api,checkUpdates:async()=>({status:'unavailable',reason:'offline fixture'})};
  const call=(...args)=>run(['--home',home,...args],root,services);
  return {root,home,call,state,calls,api,services};
}
const original='\uFEFF# local config\r\nmodel = "existing-gpt"\r\nmodel_reasoning_effort = "high"\r\nmodel_instructions_file = \'old/main.md\' # preserve\r\n[model_providers.private]\r\nexperimental_bearer_token = "fixture-secret-not-real"\r\n[agents.worker]\r\nconfig_file = "roles/worker.toml"\r\n[features]\r\nmulti_agent = true\r\n[mcp_servers.local]\r\ncommand = "fixture"\r\n';
test('prompt-only preserves all other bytes and hooks; no Codex prerequisite; original baseline survives updates',async t=>{
  const {root,home,call,calls}=await fixture(t);await put(path.join(home,'config.toml'),original);await put(path.join(home,'hooks.json'),'INVALID USER HOOK FILE');
  await call('--dry-run');assert.equal(await exists(receipt(root)),false);await call();
  assert.equal(await fs.readFile(path.join(home,'config.toml'),'utf8'),setInstructions(original,path.join(home,'prompts/gpt-with-taste/main.zh-CN.md')));
  const baseline=await fs.readFile(receipt(root),'utf8');assert.equal(baseline.includes('fixture-secret'),false);await call();assert.equal(await fs.readFile(receipt(root),'utf8'),baseline);
  await put(path.join(root,'prompts/main.zh-CN.md'),'UPDATED');await call();await fs.appendFile(path.join(home,'config.toml'),'[analytics]\r\nenabled = false\r\n');await call('--check');await call('--restore');
  assert.equal(await fs.readFile(path.join(home,'config.toml'),'utf8'),original+'[analytics]\r\nenabled = false\r\n');assert.equal(await fs.readFile(path.join(home,'hooks.json'),'utf8'),'INVALID USER HOOK FILE');assert.deepEqual(calls,[]);
});
for (const newline of ['\n', '\r\n']) test(`EOF instruction line accepts an unrelated ${JSON.stringify(newline)} append and restores safely`, async t => {
  const {home, call} = await fixture(t), config = path.join(home, 'config.toml');
  const before = 'model_instructions_file = "old/main.md" # original EOF';
  const added = `${newline}[analytics]${newline}enabled = false${newline}`;
  await put(config, before);
  await call();
  await fs.appendFile(config, added);
  await call('--check');
  await call();
  const installed = await fs.readFile(config, 'utf8');
  await put(config, installed.replace('/main.zh-CN.md', '/user-choice.md'));
  await assert.rejects(call('--check'), /config key has drifted/);
  await assert.rejects(call('--restore'), /config key has drifted/);
  await put(config, installed);
  await call('--restore');
  assert.equal(await fs.readFile(config, 'utf8'), before + added);
});
test('EOF instruction line restores without adding a final newline when nothing was appended', async t => {
  const {home, call} = await fixture(t), config = path.join(home, 'config.toml');
  const before = 'model_instructions_file = "old/main.md"';
  await put(config, before);
  await call();
  await call('--check');
  await call('--restore');
  assert.equal(await fs.readFile(config, 'utf8'), before);
});
test('unknown managed bytes require explicit replacement and restore exactly',async t=>{
  const {home,root,call}=await fixture(t);const file=path.join(home,'prompts/gpt-with-taste/main.zh-CN.md'),old=Buffer.from([0,1,255,13,10]);await put(file,old);
  await assert.rejects(call(),/Unknown managed target/);assert.equal(await exists(receipt(root)),false);await call('--replace-managed');await call('--restore');assert.deepEqual(await fs.readFile(file),old);assert.equal(await exists(path.join(home,'config.toml')),false);
});
test('managed prompt/config drift stops recovery before changing state',async t=>{
  const {home,root,call}=await fixture(t);await call();const file=path.join(home,'prompts/gpt-with-taste/main.zh-CN.md'),installed=await fs.readFile(file);await put(file,'USER EDIT');const before=await fs.readFile(receipt(root));await assert.rejects(call('--replace-managed'),/drifted/);await assert.rejects(call('--restore'),/drifted/);assert.deepEqual(await fs.readFile(receipt(root)),before);
  await put(file,installed);await put(path.join(home,'config.toml'),'model_instructions_file = "other.md"\n');await assert.rejects(call('--restore'),/config key has drifted/);
});
test('plugin bundle installs three routes, leaves all user hooks untouched, updates and restores',async t=>{
  const {root,home,call,state,calls}=await fixture(t);await put(path.join(home,'hooks.json'),'USER HOOK JSON IS NOT OURS');await put(path.join(home,'config.toml'),original);
  await call();await call('--hooks','--dry-run');assert.equal(state.plugin,null);await call('--hooks');assert.equal(state.plugin.enabled,true);
  const data=JSON.parse(await fs.readFile(receipt(root)));const hooks=JSON.parse(await fs.readFile(path.join(data.plugin.cacheRoot,'hooks/hooks.json')));
  assert.deepEqual(Object.keys(hooks.hooks),['UserPromptSubmit','SubagentStart','PostToolUse']);assert.equal(hooks.hooks.PostToolUse[0].matcher,WAIT_TOOL_MATCHER);assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].timeout,15);assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command,process.platform==='win32'?/\$env:PLUGIN_ROOT/:/\$\{PLUGIN_ROOT\}/);assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command,/--route user$/);assert.match(hooks.hooks.SubagentStart[0].hooks[0].command,/--route sub$/);assert.match(hooks.hooks.PostToolUse[0].hooks[0].command,/--route agent$/);
  const baseline=await fs.readFile(receipt(root));await call('--hooks');assert.deepEqual(await fs.readFile(receipt(root)),baseline);assert.equal(calls.filter(name=>name==='install').length,1);
  await put(path.join(root,'prompts/user-steer.zh-CN.md'),'UPDATED STEER');await call('--hooks');const updated=JSON.parse(await fs.readFile(receipt(root)));assert.equal(await fs.readFile(path.join(updated.plugin.cacheRoot,'prompts/user-steer.zh-CN.md'),'utf8'),'UPDATED STEER');assert.equal(updated.config.before,data.config.before);
  await fs.appendFile(path.join(home,'config.toml'),'[analytics]\r\nenabled = false\r\n');await call('--check');await call('--restore');assert.equal(state.market,null);assert.equal(state.plugin,null);assert.equal(await fs.readFile(path.join(home,'config.toml'),'utf8'),original+'[analytics]\r\nenabled = false\r\n');assert.equal(await fs.readFile(path.join(home,'hooks.json'),'utf8'),'USER HOOK JSON IS NOT OURS');assert.equal(await exists(path.join(home,MARKET_ROOT,'plugins/gpt-with-taste/hooks/steer.mjs')),false);
});
test('plugin collisions and cache drift fail closed; prompt-only updates do not inspect plugin',async t=>{
  const {root,home,call,state,calls}=await fixture(t);state.market={name:MARKET,root:'/other'};await assert.rejects(call('--hooks'),/not owned/);assert.equal(await exists(receipt(root)),false);state.market=null;await call('--hooks');const data=JSON.parse(await fs.readFile(receipt(root)));await put(path.join(data.plugin.cacheRoot,'hooks/steer.mjs'),'USER CACHE EDIT');const before=await fs.readFile(receipt(root));await assert.rejects(call('--restore'),/file has drifted/);assert.deepEqual(await fs.readFile(receipt(root)),before);assert.equal(state.plugin.enabled,true);
  calls.length=0;await put(path.join(root,'prompts/main.zh-CN.md'),'NEW MAIN');await call();assert.deepEqual(calls,[]);await assert.rejects(call('--check'),/file has drifted/);
});
async function legacy(f,single=true,matchingBaseline=false){
  const {root,home,call}=f;await put(path.join(home,'config.toml'),original);await call();const data=JSON.parse(await fs.readFile(receipt(root)));const cmd='node "owned-legacy-steer.mjs"',peer={hooks:[{type:'command',command:'other-sol-recipe-steer.mjs'}]};
  const value={hooks:{UserPromptSubmit:[peer],Stop:[peer]}};if(matchingBaseline)value.hooks.UserPromptSubmit.push(hookGroup(cmd));
  const groups=(single?ROUTES.slice(0,1):ROUTES).map(route=>installHook(value,cmd,route));
  for(const name of ['hooks/steer.mjs','prompts/user-steer.md']){const bytes=await fs.readFile(path.join(root,name)),target=`gpt-with-taste/${name}`;await put(path.join(home,target),bytes);data.files.push({path:target,before:null,after:bytes.toString('base64')});}
  const hookState={fileWasAbsent:false,hadHooks:true};if(single)data.hook={...groups[0],...hookState};else {data.hookGroups=groups;data.hookState=hookState;}
  await put(path.join(home,'hooks.json'),JSON.stringify(value));await put(receipt(root),JSON.stringify(data));return {data,peer,cmd};
}
for(const single of [true,false])test(`legacy ${single?'single':'three'} route migration disables exact owned groups and restores original baseline`,async t=>{
  const f=await fixture(t);const {data,peer}=await legacy(f,single);await f.call('--check');await f.call('--hooks');const upgraded=JSON.parse(await fs.readFile(receipt(f.root)));assert.equal(upgraded.hook,undefined);assert.ok(upgraded.hookGroups.every(group=>group.after===null));assert.equal(upgraded.config.before,data.config.before);let hooks=JSON.parse(await fs.readFile(path.join(f.home,'hooks.json')));assert.deepEqual(hooks.hooks.UserPromptSubmit,[peer]);assert.deepEqual(hooks.hooks.Stop,[peer]);await f.call('--hooks');await f.call('--restore');hooks=JSON.parse(await fs.readFile(path.join(f.home,'hooks.json')));assert.deepEqual(hooks.hooks.UserPromptSubmit,[peer]);assert.deepEqual(hooks.hooks.Stop,[peer]);assert.equal(await fs.readFile(path.join(f.home,'config.toml'),'utf8'),original);
});
test('migration restores a matching pre-existing exact-command baseline, not a duplicate during plugin use',async t=>{
  const f=await fixture(t);const {cmd,peer}=await legacy(f,true,true);await f.call('--hooks');assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home,'hooks.json'))).hooks.UserPromptSubmit,[peer]);await f.call('--restore');assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.home,'hooks.json'))).hooks.UserPromptSubmit,[peer,hookGroup(cmd)]);
});
test('legacy receipt restores directly without new plugin sources or Codex',async t=>{
  const f=await fixture(t);await legacy(f);await fs.rm(path.join(f.root,'plugin'),{recursive:true});f.calls.length=0;await f.call('--restore');assert.deepEqual(f.calls,[]);
});
test('CLI install failure retains a recovery receipt; interrupted restore removes only our partial plugin',async t=>{
  const f=await fixture(t);const install=f.api.install;f.api.install=async root=>{await install(root);throw new Error('FIXTURE CLI FAILURE');};await assert.rejects(f.call('--hooks'),/FIXTURE CLI FAILURE.*\nRecovery receipt/);assert.equal(JSON.parse(await fs.readFile(receipt(f.root))).status,'applying');await f.call('--restore');assert.equal(f.state.plugin,null);assert.equal(f.state.market,null);assert.equal(await exists(path.join(f.home,'config.toml')),false);
});
test('interrupted prompt update restores original bytes',async t=>{
  const f=await fixture(t);await f.call();const data=JSON.parse(await fs.readFile(receipt(f.root)));data.status='applying';for(const entry of data.files){entry.previous=entry.after;entry.after=Buffer.from('NEW SOURCE').toString('base64');}data.config.previous=data.config.after;await put(receipt(f.root),JSON.stringify(data));await put(path.join(f.home,data.files[0].path),'NEW SOURCE');await f.call('--restore');assert.equal(await exists(path.join(f.home,data.files[0].path)),false);
});
test('safe TOML insertion preserves multiline unrelated content and rejects invalid managed scalars',async()=>{
  const text='\uFEFFnote = """\nmodel_instructions_file = "not-a-key"\n"""\nitems = [\n  "a",\n]\n["model_providers"."mine"]\nexperimental_bearer_token = "fixture-only"';assert.equal(setInstructions(text,'/home/main.md'),'\uFEFFmodel_instructions_file = "/home/main.md"\n'+text.slice(1));assert.throws(()=>setInstructions('model_instructions_file = "a"\nmodel_instructions_file = "b"\n','/a'),/duplicate/);assert.throws(()=>setInstructions('model_instructions_file = ["not-a-path"]','/a'),/single-line/);
});

test('interrupted plugin refresh accepts previous and new cache bytes while restoring the original baseline',async t=>{
  const f=await fixture(t);await f.call('--hooks');const before=JSON.parse(await fs.readFile(receipt(f.root)));await put(path.join(f.root,'prompts/user-steer.zh-CN.md'),'NEW STEER');
  const install=f.api.install;f.api.install=async root=>{await install(root);throw new Error('REFRESH FAILED AFTER CLI COPY');};
  await assert.rejects(f.call('--hooks'),/REFRESH FAILED/);await f.call('--restore');assert.equal(f.state.plugin,null);assert.equal(f.state.market,null);assert.equal(await exists(path.join(f.home,before.files[0].path)),false);
});

test('interrupted plugin removal resumes with the same receipt after the CLI removed its cache',async t=>{
  const f=await fixture(t);await put(path.join(f.home,'config.toml'),original);await f.call('--hooks');
  const removeMarket=f.api.removeMarket;f.api.removeMarket=async()=>{throw new Error('MARKET REMOVE FAILED');};
  await assert.rejects(f.call('--restore'),/MARKET REMOVE FAILED/);assert.equal(f.state.plugin,null);assert.equal(JSON.parse(await fs.readFile(receipt(f.root))).status,'restoring');
  f.api.removeMarket=removeMarket;await f.call('--restore');assert.equal(f.state.market,null);assert.equal(await fs.readFile(path.join(f.home,'config.toml'),'utf8'),original);
});


test('Windows generated command invokes Node with plugin paths as data and keeps JSON routing', {skip:process.platform!=='win32'}, async t=>{
  const {root}=await fixture(t);
  const plugin=path.join(root,"Plugin's $root with spaces");
  await fs.cp(path.join(repo,'hooks'),path.join(plugin,'hooks'),{recursive:true});
  await fs.cp(path.join(repo,'prompts'),path.join(plugin,'prompts'),{recursive:true});
  const bundle=await pluginBundle(repo);
  const hooks=JSON.parse(bundle.get(`${MARKET_ROOT}/plugins/gpt-with-taste/hooks/hooks.json`));
  const command=hooks.hooks.PostToolUse[0].hooks[0].command;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-Command',command],{env:{...process.env,PLUGIN_ROOT:plugin},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
    child.stdin.end(JSON.stringify({hook_event_name:'PostToolUse',tool_name:'wait_agent',tool_response:{status:{child:{running:true}},timed_out:true}}));
  });
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{continue:true},'Valid running/timeout JSON must not use --route agent fallback');
  const missing=await new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-Command',command],{env:{...process.env,PLUGIN_ROOT:''},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end('{}');
  });
  assert.equal(missing.code,1);assert.equal(missing.stdout,'');assert.match(missing.stderr,/\[LAUNCH_FAILURE\].*PLUGIN_ROOT/);
});

const sourceA={kind:'official',commit:'a'.repeat(40),dirty:false,version:'999-local'};
const sourceB={kind:'official',commit:'b'.repeat(40),dirty:false,version:'0.1.0'};
test('manual update check is read-only, separates checkout and installed prompts/Hooks, and preserves Hooks on prompt-only refresh',async t=>{
  const f=await fixture(t);let selected=sourceA,seen;
  f.services.sourceIdentity=async()=>selected;
  f.services.checkUpdates=async sources=>{seen=structuredClone(sources);return {status:'unavailable',reason:'offline fixture'};};
  await f.call('--check-updates');assert.equal(await exists(receipt(f.root)),false);assert.equal(await exists(path.join(f.home,'config.toml')),false);
  await f.call('--hooks');const baseline=JSON.parse(await fs.readFile(receipt(f.root)));
  assert.deepEqual(baseline.source,{prompts:sourceA,hooks:sourceA});
  selected=sourceB;await put(path.join(f.root,'prompts/main.zh-CN.md'),'NEW PROMPT');
  const before=await fs.readFile(receipt(f.root)),config=await fs.readFile(path.join(f.home,'config.toml'));
  await f.call('--check-updates');assert.deepEqual(seen,{Checkout:sourceB,'Installed prompts':sourceA,'Installed Hooks':sourceA});
  assert.deepEqual(await fs.readFile(receipt(f.root)),before);assert.deepEqual(await fs.readFile(path.join(f.home,'config.toml')),config);
  f.calls.length=0;await f.call();assert.deepEqual(f.calls,[]);
  const updated=JSON.parse(await fs.readFile(receipt(f.root)));assert.deepEqual(updated.source,{prompts:sourceB,hooks:sourceA});
  await f.call('--check-updates');assert.deepEqual(seen['Installed Hooks'],sourceA);assert.deepEqual(seen['Installed prompts'],sourceB);
  assert.deepEqual(updated.plugin,baseline.plugin);assert.equal(updated.config.before,baseline.config.before);
  await f.call('--restore');assert.equal(await exists(path.join(f.home,'config.toml')),false);
});
test('failed refresh retains installed provenance and original recovery baseline; first failed install records no source',async t=>{
  const f=await fixture(t);let selected=sourceA;f.services.sourceIdentity=async()=>selected;
  await f.call('--hooks');const baseline=JSON.parse(await fs.readFile(receipt(f.root)));
  selected=sourceB;await put(path.join(f.root,'prompts/main.zh-CN.md'),'NEW MAIN');const install=f.api.install;
  f.api.install=async root=>{await install(root);throw new Error('PROVENANCE FAILURE');};
  await assert.rejects(f.call('--hooks'),/PROVENANCE FAILURE/);
  const pending=JSON.parse(await fs.readFile(receipt(f.root)));assert.equal(pending.status,'applying');assert.deepEqual(pending.source,baseline.source);assert.equal(pending.config.before,baseline.config.before);
  await f.call('--restore');assert.equal(await exists(path.join(f.home,'config.toml')),false);
  await assert.rejects(f.call('--hooks'),/PROVENANCE FAILURE/);assert.equal(JSON.parse(await fs.readFile(receipt(f.root))).source,undefined);await f.call('--restore');
});
test('offline check still installs; explicit skip, integrity check, help and restore never invoke network check',async t=>{
  const f=await fixture(t);let calls=0;
  f.services.checkUpdates=async()=>{calls++;return {status:'unavailable',reason:'timed out after 5000 ms'};};
  await f.call();assert.equal(calls,1);assert.equal(JSON.parse(await fs.readFile(receipt(f.root))).status,'applied');
  f.services.checkUpdates=async()=>{throw new Error('MUST NOT CALL NETWORK');};
  await f.call('--skip-update-check');await f.call('--check');await f.call('--help');await f.call('--restore');
});
test('old receipts have unknown provenance and still restore; installed drift is not reported as official-current',async t=>{
  const f=await fixture(t);f.services.sourceIdentity=async()=>sourceA;await f.call();
  const legacy=JSON.parse(await fs.readFile(receipt(f.root)));delete legacy.source;await put(receipt(f.root),JSON.stringify(legacy));
  let seen;f.services.checkUpdates=async sources=>{seen=structuredClone(sources);return {status:'unavailable',reason:'offline'};};
  await f.call('--check-updates');assert.equal(seen['Installed prompts'],undefined);await f.call('--restore');
  await f.call();await put(path.join(f.home,'prompts/gpt-with-taste/main.zh-CN.md'),'USER EDIT');await f.call('--check-updates');assert.equal(seen['Installed prompts'].dirty,true);
});

test('manual update check defaults to saved home without changing install or restore defaults',async t=>{
  const f=await fixture(t);await f.call();const before=await fs.readFile(receipt(f.root));
  const previous=process.env.CODEX_HOME;delete process.env.CODEX_HOME;
  const log=console.log,output=[];console.log=value=>output.push(value);
  try{
    await run(['--check-updates'],f.root,f.services);
    assert.ok(output.some(value=>value.includes(`Selected Codex home: ${f.home}`)));
    assert.ok(output.some(value=>value.includes(`--home ${JSON.stringify(f.home)}`)));
    await assert.rejects(run(['--skip-update-check'],f.root,f.services),/Receipt belongs to another home/);
    await assert.rejects(run(['--restore'],f.root,f.services),/Receipt belongs to another home/);
    assert.deepEqual(await fs.readFile(receipt(f.root)),before);
  }finally{console.log=log;if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});
test('manual update check keeps explicit home and CODEX_HOME binding instead of selecting saved home',async t=>{
  const f=await fixture(t);await f.call();const before=await fs.readFile(receipt(f.root)),wrong=path.join(f.home,'wrong-target');
  const previous=process.env.CODEX_HOME;delete process.env.CODEX_HOME;
  try{
    await assert.rejects(run(['--check-updates','--home',wrong],f.root,f.services),/Receipt belongs to another home/);
    process.env.CODEX_HOME=wrong;
    await assert.rejects(run(['--check-updates'],f.root,f.services),/Receipt belongs to another home/);
    await run(['--check-updates','--home',f.home],f.root,f.services);
    assert.deepEqual(await fs.readFile(receipt(f.root)),before);
  }finally{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});
