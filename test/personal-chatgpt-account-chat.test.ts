import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentProductRuntime } from '../src/agent-product-runtime.js';
import { PERSONAL_COMPANY_ID, type CompanyContextSnapshot } from '../src/company-context.js';
import type { ProjectEngineerInput } from '../src/project-engineer-backend.js';
import type { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
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

const connectionId = 'chatgpt-account:personal-test';
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
      projectIds: [],
      sessionIds: []
    }],
    sharedConnectionIds: []
  };
}

test('Personal ChatGPT Account normal Chat bypasses the AgentRuntime blocker without weakening its adapter', async () => {
  const connection: ProviderConnectionView = {
    id: connectionId,
    providerFamily: 'openai',
    label: 'ChatGPT Personal Account',
    auth: 'chatgpt-account',
    billing: 'subscription',
    organizationId: PERSONAL_COMPANY_ID,
    accountProfileId: 'personal-test',
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
        content: 'Direct account answer',
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
    projects: { getProject() { throw new Error('Personal Chat must not resolve a Project.'); } },
    connections,
    providers,
    browserBackend: false,
    executionTargetId: 'desktop'
  });

  const result = await runtime.executeEngineer({
    workspace: '',
    goal: 'What is 2 + 2?',
    interactionMode: 'chat',
    budgetJobId: 'personal-chatgpt-chat',
    modelSelection: { mode: 'explicit', providerId: connectionId, modelId: 'default' },
    reasoningEffort: 'auto',
    chatHistory: [{ role: 'user', content: 'Previous question' }, { role: 'assistant', content: 'Previous answer' }]
  } as ProjectEngineerInput);

  assert.equal(result.status, 'success');
  assert.equal(result.summary, 'Direct account answer');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.output?.type, 'text');
  assert.match(requests[0]?.systemPrompt ?? '', /direct Personal Chat provider transport/);
  assert.deepEqual(JSON.parse(requests[0]?.userPrompt ?? '[]'), [
    { role: 'user', content: 'Previous question' },
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: 'What is 2 + 2?' }
  ]);

  const effective = runtime.effectiveRuntimeContext('personal-chatgpt-chat');
  assert.equal(effective?.connection.id, connectionId);
  assert.equal(effective?.connection.authKind, 'chatgpt-account');
  assert.equal(effective?.execution.mode, 'inference-only');
  assert.deepEqual(effective?.roots, []);
});
