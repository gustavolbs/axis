import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Project surface presents the active Company as identity and workspace only as a folder', () => {
  const source = fs.readFileSync('app/src/ProjectGallery.tsx', 'utf8');
  assert.match(source, /interface ActiveCompanyScope/);
  assert.match(source, /activeCompany \? <p className="page-subtitle">\{activeCompany\.company\.name\}<\/p>/);
  assert.match(source, /<span>Context<\/span><strong>\{activeCompany\.company\.name\}<\/strong>/);
  assert.match(source, /<FolderField value=\{workspace\}/);
  assert.match(source, /project\.companyName \?\? project\.organizationName/);
  assert.doesNotMatch(source, /<UiSelect/);
  assert.doesNotMatch(source, /name="companyId"/);
  assert.doesNotMatch(source, /Organization boundary/);
});

test('Project surface binds creation to the existing active canonical Company', () => {
  const source = fs.readFileSync('app/src/ProjectGallery.tsx', 'utf8');
  assert.match(source, /await api\('\/api\/companies\/context'\)/);
  assert.match(source, /\/api\/companies\/active/);
  assert.match(source, /if \(!activeCompany\)/);
  assert.match(source, /companyId: activeCompany\.activeCompanyId/);
  assert.match(source, /companyName: activeCompany\.company\.name/);
  assert.match(source, /organizationId: activeCompany\.activeCompanyId/);
  assert.match(source, /organizationName: activeCompany\.company\.name/);
  assert.doesNotMatch(source, /function slug\(/);
  assert.doesNotMatch(source, /\/api\/companies\?archived=all/);
});

test('Project surface bridges legacy ownership fields without exposing them as selectors', () => {
  const source = fs.readFileSync('app/src/ProjectGallery.tsx', 'utf8');
  assert.match(source, /const companyId = project\.companyId \|\| project\.organizationId \|\| 'personal'/);
  assert.match(source, /companyName: project\.companyName \?\? project\.organizationName/);
  assert.match(source, /const companyFields = \{[\s\S]*companyId: activeCompany\.activeCompanyId,[\s\S]*companyName: activeCompany\.company\.name,[\s\S]*organizationId: activeCompany\.activeCompanyId,[\s\S]*organizationName: activeCompany\.company\.name/);
  assert.doesNotMatch(source, /name="organizationId"/);
});

test('Project connection surface uses Company ownership while legacy runtime metadata remains an adapter concern', () => {
  const source = fs.readFileSync('app/src/ProjectConnectionsPanel.tsx', 'utf8');
  assert.match(source, /This Project belongs to/);
  assert.match(source, /Connections owned by another Company/);
  assert.match(source, /connection\.companyId === scopedProject\.companyId/);
  assert.match(source, /connection\.auth === 'local' \? 'Shared local'/);
  assert.match(source, /connection\?\.companyId === scopedProject\.companyId/);
  assert.doesNotMatch(source, /isolated to <strong>\{project\.organizationName/);
  assert.doesNotMatch(source, /another organization/);
});

test('renderer contracts mark organization fields as deprecated migration metadata', () => {
  const source = fs.readFileSync('app/src/app-types.ts', 'utf8');
  assert.match(source, /companyId: string/);
  assert.match(source, /companyName\?: string/);
  assert.match(source, /@deprecated Legacy storage\/migration alias; UI must use companyId\/companyName/);
  assert.match(source, /Canonical Axis ownership/);
  assert.match(source, /@deprecated Provider\/runtime migration metadata; product isolation uses companyId/);
});
