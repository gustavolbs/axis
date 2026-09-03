import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (file: string) => fs.readFileSync(file, 'utf8');

test('Connection Center exposes API Key lifecycle from the canonical connection inventory', () => {
  const center = read('app/src/ConnectionCenterSettings.tsx');
  assert.match(center, /ApiKeyConnectionDialog/);
  assert.match(center, /connection\.auth === 'api-key'/);
  assert.match(center, />Manage<\/button>/);
  assert.doesNotMatch(center, /window\.confirm|window\.prompt/);
});

test('API Key management never renders an existing secret and supports the complete lifecycle', () => {
  const dialog = read('app/src/ApiKeyConnectionDialog.tsx');
  const typedBridge = read('app/src/ConnectionCenterBridge.ts');

  assert.match(dialog, /apiKeyConnectionDetails/);
  assert.match(dialog, /updateApiKeyConnection/);
  assert.match(dialog, /testApiKeyConnection/);
  assert.match(dialog, /rotateApiKeyConnection/);
  assert.match(dialog, /setApiKeyConnectionEnabled/);
  assert.match(dialog, /removeApiKeyConnection/);
  assert.match(dialog, /Replacement API key/);
  assert.match(dialog, /allowedHeaders\.map/);
  assert.match(dialog, /Company/);
  assert.match(dialog, /readOnly/);
  assert.match(dialog, /ShellDialog/);
  assert.doesNotMatch(dialog, /details\.secret|existingSecret|currentSecret/);

  assert.match(typedBridge, /ApiKeyConnectionDetailsView/);
  assert.match(typedBridge, /allowedHeaders: string\[\]/);
  assert.match(typedBridge, /headers: Record<string, string>/);
  assert.match(typedBridge, /enabled: boolean/);
  assert.match(typedBridge, /testApiKeyConnection/);
  assert.match(typedBridge, /removeApiKeyConnection/);
});
