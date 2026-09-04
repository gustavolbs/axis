import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentProductExecutionBridge } from '../src/agent-product-execution.js';
import { AgentProductRuntime } from '../src/agent-product-runtime.js';
import { PERSONAL_COMPANY_ID, type CompanyContextSnapshot } from '../src/company-context.js';
import type { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import type {
  ProviderConnectionRuntime,
  ProviderConnectionView
} from '../src/provider-connections.js';
import type {
  InferenceProvider,
  ModelDefinition,
  ProviderCapabilities
} from '../src/providers/types.js';
import { StandaloneJobManager } from '../src/standalone-job-manager.js';

const connectionId = 'chatgpt-account:personal-job-flow';
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

async function completed(manager: StandaloneJobManager, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = manager.get(id);
    if (current && !['queued', 'running'].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for Personal ChatGPT Account job completion.');
}

test('projectless normal Chat reaches direct ChatGPT Account transport through the persisted job flow', async () => {
  const connection: ProviderConnectionView = {
    id: connectionId,
    providerFamily: 'openai',
    label: 'ChatGPT Personal Account',
    auth: 'chatgpt-account',
    billing: 'subscription',
    organizationId: PERSONAL_COMPANY_ID,
    accountProfileId: 'personal-job-flow',
    available: true,
    supportsMcpSources: true
  };
  const requests: Array<{ model: string; output?: string }> = [];
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
      requests.push({ model: request.model, output: request.output?.type });
      return {
        providerId: connectionId,
        model: request.model,
        content: 'Account job-flow answer',
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
    projects: { getProject() { throw new Error('Projectless Chat must not resolve a Project.'); } },
    connections,
    providers,
    browserBackend: false,
    executionTargetId: 'desktop'
  });
  const bridge = new AgentProductExecutionBridge(runtime);
  const manager = new StandaloneJobManager(
    bridge as unknown as ConstructorParameters<typeof StandaloneJobManager>[0]
  );

  const queued = manager.create({
    workspace: '',
    goal: 'Hello from the normal Chat UI flow',
    interactionMode: 'chat',
    modelSelection: { mode: 'explicit', providerId: connectionId, modelId: 'default' },
    reasoningEffort: 'auto'
  });
  const result = await completed(manager, queued.id);

  assert.equal(result.status, 'success');
  assert.equal(result.error, undefined);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { model: 'default', output: 'text' });
  assert.equal(result.turns.at(-1)?.role, 'assistant');
  assert.equal(result.turns.at(-1)?.content, 'Account job-flow answer');
  assert.doesNotMatch(result.turns.at(-1)?.content ?? '', /remains fail-closed in AgentRuntime/);
});
