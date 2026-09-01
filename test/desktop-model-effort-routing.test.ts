import assert from 'node:assert/strict';
import test from 'node:test';

import { ProjectRoutedChatClient } from '../src/project-routed-chat.js';
import type { ProjectDefinition } from '../src/project-store.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from '../src/providers/types.js';
import type { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import type { OllamaChatOptions, OllamaGeneration } from '../src/ollama.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

function project(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return {
    id: 'desktop-project',
    name: 'Desktop Project',
    workspace: '/tmp/desktop-project',
    organizationId: 'desktop-org',
    defaultRoutingPolicy: 'balanced',
    defaultModel: { mode: 'auto' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic', 'ollama'] },
    credentialProfileIds: {},
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 1,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...overrides
  };
}

class CaptureProvider implements InferenceProvider {
  readonly id = 'anthropic';
  readonly kind = 'cloud' as const;
  readonly capabilities = capabilities;
  request?: InferenceRequest;

  async listModels(): Promise<ModelDefinition[]> {
    return [{ providerId: this.id, id: 'claude-desktop-test', displayName: 'Claude Desktop Test', capabilities }];
  }

  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true, checkedAt: new Date().toISOString(), latencyMs: 1 };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.request = request;
    return {
      providerId: this.id,
      model: request.model,
      content: '{"ok":true}',
      latencyMs: 2,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    };
  }
}

test('desktop explicit model and extra-high effort reach the selected cloud provider exactly', async () => {
  const provider = new CaptureProvider();
  const registry = new ProviderRegistry([provider]);
  const providers = {
    routingCandidates: async () => ({
      registry,
      candidates: [{
        providerId: 'anthropic',
        modelId: 'claude-desktop-test',
        providerKind: 'cloud' as const,
        available: true,
        capabilities,
        p50LatencyMs: 50,
        queueDelayMs: 0,
        qualityScore: 95,
        estimatedCostUsd: 0.01
      }]
    })
  } as unknown as ProjectProviderRuntime;
  let localCalls = 0;
  const local = {
    chat: async (): Promise<OllamaGeneration> => {
      localCalls += 1;
      return { content: 'local', model: 'qwen3.8:27b' };
    }
  };
  const client = new ProjectRoutedChatClient(project(), providers, local, {
    modelSelection: { mode: 'explicit', providerId: 'anthropic', modelId: 'claude-desktop-test' },
    reasoningEffort: 'xhigh'
  });

  const result = await client.chat(
    'You are the reasoning/planning stage of a local software-engineering agent.',
    'Plan this task.',
    undefined,
    { model: 'qwen3.8:27b', think: 'low' }
  );

  assert.equal(localCalls, 0);
  assert.equal(result.model, 'claude-desktop-test');
  assert.equal(provider.request?.model, 'claude-desktop-test');
  assert.equal(provider.request?.reasoning?.effort, 'xhigh');
});

test('desktop Thinking off reaches cloud inference as reasoning effort none', async () => {
  const provider = new CaptureProvider();
  const registry = new ProviderRegistry([provider]);
  const providers = {
    routingCandidates: async () => ({
      registry,
      candidates: [{
        providerId: 'anthropic',
        modelId: 'claude-desktop-test',
        providerKind: 'cloud' as const,
        available: true,
        capabilities,
        p50LatencyMs: 50,
        queueDelayMs: 0,
        qualityScore: 95,
        estimatedCostUsd: 0.01
      }]
    })
  } as unknown as ProjectProviderRuntime;
  const client = new ProjectRoutedChatClient(project(), providers, {
    chat: async (): Promise<OllamaGeneration> => ({ content: 'local', model: 'qwen3.8:27b' })
  }, {
    modelSelection: { mode: 'explicit', providerId: 'anthropic', modelId: 'claude-desktop-test' },
    reasoningEffort: 'none'
  });

  await client.chat(
    'You are the reasoning/planning stage of a local software-engineering agent.',
    'Plan without extended thinking.',
    undefined,
    { think: 'high' }
  );

  assert.equal(provider.request?.reasoning?.effort, 'none');
});

test('desktop Max effort on strict Local-only mode degrades explicitly to strongest supported local thinking', async () => {
  let runtime: OllamaChatOptions | undefined;
  const localProject = project({
    privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] },
    defaultRoutingPolicy: 'local-first'
  });
  const local = {
    chat: async (
      _system: string,
      _user: string,
      _format?: 'json' | Record<string, unknown>,
      nextRuntime: OllamaChatOptions = {}
    ): Promise<OllamaGeneration> => {
      runtime = nextRuntime;
      return { content: '{"ok":true}', model: nextRuntime.model ?? 'qwen3.8:27b' };
    }
  };
  const client = new ProjectRoutedChatClient(
    localProject,
    {} as ProjectProviderRuntime,
    local,
    {
      modelSelection: { mode: 'explicit', providerId: 'ollama', modelId: 'qwen3.8:27b' },
      reasoningEffort: 'max'
    }
  );

  await client.chat(
    'You are the reasoning/planning stage of a local software-engineering agent.',
    'Plan locally.',
    undefined,
    { model: 'wrong-model', think: 'low' }
  );

  assert.equal(runtime?.model, 'qwen3.8:27b');
  assert.equal(runtime?.think, 'high');
});
