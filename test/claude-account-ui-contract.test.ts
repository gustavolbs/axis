import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function source(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('desktop installs the Claude account bridge', () => {
  const main = source('desktop/main.mjs');
  assert.match(main, /installClaudeAccountBridge/);
  assert.match(main, /\.\/claude-accounts\.mjs/);
});

test('preload exposes only bounded Claude account management actions', () => {
  const preload = source('desktop/preload.cjs');
  for (const method of [
    'claudeDiscover',
    'claudeAccounts',
    'createClaudeAccount',
    'claudeAccountStatus',
    'loginClaudeAccount',
    'listClaudeAccountMcps'
  ]) assert.match(preload, new RegExp(`\\b${method}\\b`));

  assert.doesNotMatch(preload, /setup-token|oauthToken|credentials\.json|Keychain/i);
  assert.doesNotMatch(preload, /invokeClaudeAccount|claudeAccountInvoke/);
});

test('Settings exposes a first-class Claude accounts page', () => {
  const settings = source('app/src/SettingsModal.tsx');
  const accounts = source('app/src/ClaudeAccountsSettings.tsx');
  assert.match(settings, /ClaudeAccountsSettings/);
  assert.match(settings, />Claude accounts</);
  assert.match(accounts, /Sign in with SSO/);
  assert.match(accounts, /MCP connections/);
  assert.match(accounts, /never read or copied by Local Coder/);
});

test('desktop Claude account IPC delegates authentication to the official runtime abstraction', () => {
  const bridge = source('desktop/claude-accounts.mjs');
  assert.match(bridge, /ClaudeAccountProfileStore/);
  assert.match(bridge, /ClaudeAccountRuntime/);
  assert.match(bridge, /runtime\.login/);
  assert.match(bridge, /runtime\.status/);
  assert.match(bridge, /runtime\.listMcp/);
  assert.doesNotMatch(bridge, /spawn\(|exec\(|setup-token|cookie|credentials\.json/i);
});
