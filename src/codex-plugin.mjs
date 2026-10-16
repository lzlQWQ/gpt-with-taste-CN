import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROUTES, hookGroup} from './hooks-overlay.mjs';

export const MARKET = 'gpt-with-taste-local';
export const PLUGIN = 'gpt-with-taste';
export const ID = `${PLUGIN}@${MARKET}`;
export const MARKET_ROOT = 'gpt-with-taste/marketplace';

export async function pluginBundle(root) {
  const files = new Map();
  const sources = [
    ['.agents/plugins/marketplace.json', 'plugin/marketplace.json'],
    ['plugins/gpt-with-taste/.codex-plugin/plugin.json', 'plugin/plugin.json'],
    ['plugins/gpt-with-taste/hooks/steer.mjs', 'hooks/steer.mjs'],
    ['plugins/gpt-with-taste/hooks/local-tools.mjs', 'hooks/local-tools.mjs'],
    ...['user', 'sub', 'agent'].map(name => [
      `plugins/gpt-with-taste/prompts/${name}-steer.zh-CN.md`, `prompts/${name}-steer.zh-CN.md`,
    ]),
  ];
  for (const [target, source] of sources) {
    const bytes = await fs.readFile(path.join(root, source));
    if (!bytes.length) throw new Error(`Empty bundled source: ${source}`);
    files.set(`${MARKET_ROOT}/${target}`, bytes);
  }
  const node = process.execPath.replaceAll('\\', '/');
  // PowerShell invokes a quoted executable with &, and passes the official
  // plugin-root environment value as data rather than interpolated shell text.
  const invocation = process.platform === 'win32'
    ? `if (!$env:PLUGIN_ROOT) { [Console]::Error.WriteLine('GPT with Taste Hook [LAUNCH_FAILURE]: PLUGIN_ROOT is missing'); exit 1 }; & '${node.replaceAll("'", "''")}' (Join-Path $env:PLUGIN_ROOT 'hooks/steer.mjs')`
    : `'${node.replaceAll("'", "'\\''")}' "\${PLUGIN_ROOT}/hooks/steer.mjs"`;
  const fallbackRoute = {UserPromptSubmit: 'user', SubagentStart: 'sub', PostToolUse: 'agent'};
  const hooks = Object.fromEntries(ROUTES.map(route => {
    const command = `${invocation} --route ${fallbackRoute[route.event]}`;
    return [route.event, [hookGroup(command, route.matcher)]];
  }));
  files.set(`${MARKET_ROOT}/plugins/${PLUGIN}/hooks/hooks.json`,
    Buffer.from(JSON.stringify({hooks}, null, 2) + '\n'));
  return files;
}

export function codexPlugin(home, executable = 'codex') {
  async function cli(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['--no-daemon', 'plugin', ...args, '--json'], {
        cwd: process.cwd(),
        env: {...process.env, CODEX_HOME: home},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', value => out += value);
      child.stderr.on('data', value => err += value);
      child.on('error', error => reject(new Error(
        `Cannot run Codex plugin CLI (${executable}): ${error.message}. Use --codex with its executable path.`,
      )));
      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(`Codex plugin ${args.join(' ')} failed (${code}): ${err.trim() || out.trim()}`));
          return;
        }
        try { resolve(JSON.parse(out)); }
        catch { reject(new Error('Codex plugin CLI did not return JSON')); }
      });
    });
  }
  return {
    async inventory() {
      const markets = await cli(['marketplace', 'list']);
      const market = markets.marketplaces.find(item => item.name === MARKET) ?? null;
      const plugins = market ? await cli(['list', '--marketplace', MARKET]) : {installed: []};
      return {market, plugin: plugins.installed.find(item => item.pluginId === ID) ?? null};
    },
    async install(root) {
      await cli(['marketplace', 'add', root]);
      return cli(['add', ID]);
    },
    async remove() { await cli(['remove', ID]); },
    async removeMarket() { await cli(['marketplace', 'remove', MARKET]); },
  };
}

export function assertPluginInventory(state, root, required = true) {
  if (state.market && path.resolve(state.market.root) !== path.resolve(root)) {
    throw new Error(`Marketplace ${MARKET} points elsewhere; no changes made`);
  }
  if (required && (!state.market || !state.plugin?.installed || !state.plugin.enabled)) {
    throw new Error('Managed plugin is missing or disabled; reconcile it before retrying');
  }
}
