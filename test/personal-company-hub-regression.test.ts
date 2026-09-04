import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const appRoot = read('app/src/AppRoot.tsx');
const companyHub = read('app/src/CompanyHub.tsx');
const connectionCenter = read('app/src/ConnectionCenterSettings.tsx');
const companySources = read('app/src/CompanySourcesSettings.tsx');
const workHub = read('app/src/GlobalWorkHubLauncher.tsx');

test('primary context navigation consumes the canonical snapshot that contains Personal', () => {
  assert.match(appRoot, /api<\{ context: \{ companies: CompanyDefinition\[\] \} \}>\('\/api\/companies\/context'\)/);
  assert.match(appRoot, /setCompanies\(context\.companies\)/);
  assert.match(appRoot, /api<\{ scope: ActiveCompanyScope \}>\('\/api\/companies\/active'\)/);
  assert.match(appRoot, /activeCompanies\.map/);
  assert.match(appRoot, /company\.id === 'personal'/);
  assert.doesNotMatch(appRoot, /axis-company-scope/);
});

test('Personal Connections shows owned cloud identities plus shared local execution', () => {
  assert.match(connectionCenter, /connection\.companyId === companyId/);
  assert.match(connectionCenter, /companyId === 'personal' && connection\.auth === 'local'/);
  assert.match(connectionCenter, /Shared local execution/);
  assert.match(connectionCenter, /Ollama remains a shared local execution capability and is not assigned a fake Company/);
  assert.doesNotMatch(connectionCenter, /connection\.auth === 'local'.*companyId:\s*'personal'/s);
});

test('Company Hub embeds canonical settings surfaces instead of nesting standalone Settings chrome', () => {
  assert.match(companyHub, /<CompanyPageHeader title="Connections"/);
  assert.match(companyHub, /<ConnectionCenterSettings[^>]*embedded/);
  assert.match(connectionCenter, /embedded \? '' : 'focused-settings-page connections-settings-page '/);
  assert.doesNotMatch(companyHub, /className="nested-settings-dialog company-settings-form"/);
  assert.match(companyHub, /className="settings-form-section"/);
  assert.match(companyHub, /className="btn-primary"/);
});

test('Company project rows keep implementation-specific connection ids out of the primary scan path', () => {
  assert.match(companyHub, /project\.workspace \|\| 'Workspace not selected'/);
  assert.doesNotMatch(companyHub, /project\.defaultConnectionId/);
  assert.doesNotMatch(companyHub, /project\.connectionPolicy\?\.chat\.defaultConnectionId/);
});

test('global Work Hub scopes also consume the canonical snapshot so Personal is filterable', () => {
  assert.match(workHub, /api<\{ context: \{ companies: CompanyDefinition\[\] \} \}>\('\/api\/companies\/context'\)/);
  assert.match(workHub, /companyResponse\.context\.companies/);
  assert.doesNotMatch(workHub, /api<\{ companies: CompanyDefinition\[\] \}>\('\/api\/companies\?archived=all'\)/);
  assert.match(workHub, />All<\/button>/);
  assert.match(workHub, /data-company-id=\{company\.id\}/);
});

test('Work Hub source administration remains inside the owning Company surface', () => {
  assert.match(companyHub, /<CompanySourcesSettings companyId=\{company\.id\} companyName=\{company\.name\}/);
  assert.match(companySources, /source\.companyId === companyId/);
  assert.match(companySources, /connection\.companyId === companyId/);
  assert.match(companySources, /Source ownership stays here/);
});
