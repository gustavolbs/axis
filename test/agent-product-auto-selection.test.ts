import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { AgentLifecycleEvent } from '../src/agent-runtime/index.js';
import { AgentProductRuntime } from '../src/agent-product-runtime.js';
import type { CompanyContextSnapshot } from '../src/company-context.js';
import type { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import type { ProjectDefinition } from '../src/project-store.js';
import type {
  ProviderConnectionRuntime,
  ProviderConnectionView
} from '../src/provider-connections.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from '../src/providers/types.js';

const now = '2026-09-03T18:00:00.000Z';
const providerCapabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

class AutoProvider implements InferenceProvider {
  readonly id = 'openai-a';
  readonly kind = 'cloud' as const;
  readonly capabilities = providerCapabilities;
  readonly requests: InferenceRequest[] = [];

  async listModels(): Promise<ModelDefinition[]> {
    return [{
      providerId: this.id,
      id: 'gpt-auto',
      displayName: 'GPT Auto',
      capabilities: providerCapabilities
    }];
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      ok: true,
      checkedAt: now,
      latencyMs: 0,
      modelsAvailable: 1
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.requests.push(request);
    return {
      providerId: this.id,
      model: request.model,
      content: JSON.stringify({ complete: true, text: 'auto selected', toolCalls: [] }),
      latencyMs: 1,
      usage: {}
    };
  }
}

function connection(id: string, companyId: string): ProviderConnectionView {
  return {
    id,
    providerFamily: 'openai',
    label: id,
    auth: 'api-key',
    billing: 'api',
    organizationId: companyId,
    available: true,
    supportsMcpSources: false
  };
}

function project(workspace: string, allowedConnectionIds = ['openai-a']): ProjectDefinition {
  return {
    id: 'project-a',
    name: 'Project A',
    workspace,
    organizationId: 'company-a',
    defaultRoutingPolicy: 'balanced',
    defaultModel: { mode: 'auto' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['openai'] },
    credentialProfileIds: {},
    connectionPolicy: {
      chat: {
        defaultConnectionId: 'openai-a',
        defaultModelId: 'gpt-auto',
        allowedConnectionIds
      },
      inference: {
        allowedConnectionIds,
        preferredConnectionId: 'openai-a'
      },
      workSourceIds: []
    },
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 1,
    createdAt: now,
    updatedAt: now
  };
}

function snapshot(
  selectedProject: ProjectDefinition,
  companyAConnections: string[],
  companyBConnections: string[] = []
): CompanyContextSnapshot {
  return {
    version: 1,
    generatedAt: now,
    companies: [
      {
        id: 'company-a',
        name: 'Company A',
        color: '#64748B',
        icon: 'building-2',
        order: 0,
        createdAt: now,
        updatedAt: now,
        kind: 'company',
        connectionIds: companyAConnections,
        projectIds: [selectedProject.id],
        sessionIds: []
      },
      {
        id: 'company-b',
        name: 'Company B',
        color: '#64748B',
        icon: 'building-2',
        order: 1,
        createdAt: now,
        updatedAt: now,
        kind: 'company',
        connectionIds: companyBConnections,
        projectIds: [],
        sessionIds: []
      }
    ],
    sharedConnectionIds: []
  };
}

test('Cowork resolves Project auto routing to one exact Connection/model before the AgentRuntime session is frozen', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-product-auto-'));
  const selectedProject = project(workspace);
  const selectedConnection = connection('openai-a', 'company-a');
  const provider = new AutoProvider();
  const registry = new ProviderRegistry([provider]);
  let routingCalls = 0;
  const providers = {
    async routingCandidates() {
      routingCalls += 1;
      return {
        registry,
        candidates: [{
          providerId: 'openai-a',
          modelId: 'gpt-auto',
          providerKind: 'cloud',
          available: true,
          capabilities: providerCapabilities,
          preferredConnection: true
        }]
      };
    },
    buildRegistry() { return registry; }
  } as unknown as ProjectProviderRuntime;
  const connections = {
    view(id: string) { return id === selectedConnection.id ? selectedConnection : undefined; }
  } as unknown as ProviderConnectionRuntime;
  const runtime = new AgentProductRuntime({
    companyContext: () => snapshot(selectedProject, ['openai-a']),
    projects: { getProject() { return selectedProject; } },
    connections,
    providers,
    browserBackend: false,
    executionTargetId: 'desktop'
  });
  const starts: Extract<AgentLifecycleEvent, { type: 'session.started' }>[] = [];
  runtime.subscribeAgentLifecycle((event) => {
    if (event.type === 'session.started') starts.push(event);
  });

  try {
    const result = await runtime.executeEngineer({
      projectId: selectedProject.id,
      workspace,
      goal: 'Implement with automatic Project routing.',
      interactionMode: 'cowork',
      budgetJobId: 'auto-session'
    });

    assert.equal(result.status, 'success');
    assert.equal(routingCalls, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.model, 'gpt-auto');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.context.connection.id, 'openai-a');
    assert.equal(starts[0]?.context.modelId, 'gpt-auto');
    assert.equal(starts[0]?.context.companyId, 'company-a');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('auto routing rejects a foreign allowed Connection from the canonical Company graph before provider catalog resolution', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-product-auto-isolation-'));
  const selectedProject = project(workspace, ['openai-a', 'openai-b']);
  const connectionA = connection('openai-a', 'company-a');
  const connectionB = connection('openai-b', 'company-b');
  let routingCalls = 0;
  const providers = {
    async routingCandidates() {
      routingCalls += 1;
      throw new Error('routingCandidates must not run after a Company ownership violation');
    },
    buildRegistry() { throw new Error('buildRegistry must not run after a Company ownership violation'); }
  } as unknown as ProjectProviderRuntime;
  const connections = {
    view(id: string) {
      if (id === connectionA.id) return connectionA;
      if (id === connectionB.id) return connectionB;
      return undefined;
    }
  } as unknown as ProviderConnectionRuntime;
  const runtime = new AgentProductRuntime({
    companyContext: () => snapshot(selectedProject, ['openai-a'], ['openai-b']),
    projects: { getProject() { return selectedProject; } },
    connections,
    providers,
    browserBackend: false
  });

  try {
    await assert.rejects(
      runtime.executeEngineer({
        projectId: selectedProject.id,
        workspace,
        goal: 'Do not cross Company scope during auto selection.',
        interactionMode: 'cowork',
        budgetJobId: 'auto-isolation-session'
      }),
      /Connection openai-b belongs to Company company-b, not selected Company company-a/
    );
    assert.equal(routingCalls, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
