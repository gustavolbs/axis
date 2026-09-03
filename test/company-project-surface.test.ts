import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Project surface presents Company as identity and workspace only as a folder', () => {
  const source = fs.readFileSync('app/src/ProjectGallery.tsx', 'utf8');
  assert.match(source, /Company identifier/);
  assert.match(source, /Company name/);
  assert.match(source, /workspace is only a folder and never changes this Company/);
  assert.match(source, /project\.companyName \?\? project\.companyId/);
  assert.doesNotMatch(source, /Organization boundary/);
  assert.doesNotMatch(source, /<span>Organization name<\/span>/);
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
