import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAgentSessionContext,
  negotiateEffectiveCapabilities
} from '../src/agent-runtime/index.js';
import type { CompanyContextSnapshot } from '../src/company-context.js';
import type { ProviderConnectionView } from '../src/provider-connections.js';

const snapshot: CompanyContextSnapshot = {
  version: 1,
  generatedAt: new Date(0).toISOString(),
  companies: [
    {
      id: 'company-a',
      name: 'Company A',
      color: '#64748B',
      icon: 'building-2',
      order: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      kind: 'company',
      connectionIds: ['connection-a'],
      projectIds: ['project-a'],
      sessionIds: ['existing-a']
    },
    {
      id: 'company-b',
      name: 'Company B',
      color: '#64748B',
      icon: 'building-2',
      order: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      kind: 'company',
      connectionIds: ['connection-b'],
      projectIds: ['project-b'],
      sessionIds: ['existing-b']
    }
  ],
  sharedConnectionIds: ['ollama']
};

function connection(
  id: string,
  auth: ProviderConnectionView['auth'] = 'api-key',
  providerFamily: ProviderConnectionView['providerFamily'] = 'openai'
): ProviderConnectionView {
  return {
    id,
    providerFamily,
    label: id,
    auth,
    billing: auth === 'local' ? 'local' : auth === 'api-key' ? 'api' : 'subscription',
    // Deliberately legacy/misleading: canonical snapshot, not this field, owns scope.
    organizationId: id === 'connection-a' ? 'legacy-wrong-company' : 'company-b',
    available: true,
    supportsMcpSources: false
  };
}

function baseInput() {
  return {
    companyContext: snapshot,
    sessionId: 'new-session-a',
    companyId: 'company-a',
    project: { id: 'project-a' },
    connection: connection('connection-a'),
    modelId: 'model-test',
    executionTarget: { id: 'desktop', kind: 'desktop' as const, mode: 'workspace' as const },
    roots: [{
      id: 'workspace',
      path: '/workspace/company-a',
      access: 'write' as const,
      companyId: 'company-a',
      projectId: 'project-a'
    }],
    permissions: {
      default: 'denied' as const,
      entries: { 'workspace.read': 'granted' as const }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'axis-test', ids: ['axis.filesystem.read'] }]
    }),
    resources: []
  };
}

test('session builder takes Company/Project/Connection ownership from the PR #75 canonical snapshot', () => {
  const context = buildAgentSessionContext(baseInput());

  assert.equal(context.companyId, 'company-a');
  assert.equal(context.project?.companyId, 'company-a');
  assert.equal(context.connection.companyId, 'company-a');
  assert.equal(context.connection.id, 'connection-a');
  assert.equal(context.connection.authKind, 'api-key');
  assert.equal(context.connection.providerFamily, 'openai');
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.connection), true);
});

test('legacy organization metadata cannot move a connection out of its canonical Company binding', () => {
  const context = buildAgentSessionContext(baseInput());
  assert.equal(context.connection.companyId, 'company-a');
  assert.notEqual(context.connection.companyId, connection('connection-a').organizationId);
});

test('builder rejects Project, Connection and existing Session ownership from another Company', () => {
  assert.throws(
    () => buildAgentSessionContext({
      ...baseInput(),
      project: { id: 'project-b' }
    }),
    /Project project-b belongs to Company company-b/
  );

  assert.throws(
    () => buildAgentSessionContext({
      ...baseInput(),
      connection: connection('connection-b')
    }),
    /Connection connection-b belongs to Company company-b/
  );

  assert.throws(
    () => buildAgentSessionContext({
      ...baseInput(),
      sessionId: 'existing-b'
    }),
    /Session existing-b belongs to Company company-b/
  );
});

test('shared local connection stays company-neutral while the session remains Company-scoped', () => {
  const context = buildAgentSessionContext({
    ...baseInput(),
    connection: connection('ollama', 'local', 'ollama')
  });

  assert.equal(context.companyId, 'company-a');
  assert.equal(context.connection.companyId, null);
  assert.equal(context.connection.authKind, 'local');
});

test('unknown canonical Project or Connection fails instead of falling back to legacy metadata', () => {
  assert.throws(
    () => buildAgentSessionContext({ ...baseInput(), project: { id: 'missing-project' } }),
    /Project missing-project is not present in the canonical Company context/
  );
  assert.throws(
    () => buildAgentSessionContext({ ...baseInput(), connection: connection('missing-connection') }),
    /Connection missing-connection is not present in the canonical Company context/
  );
});
