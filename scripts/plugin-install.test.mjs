// Explicit integration check: CODEX_EXECUTABLE=/absolute/codex node --test scripts/plugin-install.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from './install.mjs';
import {codexPlugin, MARKET_ROOT} from '../src/codex-plugin.mjs';
import {installHook} from '../src/hooks-overlay.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('real Codex CLI installs, updates, deduplicates legacy, checks and restores in an isolated home',async t=>{
  assert.ok(process.env.CODEX_EXECUTABLE,'Set CODEX_EXECUTABLE to the Codex CLI executable');
  const scratch=path.join(repo,'.tmp/plugin-install-test');await fs.mkdir(scratch,{recursive:true});const base=await fs.mkdtemp(path.join(scratch,'case-'));let completed=false;
  t.after(async()=>{
    if(process.env.KEEP_PLUGIN_FIXTURE==='1'&&!completed){console.error(`Failed isolated plugin fixture retained: ${base}`);return;}
    await fs.rm(base,{recursive:true,force:true});
  });
  const root=path.join(base,'clone'),home=path.join(base,'Codex Home');await fs.mkdir(home,{recursive:true});
  for(const file of ['prompts/main.zh-CN.md','prompts/sub.zh-CN.md','prompts/user-steer.zh-CN.md','prompts/sub-steer.zh-CN.md','prompts/agent-steer.zh-CN.md','hooks/steer.mjs','hooks/local-tools.mjs','plugin/plugin.json','plugin/marketplace.json']){const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(repo,file),target);}
  const config='# peer config\nfeatures.hooks = true\nmodel = "existing-gpt"\nmodel_reasoning_effort = "high"\nmodel_instructions_file = \'old/main.md\' # original';await fs.writeFile(path.join(home,'config.toml'),config);
  await fs.mkdir(path.join(home,'old'),{recursive:true});await fs.writeFile(path.join(home,'old/main.md'),'PREVIOUS INSTRUCTIONS\n');
  const call=(...args)=>run(['--home',home,'--codex',process.env.CODEX_EXECUTABLE,...args],root,{checkUpdates:async()=>({status:'unavailable',reason:'offline integration fixture'})});
  const receiptFile=path.join(root,'.gpt-with-taste/install-receipt.json');
  await call();const legacy=JSON.parse(await fs.readFile(receiptFile));
  const peer={hooks:[{type:'command',command:'node peer-sol-recipe-steer.mjs'}]};const hooks={hooks:{UserPromptSubmit:[peer]}};legacy.hook={...installHook(hooks,'node "legacy-owned.mjs"'),fileWasAbsent:false};
  await fs.writeFile(path.join(home,'hooks.json'),JSON.stringify(hooks));await fs.writeFile(receiptFile,JSON.stringify(legacy));
  await call('--hooks','--dry-run');await call('--hooks');await call('--check');
  let data=JSON.parse(await fs.readFile(receiptFile));assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'hooks.json'))).hooks.UserPromptSubmit,[peer]);
  const baseline=await fs.readFile(receiptFile);await call('--hooks');assert.deepEqual(await fs.readFile(receiptFile),baseline);
  await fs.writeFile(path.join(root,'prompts/user-steer.zh-CN.md'),'UPDATED OWNED SOURCE\n');await call('--hooks');data=JSON.parse(await fs.readFile(receiptFile));assert.equal(await fs.readFile(path.join(data.plugin.cacheRoot,'prompts/user-steer.zh-CN.md'),'utf8'),'UPDATED OWNED SOURCE\n');await call('--check');
  await fs.appendFile(path.join(home,'config.toml'),'\n[analytics]\nenabled = false\n');
  await call('--restore','--dry-run');await call('--restore');assert.deepEqual(await codexPlugin(home,process.env.CODEX_EXECUTABLE).inventory(),{market:null,plugin:null});
  const restored=await fs.readFile(path.join(home,'config.toml'),'utf8');assert.ok(restored.includes(config.trimEnd()));assert.match(restored,/\[analytics\]\nenabled = false/);assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'hooks.json'))).hooks.UserPromptSubmit,[peer]);
  await assert.rejects(fs.access(path.join(home,MARKET_ROOT,'plugins/gpt-with-taste/hooks/steer.mjs')),/ENOENT/);
  completed=true;
});
