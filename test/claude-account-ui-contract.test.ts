import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function source(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('desktop installs the bounded provider account bridge', () => {
  const main = source('desktop/main.mjs');
  assert.match(main, /installClaudeAccountBridge/);
  assert.match(main, /\.\/claude-accounts\.mjs/);
});

test('preload exposes bounded connection and Work Hub actions without generic account execution', () => {
  const preload = source('desktop/preload.cjs');
  for (const method of [
    'claudeDiscover', 'claudeAccounts', 'createClaudeAccount', 'claudeAccountStatus', 'loginClaudeAccount', 'listClaudeAccountMcps',
    'codexDiscover', 'codexAccounts', 'createCodexAccount', 'codexAccountStatus', 'loginCodexAccount', 'listCodexAccountMcps',
    'providerConnections', 'workHubSnapshot', 'upsertWorkHubSource', 'removeWorkHubSource', 'refreshWorkHub'
  ]) assert.match(preload, new RegExp(`\\b${method}\\b`));

  assert.doesNotMatch(preload, /setup-token|oauthToken|credentials\.json|Keychain/i);
  assert.doesNotMatch(preload, /invokeClaudeAccount|claudeAccountInvoke|invokeCodexAccount|codexAccountInvoke|spawn\(|exec\(/);
});

test('Settings exposes a first-class provider Connections page', () => {
  const settings = source('app/src/SettingsModal.tsx');
  const connections = source('app/src/ConnectionsSettings.tsx');
  assert.match(settings, /ConnectionsSettings/);
  assert.match(settings, />Connections</);
  assert.match(connections, /Enterprise SSO/);
  assert.match(connections, /Device login/);
  assert.match(connections, /MCP \/ connector sources/);
  assert.match(connections, /distinct identity/);
});

test('desktop account IPC delegates auth and MCP discovery to official runtime abstractions', () => {
  const bridge = source('desktop/claude-accounts.mjs');
  assert.match(bridge, /ClaudeAccountProfileStore/);
  assert.match(bridge, /ClaudeAccountRuntime/);
  assert.match(bridge, /CodexAccountProfileStore/);
  assert.match(bridge, /CodexAccountRuntime/);
  assert.match(bridge, /\.login\(/);
  assert.match(bridge, /\.status\(/);
  assert.match(bridge, /\.listMcp\(/);
  assert.doesNotMatch(bridge, /spawn\(|exec\(|setup-token|cookie|credentials\.json/i);
});

test('Work Hub is mounted globally and does not expose cross-account prompts', () => {
  const main = source('app/src/main.tsx');
  const hub = source('app/src/GlobalWorkHubLauncher.tsx');
  const runtime = source('src/work-hub.ts');
  assert.match(main, /GlobalWorkHubLauncher/);
  assert.match(hub, /Calendar/);
  assert.match(hub, /My work/);
  assert.match(hub, /Inbox/);
  assert.match(hub, /Exact read-only MCP tools/);
  assert.match(runtime, /read-only Local Coder Work Hub collector/);
  assert.match(runtime, /Never write, update, delete, comment, send, acknowledge, transition/);
  assert.doesNotMatch(source('desktop/preload.cjs'), /workHubPrompt|runWorkHubPrompt/);
});
