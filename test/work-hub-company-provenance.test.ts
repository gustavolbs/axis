import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderConnectionView } from '../src/provider-connections.js';
import { attachWorkHubCompanyProvenance } from '../src/work-hub-company-provenance.js';
import type { WorkHubSnapshot } from '../src/work-hub.js';

const snapshot: WorkHubSnapshot = {
  generatedAt: '2026-09-03T12:00:00.000Z',
  sources: [{
    id: 'ln-jira', label: 'Live Nation Jira', connectionId: 'claude-account-ln', kind: 'tickets', system: 'Jira',
    toolAllowlist: [], retention: 'local', enabled: true, createdAt: '2026-09-03T10:00:00.000Z', updatedAt: '2026-09-03T10:00:00.000Z'
  }],
  sourceStates: [{ sourceId: 'ln-jira', status: 'ready', itemCount: 1 }],
  events: [],
  tickets: [{
    kind: 'ticket', sourceId: 'ln-jira', connectionId: 'claude-account-ln', providerFamily: 'anthropic', system: 'Jira',
    externalId: 'LIV-1', collectedAt: '2026-09-03T12:00:00.000Z', key: 'LIV-1', title: 'Ship Company Hub',
    status: 'In Progress', normalizedStatus: 'in-progress'
  }],
  messages: []
};

const connection = {
  id: 'claude-account-ln', providerFamily: 'anthropic', label: 'Claude Live Nation', auth: 'claude-account', billing: 'subscription',
  organizationId: 'live-nation', companyId: 'live-nation', companyName: 'Live Nation', available: true, supportsMcpSources: true
} as ProviderConnectionView & { companyId: string; companyName: string };

test('global Work Hub snapshots preserve Company + connection + source provenance', () => {
  const enriched = attachWorkHubCompanyProvenance(snapshot, [connection]);
  assert.equal(enriched.sources[0]?.companyId, 'live-nation');
  assert.equal(enriched.sources[0]?.companyName, 'Live Nation');
  assert.equal(enriched.sources[0]?.connectionId, 'claude-account-ln');
  assert.equal(enriched.tickets[0]?.companyId, 'live-nation');
  assert.equal(enriched.tickets[0]?.companyName, 'Live Nation');
  assert.equal(enriched.tickets[0]?.connectionId, 'claude-account-ln');
  assert.equal(enriched.tickets[0]?.sourceId, 'ln-jira');
});

test('Work Hub rejects a source whose connection has no canonical Company owner', () => {
  assert.throws(() => attachWorkHubCompanyProvenance(snapshot, []), /no canonical Company owner/i);
});
