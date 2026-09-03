import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompanyContextStore } from '../src/company-context.js';

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axis-company-lifecycle-')), 'company-context.json');
}

test('company lifecycle keeps immutable ids while editable metadata persists across restart', () => {
  const file = tempFile();
  const store = new CompanyContextStore(file);
  const created = store.createCompany({
    name: 'Acme Engineering',
    description: 'Product engineering',
    color: '#123ABC',
    icon: 'code-2'
  });

  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.name, 'Acme Engineering');
  assert.equal(created.color, '#123ABC');
  assert.equal(created.icon, 'code-2');

  const updated = store.updateCompany(created.id, {
    name: 'Acme Platform',
    description: 'Platform and developer experience',
    color: '#ABCDEF',
    icon: 'rocket'
  });
  assert.equal(updated.id, created.id);

  const reopened = new CompanyContextStore(file).getCompany(created.id);
  assert.equal(reopened.id, created.id);
  assert.equal(reopened.name, 'Acme Platform');
  assert.equal(reopened.description, 'Platform and developer experience');
  assert.equal(reopened.color, '#ABCDEF');
  assert.equal(reopened.icon, 'rocket');
});

test('company names are unique independent of case and unicode normalization', () => {
  const store = new CompanyContextStore(tempFile());
  store.createCompany({ name: 'Live Nation' });
  assert.throws(() => store.createCompany({ name: 'live nation' }), /already exists/);
  const other = store.createCompany({ name: 'Another Company' });
  assert.throws(() => store.updateCompany(other.id, { name: 'LIVE NATION' }), /already exists/);
});

test('new company metadata is strict while legacy migration remains tolerant', () => {
  const store = new CompanyContextStore(tempFile());
  const company = store.createCompany({ name: 'Validated' });
  assert.throws(() => store.createCompany({ name: '   ' }), /Company name/);
  assert.throws(() => store.updateCompany(company.id, { name: '\n' }), /Company name/);
  assert.throws(() => store.createCompany({ name: 'Bad Color', color: '#12345G' }), /Company color/);
  assert.throws(
    () => store.createCompany({ name: 'Bad Icon', icon: 'skull' as never }),
    /Unsupported company icon/
  );
  assert.throws(
    () => store.createCompany({ name: 'Bad Description', description: 'x'.repeat(2_001) }),
    /description must be at most/
  );
});

test('archive and restore preserve identity without deleting referenced company context', () => {
  const file = tempFile();
  const store = new CompanyContextStore(file);
  const company = store.createCompany({ name: 'Archived Co' });
  const archived = store.setCompanyArchived(company.id, true);
  assert.ok(archived.archivedAt);
  assert.deepEqual(store.listCompanies().map((item) => item.id), []);
  assert.deepEqual(store.listCompanies({ includeArchived: true }).map((item) => item.id), [company.id]);

  const context = store.reconcile({
    projects: [{ id: 'project-a', name: 'A', companyId: company.id }],
    connections: [],
    sessions: [{ id: 'session-a', input: { projectId: 'project-a' } }]
  });
  const held = context.companies.find((item) => item.id === company.id);
  assert.ok(held?.archivedAt);
  assert.deepEqual(held?.projectIds, ['project-a']);
  assert.deepEqual(held?.sessionIds, ['session-a']);

  const restored = new CompanyContextStore(file).setCompanyArchived(company.id, false);
  assert.equal(restored.archivedAt, undefined);
  assert.equal(restored.id, company.id);
});

test('company order is explicit, persistent and requires the complete active set', () => {
  const file = tempFile();
  const store = new CompanyContextStore(file);
  const a = store.createCompany({ name: 'A' });
  const b = store.createCompany({ name: 'B' });
  const c = store.createCompany({ name: 'C' });

  assert.deepEqual(store.listCompanies().map((item) => item.id), [a.id, b.id, c.id]);
  assert.deepEqual(store.reorderCompanies([c.id, a.id, b.id]).map((item) => item.id), [c.id, a.id, b.id]);
  assert.deepEqual(new CompanyContextStore(file).listCompanies().map((item) => item.id), [c.id, a.id, b.id]);
  assert.throws(() => store.reorderCompanies([a.id, b.id]), /every active company exactly once/);
  assert.throws(() => store.reorderCompanies([a.id, a.id, c.id]), /duplicate ids/);
});

test('company search includes name and description and can include archived results', () => {
  const store = new CompanyContextStore(tempFile());
  const platform = store.createCompany({ name: 'Platform Group', description: 'Developer experience and tooling' });
  const finance = store.createCompany({ name: 'Finance', description: 'Billing systems' });
  store.setCompanyArchived(finance.id, true);

  assert.deepEqual(store.listCompanies({ query: 'developer' }).map((item) => item.id), [platform.id]);
  assert.deepEqual(store.listCompanies({ query: 'billing' }).map((item) => item.id), []);
  assert.deepEqual(store.listCompanies({ query: 'billing', includeArchived: true }).map((item) => item.id), [finance.id]);
});

test('legacy company records migrate metadata defaults without changing their stable id', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    companies: {
      'legacy-company': {
        name: 'Legacy Company',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    },
    connectionBindings: {},
    updatedAt: '2026-01-01T00:00:00.000Z'
  }));

  const company = new CompanyContextStore(file).getCompany('legacy-company');
  assert.equal(company.id, 'legacy-company');
  assert.equal(company.name, 'Legacy Company');
  assert.match(company.color, /^#[0-9A-F]{6}$/);
  assert.equal(company.icon, 'building-2');
  assert.equal(company.order, 0);
});

test('Personal remains reserved and cannot be edited, archived or recreated as a normal company', () => {
  const store = new CompanyContextStore(tempFile());
  assert.throws(() => store.updateCompany('personal', { name: 'Work' }), /reserved context/);
  assert.throws(() => store.setCompanyArchived('personal', true), /cannot be archived/);
  assert.throws(() => store.createCompany({ name: '' }), /Company name/);
  assert.throws(() => store.createCompany({ name: 'personal' }), /reserved company name/);
  assert.throws(() => store.createCompany({ name: 'PERSONAL' }), /reserved company name/);
});
