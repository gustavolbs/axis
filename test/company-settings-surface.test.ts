import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Contexts are first-class navigation boundaries rather than a global Settings tab', () => {
  const root = fs.readFileSync('app/src/AppRoot.tsx', 'utf8');
  const modal = fs.readFileSync('app/src/SettingsModal.tsx', 'utf8');
  const hub = fs.readFileSync('app/src/CompanyHub.tsx', 'utf8');

  assert.match(root, /activeCompanies\.map/);
  assert.match(root, /data-company-id=\{company\.id\}/);
  assert.match(root, /<span>Contexts<\/span>/);
  assert.match(root, /<CompanyHub/);
  assert.match(root, /<CompaniesSettings \/>/);
  assert.doesNotMatch(modal, /<span>Companies<\/span>/);
  assert.doesNotMatch(modal, /<ConnectionsSettings/);
  assert.doesNotMatch(modal, /<ApiKeySettings/);
  assert.match(hub, /Company Hub/);
});

test('Company Hub exposes scoped Overview, Projects, Connections, MCPs, Skills and Settings', () => {
  const source = fs.readFileSync('app/src/CompanyHub.tsx', 'utf8');
  for (const label of ['Overview', 'Projects', 'Connections', 'MCPs', 'Skills', 'Settings']) {
    assert.match(source, new RegExp(`>${label}<`));
  }
  assert.match(source, /project\.companyId \|\| project\.organizationId \|\| 'personal'/);
  assert.match(source, /connection\.companyId === company\.id/);
  assert.match(source, /ConnectionCenterSettings companyId=\{company\.id\}/);
  assert.match(source, /Open in Work Hub/);
});

test('Company-scoped Connection Center locks creation and inventory to the selected Company', () => {
  const source = fs.readFileSync('app/src/ConnectionCenterSettings.tsx', 'utf8');
  assert.match(source, /fixedCompanyId/);
  assert.match(source, /connection\.companyId !== fixedCompanyId/);
  assert.match(source, /Company-scoped Connection Center cannot create a connection for another Company/);
  assert.match(source, /Ownership is fixed by the current Company Hub/);
});

test('Context management supports create edit search archive restore reorder and safe delete', () => {
  const source = fs.readFileSync('app/src/CompaniesSettings.tsx', 'utf8');
  assert.match(source, /<h1>Contexts<\/h1>/);
  assert.match(source, /Add context/);
  assert.match(source, /Edit context/);
  assert.match(source, /Search contexts/);
  assert.match(source, /setArchived\(company, true\)/);
  assert.match(source, /setArchived\(company, false\)/);
  assert.match(source, /\/api\/companies\/order/);
  assert.match(source, /Delete context/);
  assert.match(source, /method: 'DELETE'/);
});
