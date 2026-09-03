import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompanyContextStore, PERSONAL_COMPANY_ID } from '../src/company-context.js';

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-company-context-'));
  return path.join(dir, 'company-context.json');
}

test('canonical company context distinguishes company, project, session and shared local execution scopes', () => {
  const store = new CompanyContextStore(tempFile());
  const snapshot = store.reconcile({
    projects: [
      {
        id: 'project-a',
        name: 'Project A',
        organizationId: 'company-a',
        organizationName: 'Company A',
        workspace: '/Volumes/source/company-a/project-a'
      },
      {
        id: 'project-b',
        name: 'Project B',
        organizationId: 'company-b',
        organizationName: 'Company B',
        workspace: '/Volumes/source/company-b/project-b'
      }
    ],
    connections: [
      { id: 'ollama', label: 'Ollama', auth: 'local', organizationId: 'local' },
      { id: 'openai-a', label: 'Company A OpenAI', auth: 'api-key', organizationId: 'company-a' },
      { id: 'claude-b', label: 'Company B Claude', auth: 'claude-account', organizationId: 'company-b', organizationLabel: 'Company B' },
      { id: 'chatgpt-personal', label: 'ChatGPT Personal', auth: 'chatgpt-account', organizationId: 'personal' }
    ],
    sessions: [
      { id: 'session-a', input: { projectId: 'project-a' } },
      { id: 'session-b', input: { projectId: 'project-b' } },
      { id: 'session-personal', input: {} }
    ]
  });

  assert.deepEqual(snapshot.sharedConnectionIds, ['ollama']);
  assert.equal(snapshot.companies[0]?.id, PERSONAL_COMPANY_ID);

  const personal = snapshot.companies.find((company) => company.id === PERSONAL_COMPANY_ID);
  const companyA = snapshot.companies.find((company) => company.id === 'company-a');
  const companyB = snapshot.companies.find((company) => company.id === 'company-b');
  assert.deepEqual(personal?.connectionIds, ['chatgpt-personal']);
  assert.deepEqual(personal?.sessionIds, ['session-personal']);
  assert.deepEqual(companyA?.projectIds, ['project-a']);
  assert.deepEqual(companyA?.connectionIds, ['openai-a']);
  assert.deepEqual(companyA?.sessionIds, ['session-a']);
  assert.deepEqual(companyB?.projectIds, ['project-b']);
  assert.deepEqual(companyB?.connectionIds, ['claude-b']);
  assert.deepEqual(companyB?.sessionIds, ['session-b']);
  assert.equal(snapshot.companies.some((company) => company.id === 'local'), false);
});

test('workspace paths never define or mutate company identity', () => {
  const store = new CompanyContextStore(tempFile());
  const first = store.reconcile({
    projects: [{ id: 'project-a', name: 'A', organizationId: 'company-a', workspace: '/tmp/one' }],
    connections: [],
    sessions: []
  });
  const second = store.reconcile({
    projects: [{ id: 'project-a', name: 'A', organizationId: 'company-a', workspace: '/Volumes/other/location' }],
    connections: [],
    sessions: []
  });
  assert.deepEqual(first.companies.map((company) => company.id), second.companies.map((company) => company.id));
  assert.deepEqual(second.companies.find((company) => company.id === 'company-a')?.projectIds, ['project-a']);
});

test('legacy account organization metadata is consumed once and cannot silently re-home a stable connection', () => {
  const file = tempFile();
  const firstStore = new CompanyContextStore(file);
  const first = firstStore.reconcile({
    projects: [],
    connections: [{
      id: 'claude-account-stable-id',
      label: 'Claude Work',
      auth: 'claude-account',
      organizationId: 'company-a',
      organizationLabel: 'Company A'
    }],
    sessions: []
  });
  assert.deepEqual(first.companies.find((company) => company.id === 'company-a')?.connectionIds, ['claude-account-stable-id']);

  // Simulate a later account/display-label rename. ProviderConnectionRuntime's
  // legacy organization id could change because it used to be derived from the
  // label; the canonical persisted binding must not follow it.
  const reopenedStore = new CompanyContextStore(file);
  const reopened = reopenedStore.reconcile({
    projects: [],
    connections: [{
      id: 'claude-account-stable-id',
      label: 'Claude Renamed',
      auth: 'claude-account',
      organizationId: 'renamed-company-label',
      organizationLabel: 'Renamed Company Label'
    }],
    sessions: []
  });

  assert.deepEqual(reopened.companies.find((company) => company.id === 'company-a')?.connectionIds, ['claude-account-stable-id']);
  assert.equal(reopened.companies.some((company) => company.id === 'renamed-company-label'), false);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(JSON.stringify(raw).includes('/tmp/'), false);
  assert.equal(JSON.stringify(raw).includes('Renamed Company Label'), false);
});

test('session hierarchy rejects a company that conflicts with its Project company', () => {
  const store = new CompanyContextStore(tempFile());
  assert.throws(
    () => store.reconcile({
      projects: [{ id: 'project-a', name: 'A', companyId: 'company-a' }],
      connections: [],
      sessions: [{ id: 'session-a', input: { projectId: 'project-a', companyId: 'company-b' } }]
    }),
    /Session session-a company does not match Project project-a/
  );
});

test('canonical company id and legacy organization id cannot disagree on a Project', () => {
  const store = new CompanyContextStore(tempFile());
  assert.throws(
    () => store.reconcile({
      projects: [{ id: 'project-a', name: 'A', companyId: 'company-a', organizationId: 'company-b' }],
      connections: [],
      sessions: []
    }),
    /conflicting company and legacy organization identities/
  );
});

test('desktop runtime exposes the canonical hierarchy instead of requiring callers to reconstruct legacy scopes', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'app-runtime.ts'), 'utf8');
  assert.match(source, /private readonly companyContext = new CompanyContextStore\(\)/);
  assert.match(source, /pathname === '\/companies\/context'/);
  assert.match(source, /projects: this\.projects\.listProjects\(\)/);
  assert.match(source, /connections: this\.projects\.listConnections\(\)/);
  assert.match(source, /sessions: this\.jobs\.list\(\)/);
});
