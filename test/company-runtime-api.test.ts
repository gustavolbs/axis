import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('desktop runtime exposes complete local company lifecycle endpoints', () => {
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

test('company lifecycle API intentionally exposes no destructive delete endpoint', () => {
  const source = fs.readFileSync('src/app-runtime.ts', 'utf8');
  assert.doesNotMatch(source, /companyMatch && method === 'DELETE'/);
});
