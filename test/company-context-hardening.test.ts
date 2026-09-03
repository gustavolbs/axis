import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompanyContextStore } from '../src/company-context.js';

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axis-company-hardening-')), 'company-context.json');
}

test('an explicit canonical company cannot disagree with an existing stable connection binding', () => {
  const file = tempFile();
  new CompanyContextStore(file).reconcile({
    projects: [],
    connections: [{ id: 'account-a', label: 'Account A', auth: 'claude-account', organizationId: 'company-a' }],
    sessions: []
  });

  assert.throws(
    () => new CompanyContextStore(file).reconcile({
      projects: [],
      connections: [{ id: 'account-a', label: 'Account A', auth: 'claude-account', companyId: 'company-b' }],
      sessions: []
    }),
    /explicit company conflicts with its persisted company binding/
  );
});

test('only local authentication/runtime kind can enter shared local execution scope', () => {
  const store = new CompanyContextStore(tempFile());
  assert.throws(
    () => store.reconcile({
      projects: [],
      connections: [{
        id: 'corporate-account-called-local',
        label: 'Local',
        auth: 'claude-account',
        organizationId: 'local',
        organizationLabel: 'Local'
      }],
      sessions: []
    }),
    /reserved local execution scope/
  );

  const local = store.reconcile({
    projects: [],
    connections: [{ id: 'ollama', label: 'Ollama', auth: 'local', organizationId: 'local' }],
    sessions: []
  });
  assert.deepEqual(local.sharedConnectionIds, ['ollama']);
});
