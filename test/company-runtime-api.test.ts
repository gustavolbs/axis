import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('base desktop runtime exposes non-destructive local Company lifecycle endpoints', () => {
  const source = fs.readFileSync('src/app-runtime.ts', 'utf8');
  assert.match(source, /method === 'GET' && pathname === '\/companies'/);
  assert.match(source, /includeArchived: url\.searchParams\.get\('archived'\) === 'all'/);
  assert.match(source, /query: url\.searchParams\.get\('q'\)/);
  assert.match(source, /method === 'POST' && pathname === '\/companies'/);
  assert.match(source, /createCompany/);
  assert.match(source, /method === 'POST' && pathname === '\/companies\/order'/);
  assert.match(source, /reorderCompanies/);
  assert.match(source, /companyMatch && method === 'PATCH'/);
  assert.match(source, /updateCompany/);
  assert.match(source, /companyArchiveMatch && method === 'POST'/);
  assert.match(source, /setCompanyArchived/);
});

test('reserved Company collection routes cannot be captured as company ids', () => {
  const source = fs.readFileSync('src/app-runtime.ts', 'utf8');
  assert.match(source, /pathname === '\/companies\/context'/);
  assert.match(source, /\(\?:context\|order\)\$/);
});

test('Company deletion is guarded by active scope and the Company store', () => {
  const scopedRuntime = fs.readFileSync('src/company-scoped-desktop-runtime.ts', 'utf8');
  const store = fs.readFileSync('src/company-context.ts', 'utf8');
  assert.ok(scopedRuntime.includes("const companyDeleteMatch = /^\\/companies\\/([^/]+)$/.exec(pathname);"));
  assert.match(scopedRuntime, /companyDeleteMatch && method === 'DELETE'/);
  assert.match(scopedRuntime, /if \(companyId === PERSONAL_COMPANY_ID\) throw new Error\('Personal cannot be deleted\.'\)/);
  assert.match(scopedRuntime, /context\.companies\.find\(\(candidate\) => candidate\.id === companyId\)/);
  assert.match(scopedRuntime, /company\.projectIds\.length/);
  assert.match(scopedRuntime, /company\.connectionIds\.length/);
  assert.match(scopedRuntime, /company\.sessionIds\.length/);
  assert.match(scopedRuntime, /this\.companies\.deleteCompany\(companyId\)/);
  assert.match(scopedRuntime, /this\.active\.resetIfActive\(companyId\)/);
  assert.match(store, /Personal cannot be deleted/);
  assert.match(store, /still owns/);
});
