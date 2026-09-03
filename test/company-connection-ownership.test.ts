import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompanyConnectionOwnership } from '../src/company-connection-ownership.js';
import { CompanyContextStore, PERSONAL_COMPANY_ID } from '../src/company-context.js';
import {
  apiCredentialConnectionId,
  claudeAccountConnectionId,
  type ProviderConnectionView
} from '../src/provider-connections.js';

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function api(id: string, label: string, organizationId = PERSONAL_COMPANY_ID): ProviderConnectionView {
  return {
    id: apiCredentialConnectionId('openai', id),
    providerFamily: 'openai',
    label,
    auth: 'api-key',
    billing: 'api',
    organizationId,
    credentialId: id,
    available: true,
    supportsMcpSources: false
  };
}

function claude(id: string, label: string, organizationLabel?: string): ProviderConnectionView {
  return {
    id: claudeAccountConnectionId(id),
    providerFamily: 'anthropic',
    label,
    auth: 'claude-account',
    billing: 'subscription',
    organizationId: organizationLabel?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || PERSONAL_COMPANY_ID,
    organizationLabel,
    accountProfileId: id,
    available: true,
    supportsMcpSources: true
  };
}

test('same-provider API keys remain distinct while sharing one canonical Company', () => {
  const store = new CompanyContextStore(path.join(temp('axis-connection-owner-'), 'companies.json'));
  const acme = store.createCompany({ name: 'Acme Engineering' });
  const ownership = new CompanyConnectionOwnership(store);
  const primary = api('acme-primary', 'OpenAI Primary');
  const backup = api('acme-backup', 'OpenAI Backup');

  ownership.bind(primary, acme.id);
  ownership.bind(backup, acme.id);

  const views = ownership.canonicalize([primary, backup]);
  assert.equal(views.length, 2);
  assert.notEqual(views[0].id, views[1].id);
  assert.deepEqual(new Set(views.map((view) => view.companyId)), new Set([acme.id]));
  assert.deepEqual(new Set(views.map((view) => view.organizationId)), new Set([acme.id]));
  assert.deepEqual(new Set(views.map((view) => view.companyName)), new Set(['Acme Engineering']));
});

test('persisted connection binding wins over later mutable Account organization metadata', () => {
  const store = new CompanyContextStore(path.join(temp('axis-account-owner-'), 'companies.json'));
  const acme = store.createCompany({ name: 'Acme' });
  const ownership = new CompanyConnectionOwnership(store);
  const initial = claude('work', 'Claude Work', 'Acme');

  ownership.bind(initial, acme.id);

  const renamedProviderMetadata = claude('work', 'Claude Work Renamed', 'Completely Different Label');
  const [canonical] = ownership.canonicalize([renamedProviderMetadata]);
  assert.equal(canonical.companyId, acme.id);
  assert.equal(canonical.organizationId, acme.id);
  assert.equal(canonical.companyName, 'Acme');
  assert.equal(canonical.organizationLabel, 'Completely Different Label');
});

test('Personal is explicit, archived Companies reject new bindings, and local execution cannot be owned', () => {
  const store = new CompanyContextStore(path.join(temp('axis-connection-rules-'), 'companies.json'));
  const acme = store.createCompany({ name: 'Acme' });
  const ownership = new CompanyConnectionOwnership(store);
  const personalApi = api('personal', 'OpenAI Personal');

  ownership.bind(personalApi, PERSONAL_COMPANY_ID);
  assert.equal(ownership.canonicalize([personalApi])[0].companyId, PERSONAL_COMPANY_ID);

  store.setCompanyArchived(acme.id, true);
  assert.throws(() => ownership.bind(api('archived', 'OpenAI Archived'), acme.id), /archived/);

  assert.throws(() => ownership.bind({
    id: 'ollama',
    label: 'Ollama local',
    auth: 'local',
    organizationId: 'local'
  }, PERSONAL_COMPANY_ID), /shared and cannot be assigned/);
});
