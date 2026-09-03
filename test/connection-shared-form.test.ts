import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('app/src/ConnectionCenterSettings.tsx', 'utf8');

test('Connection Center uses one shared creation form for Account and API Key authentication', () => {
  assert.equal((source.match(/className="nested-settings-dialog connection-create-dialog"/g) ?? []).length, 1);
  assert.match(source, /<form className="nested-settings-dialog connection-create-dialog"/);
  assert.match(source, /<span>Authentication<\/span><UiSelect/);
  assert.match(source, /<span>Company<\/span><UiSelect/);
  assert.match(source, /<span>\{apiKind \? 'Credential ID' : 'Profile ID'\}<\/span>/);
  assert.match(source, /<span>Name<\/span><input required value=\{connectionName\}/);
});

test('shared base values feed every supported authentication path', () => {
  assert.match(source, /createClaudeAccount\(\{ id: connectionId\.trim\(\), name: connectionName\.trim\(\), companyId \}\)/);
  assert.match(source, /createCodexAccount\(\{ id: connectionId\.trim\(\), name: connectionName\.trim\(\), companyId \}\)/);
  assert.match(source, /createApiKeyConnection\(\{[\s\S]*id: connectionId\.trim\(\),[\s\S]*name: connectionName\.trim\(\),[\s\S]*companyId,/);
});

test('changing authentication clears only authentication-specific secret transport state', () => {
  const selectorChange = source.match(/onChange=\{\(value\) => \{ setNewKind\(value as NewConnectionKind\);([^}]*)\}\}/)?.[1] ?? '';
  assert.match(selectorChange, /setEndpoint\(''\)/);
  assert.match(selectorChange, /setSecret\(''\)/);
  assert.doesNotMatch(selectorChange, /setConnectionId/);
  assert.doesNotMatch(selectorChange, /setConnectionName/);
  assert.doesNotMatch(selectorChange, /setCompanyId/);
});

test('provider-specific fields are conditional while Account authentication stays provider-owned', () => {
  assert.match(source, /\{apiKind \? <label><span>Endpoint <small>optional<\/small><\/span>/);
  assert.match(source, /\{apiKind \? <label><span>API key<\/span>/);
  assert.match(source, /Authentication happens after creation in the provider-owned runtime/);
  assert.match(source, /Leave Endpoint empty to use the official provider API/);
});
