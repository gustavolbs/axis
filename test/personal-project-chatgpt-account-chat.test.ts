import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentProductRuntime } from '../src/agent-product-runtime.js';
import { PERSONAL_COMPANY_ID, type CompanyContextSnapshot } from '../src/company-context.js';
import type { ProjectEngineerInput } from '../src/project-engineer-backend.js';
import type { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import type { ProjectDefinition } from '../src/project-store.js';
import type {
  ProviderConnectionRuntime,
  ProviderConnectionView
} from '../src/provider-connections.js';
import type {
  InferenceProvider,
  InferenceRequest,
  ModelDefinition,
  ProviderCapabilities
} from '../src/providers/types.js';

const connectionId = 'chatgpt-account:personal-project-test';
const projectId = 'personal-project';
const model: ModelDefinition = {
  providerId: connectionId,
  id: 'default',
  displayName: 'Default model'
};
const capabilities: ProviderCapabilities = {
  modelDiscovery: false,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: true
};

const project: ProjectDefinition = {
  id: projectId,
  name: 'Personal Project',
  workspace: '',
  instructions: 'Keep answers concise.',
  organizationId: PERSONAL_COMPANY_ID,
  organizationName: 'Personal',
  defaultRoutingPolicy: 'auto',
  defaultModel: { mode: 'explicit', providerId: connectionId, modelId: 'default' },
  privacy: { cloudAllowed: true, allowedProviderIds: ['openai'] },
  credentialProfileIds: {},
  connectionPolicy: {
    chat: {
      defaultConnectionId: connectionId,
      defaultModelId: 'default',
      allowedConnectionIds: [connectionId]
    },
    inference: { allowedConnectionIds: [connectionId] },
    workSourceIds: []
  },
  budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
  repoIntelligenceScope: 'project',
  concurrency: 1,
  createdAt: '2026-09-03T12:00:00.000Z',
  updatedAt: '2026-09-03T12:00:00.000Z'
};

function snapshot(connection: ProviderConnectionView): CompanyContextSnapshot {
  return {
    version: 1,
    generatedAt: '2026-09-03T12:00:00.000Z',
    companies: [{
      id: PERSONAL_COMPANY_ID,
      name: 'Personal',
      color: '#64748B',
      icon: 'building-2',
      order: 0,
      createdAt: '2026-09-03T12:00:00.000Z',
      updatedAt: '2026-09-03T12:00:00.000Z',
      kind: 'personal',
      connectionIds: [connection.id],
      projectIds: [projectId],
      sessionIds: []
    }],
    sharedConnectionIds: []
  };
}

test('Personal Project normal Chat uses direct ChatGPT Account transport with Account Default and default thinking', async () => {
  const connection: ProviderConnectionView = {
    id: connectionId,
    providerFamily: 'openai',
    label: 'ChatGPT Personal Account',
    auth: 'chatgpt-account',
    billing: 'subscription',
    organizationId: PERSONAL_COMPANY_ID,
    accountProfileId: 'personal-project-test',
    available: true,
    supportsMcpSources: true
  };
  const requests: InferenceRequest[] = [];
  const provider: InferenceProvider = {
    id: connectionId,
    kind: 'cloud',
    capabilities,
    async listModels() { return [model]; },
    async health() {
      return {
        providerId: connectionId,
        ok: true,
        checkedAt: '2026-09-03T12:00:00.000Z',
        latencyMs: 0,
        modelsAvailable: 1
      };
    },
    async invoke(request) {
      requests.push(request);
      return {
        providerId: connectionId,
        model: request.model,
        content: 'Personal Project account answer',
        latencyMs: 1,
        usage: {}
      };
    }
  };
  const providers = {
    async personalModelDefinition(selectedConnectionId: string, modelId: string) {
      assert.equal(selectedConnectionId, connectionId);
      assert.equal(modelId, 'default');
      return { provider, model };
    }
  } as ProjectProviderRuntime;
  const connections = {
    view(id: string) { return id === connectionId ? connection : undefined; }
  } as ProviderConnectionRuntime;
  const runtime = new AgentProductRuntime({
    companyContext: () => snapshot(connection),
    projects: {
      getProject(id: string) {
        assert.equal(id, projectId);
        return project;
      }
    },
    connections,
    providers,
    browserBackend: false,
    executionTargetId: 'desktop'
  });

  const result = await runtime.executeEngineer({
    projectId,
    workspace: '',
    goal: 'Explain this briefly.',
    interactionMode: 'chat',
    budgetJobId: 'personal-project-chatgpt-chat',
    modelSelection: { mode: 'explicit', providerId: connectionId, modelId: 'default' },
    reasoningEffort: 'auto'
  } as ProjectEngineerInput);

  assert.equal(result.status, 'success');
  assert.equal(result.summary, 'Personal Project account answer');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.model, 'default');
  assert.equal(requests[0]?.output?.type, 'text');
  assert.equal(requests[0]?.reasoning, undefined, 'default thinking must not force an effort override');
  assert.match(requests[0]?.systemPrompt ?? '', /Project: personal-project/);
  assert.match(requests[0]?.systemPrompt ?? '', /Keep answers concise\./);
  assert.doesNotMatch(requests[0]?.systemPrompt ?? '', /remains fail-closed in AgentRuntime/);

  const effective = runtime.effectiveRuntimeContext('personal-project-chatgpt-chat');
  assert.equal(effective?.company.id, PERSONAL_COMPANY_ID);
  assert.equal(effective?.project?.id, projectId);
  assert.equal(effective?.connection.authKind, 'chatgpt-account');
  assert.equal(effective?.execution.mode, 'inference-only');
  assert.deepEqual(effective?.roots, []);
  assert.deepEqual(effective?.resources, []);
});
