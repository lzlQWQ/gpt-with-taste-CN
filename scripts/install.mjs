#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {keyLine, sameInstructionLine, setInstructions, restoreInstructions} from '../src/toml-overlay.mjs';
import {parseHooks, assertHook, restoreHook, receiptHooks, retireHook} from '../src/hooks-overlay.mjs';
import {pluginBundle, codexPlugin, assertPluginInventory, MARKET_ROOT, ID} from '../src/codex-plugin.mjs';
import {sourceIdentity, checkUpdates, formatUpdateReport} from '../src/update-check.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT = '.gpt-with-taste/install-receipt.json';
const PROMPTS = new Map([['prompts/gpt-with-taste/main.zh-CN.md','prompts/main.zh-CN.md'],['prompts/gpt-with-taste/sub.zh-CN.md','prompts/sub.zh-CN.md']]);
const LEGACY_FILES = ['prompts/gpt-with-taste/main.md','prompts/gpt-with-taste/sub.md','gpt-with-taste/hooks/steer.mjs',...['user','sub','agent'].map(name=>`gpt-with-taste/prompts/${name}-steer.md`),...['user','sub','agent'].map(name=>`plugins/gpt-with-taste/prompts/${name}-steer.md`)];
const BUNDLE_PATHS = ['.agents/plugins/marketplace.json','plugins/gpt-with-taste/.codex-plugin/plugin.json','plugins/gpt-with-taste/hooks/steer.mjs','plugins/gpt-with-taste/hooks/local-tools.mjs','plugins/gpt-with-taste/hooks/hooks.json',...['user','sub','agent'].map(name=>`plugins/gpt-with-taste/prompts/${name}-steer.zh-CN.md`)];
const HELP = `GPT with Taste — Node.js 22+
  node scripts/install.mjs [--home ABSOLUTE_CODEX_HOME] [--hooks] [--dry-run]
  node scripts/install.mjs --check [--home ABSOLUTE_CODEX_HOME]
  node scripts/install.mjs --check-updates [--home ABSOLUTE_CODEX_HOME]
  node scripts/install.mjs --restore [--home ABSOLUTE_CODEX_HOME] [--dry-run]
  --codex EXECUTABLE  Codex CLI for optional plugin install/check/restore (default: codex).
  --replace-managed  Explicitly replace conflicting managed files.
  --skip-update-check  Install offline without the pre-install update check.
Install checks public official GitHub metadata (5-second total network deadline).
--check verifies installation integrity; --check, --restore and --help stay offline.
--check-updates is read-only; it never fetches/pulls Git or installs an update.
Default home: CODEX_HOME, otherwise ~/.codex. Default install: prompts only.
For --check-updates only, an unselected home uses this clone's saved receipt home.
--hooks installs the local marketplace/plugin; review its commands in Codex /hooks.
Recovery receipt: ${RECEIPT} in this clone. Keep it until you restore.
`;
function fail(message){throw new Error(message);}
function equal(a,b){return a===null?b===null:b!==null&&a.equals(b);}
function decode(bytes){return bytes===null?'':new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
function encode(bytes){return bytes===null?null:bytes.toString('base64');}
function unpack(value){return value===null?null:Buffer.from(value,'base64');}
function json(value){return Buffer.from(JSON.stringify(value,null,2)+'\n');}
async function read(file){
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())fail(`Not a regular file: ${file}`);return await fs.readFile(file);}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function write(file,bytes){
  if(bytes===null){await fs.unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});return;}
  await fs.mkdir(path.dirname(file),{recursive:true});const temp=`${file}.gpt-with-taste-${process.pid}.tmp`;
  try{await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});await fs.rename(temp,file);}
  finally{await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function cas(file,before,after){if(!equal(await read(file),before))fail(`Changed during operation; no overwrite: ${file}`);if(!equal(before,after))await write(file,after);}
function parse(args){
  const options={mode:'install',home:process.env.CODEX_HOME||path.join(os.homedir(),'.codex')};
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--home'||arg==='--codex'){if(!args[i+1]||args[i+1].startsWith('--'))fail(`${arg} requires a value`);options[arg.slice(2)]=args[++i];}
    else if(arg==='--help'||arg==='-h')options.help=true;
    else if(['--check','--restore','--check-updates'].includes(arg)){if(options.mode!=='install')fail('Choose only one of --check, --restore and --check-updates');options.mode=arg.slice(2);}
    else if(arg==='--skip-update-check')options.skipUpdateCheck=true;
    else if(arg==='--dry-run')options.dryRun=true;
    else if(arg==='--replace-managed')options.replace=true;
    else if(arg==='--hooks')options.hooks=true;
    else fail(`Unknown argument: ${arg}`);
  }
  if(!path.isAbsolute(options.home))fail('--home / CODEX_HOME must be an absolute directory');options.home=path.resolve(options.home);
  if(options.mode!=='install'&&(options.replace||options.hooks||options.skipUpdateCheck))fail('--hooks, --replace-managed and --skip-update-check are install options');return options;
}
async function loadReceipt(file,home,useSavedHome=false){
  const bytes=await read(file);if(bytes===null)return {bytes,receipt:null};let receipt;
  try{receipt=JSON.parse(decode(bytes));}catch{fail('Unreadable recovery receipt; keep it for manual recovery');}
  if(useSavedHome){
    if(typeof receipt.home!=='string'||!path.isAbsolute(receipt.home))fail('Receipt has no absolute Codex home; keep it for manual recovery');
    home=receipt.home;
  }
  const allowed=new Set([...PROMPTS.keys(),...LEGACY_FILES,...BUNDLE_PATHS.map(file=>`${MARKET_ROOT}/${file}`)]);
  if(receipt.version!==1||receipt.home!==home||!['applying','applied','restoring','restored'].includes(receipt.status)||!Array.isArray(receipt.files)||receipt.files.some(entry=>!allowed.has(entry.path))||new Set(receipt.files.map(entry=>entry.path)).size!==receipt.files.length||!receipt.config||typeof receipt.config.after!=='string'||!(receipt.config.before===null||typeof receipt.config.before==='string'))fail('Receipt belongs to another home or has an unsupported format; use its original clone and home');
  if(receipt.plugin&&(receipt.plugin.id!==ID||receipt.plugin.root!==path.join(home,MARKET_ROOT)))fail('Unsupported plugin receipt; keep it for recovery');
  return {bytes,receipt};
}
async function inspect(home,receipt,recovery=false){
  const configPath=path.join(home,'config.toml'),configBytes=await read(configPath),configText=decode(configBytes),line=keyLine(configText);
  if(!sameInstructionLine(line,receipt.config.after)&&!(recovery&&(sameInstructionLine(line,receipt.config.before)||sameInstructionLine(line,receipt.config.previous))))fail('Managed config key has drifted: model_instructions_file. Keep the receipt and reconcile this key before retrying.');
  const files=[];
  for(const entry of receipt.files){
    const file=path.join(home,entry.path),bytes=await read(file);
    if(!equal(bytes,unpack(entry.after))&&!(recovery&&(equal(bytes,unpack(entry.before))||(Object.hasOwn(entry,'previous')&&equal(bytes,unpack(entry.previous))))))fail(`Managed file has drifted; no overwrite: ${file}`);
    files.push({file,bytes,entry});
  }
  let hooks;const groups=receiptHooks(receipt);
  if(groups.length){const file=path.join(home,'hooks.json'),bytes=await read(file),value=parseHooks(bytes===null?null:decode(bytes));for(const group of groups)assertHook(value,group,recovery);hooks={file,bytes,value,groups};}
  return {configPath,configBytes,configText,line,files,hooks};
}
async function inspectPlugin(api,plugin,home,recovery=false){
  const state=await api.inventory();assertPluginInventory(state,plugin.root,!recovery);
  if(plugin.cacheRoot&&state.plugin){
    const relative=path.relative(path.join(home,'plugins','cache'),plugin.cacheRoot);
    if(relative.startsWith('..')||path.isAbsolute(relative))fail('Plugin cache is outside selected home');
    for(const entry of plugin.cacheFiles??[]){
      const bytes=await read(path.join(plugin.cacheRoot,entry.path));
      if(!equal(bytes,unpack(entry.after))&&!(recovery&&(bytes===null||(Object.hasOwn(entry,'previous')&&equal(bytes,unpack(entry.previous))))))fail(`Installed plugin file has drifted: ${entry.path}`);
    }
  }
  return state;
}
function restoredHooks(current,active){
  if(!current.hooks)return undefined;
  for(const group of current.hooks.groups)restoreHook(current.hooks.value,group);
  const state=active.hookState??active.hook;
  if(!state.hadHooks&&current.hooks.value.hooks&&Object.keys(current.hooks.value.hooks).length===0)delete current.hooks.value.hooks;
  return state.fileWasAbsent&&Object.keys(current.hooks.value).length===0?null:json(current.hooks.value);
}
async function updateReport(options,active,checkout,services){
  const sources={Checkout:checkout},hooks=Boolean(active?.plugin||receiptHooks(active).length);
  let integrity;
  if(active){
    sources['Installed prompts']=active.source?.prompts;
    if(hooks)sources['Installed Hooks']=active.source?.hooks;
    try{
      if(active.status!=='applied')fail('interrupted operation; run --restore with this home');
      await inspect(options.home,active);
      if(active.plugin?.cacheRoot){
        for(const entry of active.plugin.cacheFiles??[]){
          if(!equal(await read(path.join(active.plugin.cacheRoot,entry.path)),unpack(entry.after)))fail(`plugin cache differs: ${entry.path}`);
        }
      }
      integrity='managed bytes match the receipt; use --check for Codex plugin registration';
    }catch(error){
      integrity=error.message;
      for(const label of Object.keys(sources).filter(label=>label!=='Checkout'))sources[label]=sources[label]?{...sources[label],dirty:true}:undefined;
    }
  }
  const report=await (services.checkUpdates??checkUpdates)(sources);
  console.log(formatUpdateReport(report,{sources,home:options.home,hooks,installation:active?.status??'no active receipt in this clone',integrity}));
  return report;
}
export async function run(args=process.argv.slice(2),root=ROOT,services={}){
  if(Number(process.versions.node.split('.')[0])<22)fail('Node.js 22 or newer is required');
  const options=parse(args);if(options.help){console.log(HELP);return;}
  const useSavedHome=options.mode==='check-updates'&&!args.includes('--home')&&!process.env.CODEX_HOME;
  const receiptPath=path.join(root,RECEIPT),saved=await loadReceipt(receiptPath,options.home,useSavedHome),active=saved.receipt&&saved.receipt.status!=='restored'?saved.receipt:null;
  if(useSavedHome&&saved.receipt)options.home=saved.receipt.home;
  const api=services.plugin??codexPlugin(options.home,options.codex??active?.plugin?.executable??'codex');
  if(options.mode==='check'){
    if(!active)fail('No active installation receipt in this clone');if(active.status!=='applied')fail('Installation was interrupted; run --restore');
    await inspect(options.home,active);if(active.plugin)await inspectPlugin(api,active.plugin,options.home);
    console.log(`Checked ${active.plugin?'prompt + plugin':receiptHooks(active).length?'legacy prompt + hooks':'prompt-only'} installation: ${options.home}`);return;
  }
  if(options.mode==='restore'){
    if(!active)fail('No active installation receipt in this clone');const recovery=active.status!=='applied',current=await inspect(options.home,active,recovery);
    const state=active.plugin?await inspectPlugin(api,active.plugin,options.home,recovery):null;
    const hooksAfter=restoredHooks(current,active);
    if(options.dryRun){console.log(`Would restore managed files, model_instructions_file${active.plugin?', plugin and marketplace':''}${current.hooks?' and legacy hook baseline':''}: ${options.home}`);return;}
    const pending=json({...active,status:'restoring'});await cas(receiptPath,saved.bytes,pending);
    if(state?.plugin)await api.remove();if(state?.market)await api.removeMarket();
    // Codex manages its registry through the CLI. Re-read config after its commands.
    const latest=await read(current.configPath),text=decode(latest),line=keyLine(text);
    if(!sameInstructionLine(line,current.line))fail('Managed config key changed during Codex removal; recovery receipt retained');
    const restored=sameInstructionLine(line,active.config.before)?text:restoreInstructions(text,active.config.before);
    await cas(current.configPath,latest,active.config.fileWasAbsent&&restored.trim()===''?null:Buffer.from(restored));
    for(const item of current.files)await cas(item.file,item.bytes,unpack(item.entry.before));
    if(current.hooks)await cas(current.hooks.file,current.hooks.bytes,hooksAfter);
    await cas(receiptPath,pending,json({...active,status:'restored'}));console.log(`Restored managed installation: ${options.home}`);return;
  }
  const checkout=await (services.sourceIdentity??sourceIdentity)(root);
  if(options.mode==='check-updates')return updateReport(options,active,checkout,services);
  if(active&&active.status!=='applied')fail('Previous operation was interrupted; run --restore before installing again');
  if(options.skipUpdateCheck)console.log('Update check skipped (--skip-update-check); installing selected local source.');
  else await updateReport(options,active,checkout,services);
  if(active)await inspect(options.home,options.hooks?active:{...active,files:active.files.filter(entry=>PROMPTS.has(entry.path)),hook:undefined,hookGroups:undefined});
  const configPath=path.join(options.home,'config.toml'),configBefore=await read(configPath),configText=decode(configBefore);
  if(active&&!sameInstructionLine(keyLine(configText),active.config.after))fail('Managed config key changed during planning; no overwrite');
  const configAfter=Buffer.from(setInstructions(configText,path.join(options.home,[...PROMPTS.keys()][0])));
  const targets=new Map();for(const [target,source]of PROMPTS){const bytes=await read(path.join(root,source));if(!bytes?.length)fail(`Missing or empty bundled source: ${source}`);targets.set(target,bytes);}
  let plugin=active?.plugin,hooks;
  if(options.hooks){
    if(plugin)await inspectPlugin(api,plugin,options.home);
    else {const state=await api.inventory();if(state.market||state.plugin)fail(`Existing ${ID} marketplace/plugin is not owned by this receipt; no changes made. Use its original installer or remove it explicitly first.`);}
    for(const [target,bytes]of await pluginBundle(root))targets.set(target,bytes);
    plugin={...plugin,id:ID,root:path.join(options.home,MARKET_ROOT),executable:options.codex??plugin?.executable??'codex'};
    const original=receiptHooks(active);
    if(original.length){
      const file=path.join(options.home,'hooks.json'),before=await read(file),value=parseHooks(before===null?null:decode(before));
      const records=original.map(record=>retireHook(value,record));
      const changed=records.some(record=>record.previous!==null);
      const state=active.hookState??{fileWasAbsent:active.hook.fileWasAbsent,hadHooks:active.hook.hadHooks};
      hooks={file,before,after:changed?json(value):before,records,state};
    }
  }
  const files=[];
  for(const [target,after]of targets){
    const file=path.join(options.home,target),before=await read(file),prior=active?.files.find(entry=>entry.path===target);
    if(prior&&!equal(before,unpack(prior.after)))fail(`Managed file changed during planning; no overwrite: ${file}`);
    if(!prior&&before!==null&&!equal(before,after)&&!options.replace)fail(`Unknown managed target already exists: ${file}. Review it, then use --replace-managed to preserve and replace it.`);
    files.push({path:target,file,before,after});
  }
  if(options.dryRun){console.log(`Would install ${options.hooks?'prompt + marketplace/plugin':'prompt-only'}: ${options.home}\nManaged config key: model_instructions_file\nManaged files: ${[...targets.keys()].join(', ')}`);return;}
  if(active&&(!options.hooks||active.plugin)&&equal(configBefore,configAfter)&&files.every(item=>equal(item.before,item.after))&&(!hooks||equal(hooks.before,hooks.after))){console.log(`Already installed; original recovery receipt retained: ${options.home}`);return;}
  if(options.hooks && plugin.cacheRoot){
    const prefix=`${MARKET_ROOT}/plugins/gpt-with-taste/`;
    plugin={...plugin,cacheFiles:files.filter(item=>item.path.startsWith(prefix)).map(item=>{
      const target=item.path.slice(prefix.length);
      return {path:target,after:encode(item.after),previous:active.plugin.cacheFiles.find(entry=>entry.path===target)?.after??null};
    })};
  }
  const receipt={version:1,status:'applying',home:options.home,
    ...(active?.source?{source:active.source}:{}),
    config:{before:active?active.config.before:keyLine(configText),after:keyLine(decode(configAfter)),previous:keyLine(configText),fileWasAbsent:active?active.config.fileWasAbsent:configBefore===null},
    files:[...(active?.files.filter(entry=>!targets.has(entry.path))??[]),...files.map(item=>{const prior=active?.files.find(entry=>entry.path===item.path);return {path:item.path,before:prior?prior.before:encode(item.before),after:encode(item.after),previous:encode(item.before)};})],
    ...(plugin?{plugin}:{}),...(hooks?{hookGroups:hooks.records,hookState:hooks.state}:active?.hookGroups?{hookGroups:active.hookGroups,hookState:active.hookState}:active?.hook?{hook:active.hook}:{})};
  let pending=json(receipt);await cas(receiptPath,saved.bytes,pending);
  try{
    for(const item of files)await cas(item.file,item.before,item.after);await cas(configPath,configBefore,configAfter);
    // Retire only receipt-owned exact-command groups before enabling the plugin.
    if(hooks)await cas(hooks.file,hooks.before,hooks.after);
    if(options.hooks){
      const result=await api.install(plugin.root);receipt.plugin={...plugin,cacheRoot:result.installedPath,cacheFiles:[]};
      const relative=path.relative(path.join(options.home,'plugins','cache'),result.installedPath);if(relative.startsWith('..')||path.isAbsolute(relative))fail('Codex returned a plugin cache outside selected home');
      const prefix=`${MARKET_ROOT}/plugins/gpt-with-taste/`;
      for(const item of files.filter(item=>item.path.startsWith(prefix))){const target=item.path.slice(prefix.length),bytes=await read(path.join(result.installedPath,target));if(!equal(bytes,item.after))fail(`Codex installed different plugin bytes: ${target}`);receipt.plugin.cacheFiles.push({path:target,after:encode(bytes)});}
      if(!sameInstructionLine(keyLine(decode(await read(configPath))),receipt.config.after))fail('Managed config key changed during Codex installation');
    }
    // Attribute only verified installed bytes, never an in-flight update or untouched Hooks.
    for(const item of files)if(!equal(await read(item.file),item.after))fail(`Installed file changed: ${item.file}`);
    if(!sameInstructionLine(keyLine(decode(await read(configPath))),receipt.config.after))fail('Managed config key changed during installation');
    const source={...active?.source,prompts:checkout,...(options.hooks?{hooks:checkout}:{})};
    const applied={...receipt,status:'applied',source,config:{...receipt.config},files:receipt.files.map(item=>({...item}))};delete applied.config.previous;for(const item of applied.files)delete item.previous;
    if(applied.hookGroups)applied.hookGroups=applied.hookGroups.map(({previous,...record})=>record);
    await cas(receiptPath,pending,json(applied));
  }catch(error){throw new Error(`${error.message}\nRecovery receipt retained. Run --restore with the same --home.`);}
  console.log(`Installed ${options.hooks?'prompt + plugin':'prompt-only'}: ${options.home}\nOpen a new Codex session.${options.hooks?' Review and trust the plugin commands in Codex /hooks.':''}\nRecovery: node scripts/install.mjs --restore --home ${JSON.stringify(options.home)}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)run().catch(error=>{console.error(`GPT with Taste: ${error.message}`);process.exitCode=1;});
