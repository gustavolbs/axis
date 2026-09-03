import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Project surface presents Company as identity and workspace only as a folder', () => {
  const source = fs.readFileSync('app/src/ProjectGallery.tsx', 'utf8');
  assert.match(source, /<span>Company<\/span><UiSelect/);
  assert.match(source, /Project company/);
  assert.match(source, /folder never changes that ownership/);
  assert.match(source, /project\.companyName \?\? project\.companyId/);
  assert.doesNotMatch(source, /Company identifier/);
  assert.doesNotMatch(source, /name="companyId"/);
  assert.doesNotMatch(source, /Organization boundary/);
});

test('Project surface selects an existing canonical Company instead of inventing an id from a label', () => {
  const source = fs.readFileSync('app/src/ProjectGallery.tsx', 'utf8');
  assert.match(source, /await api\('\/api\/companies\/context'\)/);
  assert.match(source, /\/api\/companies\?archived=all/);
  assert.match(source, /const selectedCompany = companies\.find\(\(company\) => company\.id === companyId\)/);
  assert.match(source, /Choose an existing active company for this Project/);
  assert.match(source, /Archived companies cannot receive new Projects/);
  assert.match(source, /organizationId: companyId/);
  assert.match(source, /organizationName: companyName/);
  assert.doesNotMatch(source, /function slug\(/);
});

test('Project surface bridges existing legacy storage without exposing it as the product model', () => {
  const source = fs.readFileSync('app/src/ProjectGallery.tsx', 'utf8');
  assert.match(source, /const companyFields = \{[\s\S]*companyId,[\s\S]*companyName,[\s\S]*organizationId: companyId,[\s\S]*organizationName: companyName/);
  assert.match(source, /companyId = project\.companyId \|\| project\.organizationId \|\| 'personal'/);
  assert.match(source, /companyName: project\.companyName \?\? project\.organizationName/);
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
