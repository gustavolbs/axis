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
  assert.match(source, /companyId: companyId/);
  assert.match(source, /organizationId: companyId/);
  assert.match(source, /companyName/);
  assert.match(source, /organizationName: companyName/);
  assert.match(source, /companyId = project\.companyId \|\| project\.organizationId \|\| 'personal'/);
});

test('renderer project contract marks organization fields as deprecated migration aliases', () => {
  const source = fs.readFileSync('app/src/app-types.ts', 'utf8');
  assert.match(source, /companyId: string/);
  assert.match(source, /companyName\?: string/);
  assert.match(source, /@deprecated Legacy storage\/migration alias; UI must use companyId\/companyName/);
});
