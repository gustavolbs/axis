import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('desktop installs Company-aware connection handlers after provider-owned account handlers', () => {
  const main = source('desktop/main.mjs');
  assert.match(main, /import \{ installClaudeAccountBridge \} from '\.\/claude-accounts\.mjs'/);
  assert.match(main, /import \{ installConnectionCenterBridge \} from '\.\/connection-center\.mjs'/);
  const accountInstall = main.indexOf('installClaudeAccountBridge();');
  const centerInstall = main.indexOf('installConnectionCenterBridge();');
  assert.ok(accountInstall >= 0 && centerInstall > accountInstall, 'Connection Center must override list/create handlers after the official account bridge installs.');
});

test('Connection Center overrides only ownership-sensitive channels', () => {
  const bridge = source('desktop/connection-center.mjs');
  for (const channel of [
    'local-coder:connections',
    'local-coder:claude-account-create',
    'local-coder:codex-account-create',
    'local-coder:api-connection-create'
  ]) assert.match(bridge, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.doesNotMatch(bridge, /claude-account-login|codex-account-login|account-status|account-mcp-login/);
  assert.match(bridge, /ownership\.bind/);
  assert.match(bridge, /addOrReplaceKeychainCredential/);
  assert.match(bridge, /Provider must be openai or anthropic/);
});
