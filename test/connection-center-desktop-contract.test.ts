import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('desktop installs both provider-owned account bridge and Company-aware Connection Center bridge', () => {
  const main = source('desktop/main.mjs');
  assert.match(main, /import \{ installClaudeAccountBridge \} from '\.\/claude-accounts\.mjs'/);
  assert.match(main, /import \{ installConnectionCenterBridge \} from '\.\/connection-center\.mjs'/);
  assert.match(main, /installClaudeAccountBridge\(\);/);
  assert.match(main, /installConnectionCenterBridge\(\);/);
});

test('Connection Center uses dedicated ownership-sensitive and API lifecycle channels', () => {
  const bridge = source('desktop/connection-center.mjs');
  const preload = source('desktop/preload.cjs');
  const channels = [
    'local-coder:connection-center-connections',
    'local-coder:connection-center-claude-create',
    'local-coder:connection-center-codex-create',
    'local-coder:connection-center-api-create',
    'local-coder:connection-center-api-details',
    'local-coder:connection-center-api-update',
    'local-coder:connection-center-api-rotate',
    'local-coder:connection-center-api-enabled',
    'local-coder:connection-center-api-test',
    'local-coder:connection-center-api-remove'
  ];
  for (const channel of channels) {
    const escaped = new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.match(bridge, escaped);
    assert.match(preload, escaped);
  }

  assert.doesNotMatch(bridge, /ipcMain\.handle\('local-coder:(?:connections|claude-account-create|codex-account-create|api-connection-create)'/);
  assert.doesNotMatch(bridge, /claude-account-login|codex-account-login|account-status|account-mcp-login/);
  assert.match(bridge, /canonicalConnectionViews/);
  assert.match(bridge, /ownership\.bind/);
  assert.match(bridge, /addOrReplaceKeychainCredential/);
  assert.match(bridge, /ApiKeyConnectionLifecycle/);
  assert.match(bridge, /apiLifecycle\.details/);
  assert.match(bridge, /apiLifecycle\.edit/);
  assert.match(bridge, /apiLifecycle\.rotate/);
  assert.match(bridge, /apiLifecycle\.setEnabled/);
  assert.match(bridge, /apiLifecycle\.test/);
  assert.match(bridge, /apiLifecycle\.remove/);
  assert.match(bridge, /Provider must be openai or anthropic/);
});
