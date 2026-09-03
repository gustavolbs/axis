import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Settings exposes a dedicated Companies surface using existing settings patterns', () => {
  const modal = fs.readFileSync('app/src/SettingsModal.tsx', 'utf8');
  const surface = fs.readFileSync('app/src/CompaniesSettings.tsx', 'utf8');
  assert.match(modal, /<span>Companies<\/span>/);
  assert.match(modal, /<CompaniesSettings \/>/);
  assert.match(surface, /connections-settings-page/);
  assert.match(surface, /connections-surface-tabs/);
  assert.match(surface, /connector-search/);
  assert.match(surface, /nested-settings-dialog connection-create-dialog/);
});

test('Companies surface supports create, edit, search, archive, restore and explicit ordering', () => {
  const source = fs.readFileSync('app/src/CompaniesSettings.tsx', 'utf8');
  assert.match(source, /Add company/);
  assert.match(source, /Edit company/);
  assert.match(source, /Search companies/);
  assert.match(source, /setArchived\(company, true\)/);
  assert.match(source, /setArchived\(company, false\)/);
  assert.match(source, /\/api\/companies\/order/);
  assert.match(source, /Move .* up/);
  assert.match(source, /Move .* down/);
});

test('Companies surface exposes name, description, color and icon but no destructive delete action', () => {
  const source = fs.readFileSync('app/src/CompaniesSettings.tsx', 'utf8');
  assert.match(source, /<span>Name<\/span>/);
  assert.match(source, /Description/);
  assert.match(source, /type="color"/);
  assert.match(source, /Company icon/);
  assert.doesNotMatch(source, /Delete company/);
  assert.doesNotMatch(source, /method: 'DELETE'/);
});
