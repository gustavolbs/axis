import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apiCredentialConnectionId } from '../src/connection-identity.js';
import {
  CredentialManager,
  CredentialProfileStore
} from '../src/credential-store.js';
import type {
  OllamaChatOptions,
  OllamaGeneration
} from '../src/ollama.js';
import type { ProjectDefinition } from '../src/project-store.js';
import { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import { ProjectRoutedChatClient } from '../src/project-routed-chat.js';
import { ClaudeAccountProfileStore } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore } from '../src/codex-account-profiles.js';
import { ProviderConnectionRuntime } from '../src/provider-connections.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import { OllamaInferenceProvider } from '../src/providers/ollama-provider.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth,
  ProviderKind
} from '../src/providers/types.js';
import type { SecretStore } from '../src/secret-store.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-coder-${name}-`));
}

class MemorySecretStore implements SecretStore {
  readonly backend = 'macos-keychain' as const;
  private readonly values = new Map<string, string>();
  isAvailable(): boolean { return true; }
  get(id: string): string | undefined { return this.values.get(id); }
  set(id: string, value: string): void { this.values.set(id, value); }
  delete(id: string): boolean { return this.values.delete(id); }
}

class FakeProvider implements InferenceProvider {
  calls: InferenceRequest[] = [];

  constructor(
    readonly id: string,
    readonly kind: ProviderKind,
    readonly modelIds: string[],
    private readonly qualityContent = 'ok'
  ) {}

  readonly capabilities = capabilities;

  async listModels(): Promise<ModelDefinition[]> {
    return this.modelIds.map((id, index) => ({
      providerId: this.id,
      id,
      displayName: id,
      capabilities,
      metadata: this.kind === 'local' && index === 0 ? { configuredFastModel: true } : undefined
    }));
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      modelsAvailable: this.modelIds.length
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.calls.push(request);
    return {
      providerId: this.id,
      model: request.model,
      content: this.qualityContent,
      stopReason: 'completed',
      latencyMs: 10,
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }
    };
  }
}

function project(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return {
    id: 'company-a',
    name: 'Company A',
    workspace: '/repo/company-a',
    organizationId: 'company-a',
    defaultRoutingPolicy: 'balanced',
    defaultModel: { mode: 'auto' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic'] },
    credentialProfileIds: { anthropic: 'company-a-anthropic' },
    budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
    repoIntelligenceScope: 'project',
    concurrency: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

function runtimeFixture() {
  const root = temp('project-runtime');
  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  const profileStore = new CredentialProfileStore(path.join(root, 'credentials.json'));
  const keychain = new MemorySecretStore();
  const credentials = new CredentialManager(profileStore, { keychain });
  credentials.addOrReplaceKeychainCredential({
    id: 'company-a-anthropic',
    providerId: 'anthropic',
    label: 'Company A Anthropic',
    organizationId: 'company-a',
    secret: 'secret-value-never-persisted'
  });
  const local = new FakeProvider('ollama', 'local', ['qwen-fast', 'qwen-strong']);
  let cloud: FakeProvider | undefined;
  const connections = new ProviderConnectionRuntime({
    localProvider: local,
    credentials,
    settings,
    claudeProfiles: new ClaudeAccountProfileStore(path.join(root, 'claude-profiles')),
    codexProfiles: new CodexAccountProfileStore(path.join(root, 'codex-profiles')),
    apiProviderFactories: {
      anthropic: (apiKey) => {
        assert.equal(apiKey, 'secret-value-never-persisted');
        cloud = new FakeProvider('anthropic', 'cloud', ['cloud-fast', 'cloud-other'], '{"ok":true}');
        return cloud;
      }
    }
  });
  const providerRuntime = new ProjectProviderRuntime({
    localProvider: local,
    credentials,
    settings,
    connections,
    cloudProviderFactories: {
      anthropic: (apiKey) => {
        assert.equal(apiKey, 'secret-value-never-persisted');
        cloud = new FakeProvider('anthropic', 'cloud', ['cloud-fast', 'cloud-other'], '{"ok":true}');
        return cloud;
      }
    },
    metrics: {
      get: (_projectId, _stage, providerId) => providerId === 'ollama'
        ? { queueDelayMs: 27 * 60_000, p50LatencyMs: 8 * 60_000, successRate: 0.9 }
        : { queueDelayMs: 0, p50LatencyMs: 180_000, successRate: 0.95, estimatedCostUsd: 0.2 }
    }
  });
  return { root, settings, credentials, local, providerRuntime, cloud: () => cloud };
}

const cloudConnectionId = apiCredentialConnectionId('anthropic', 'company-a-anthropic');

test('provider settings persist model routing metadata without credentials', () => {
  const root = temp('provider-settings');
  const file = path.join(root, 'providers.json');
  const store = new ProviderSettingsStore(file);
  const updated = store.update('anthropic', {
    defaultModelId: 'discovered-model',
    models: { 'discovered-model': { frontier: true, qualityScore: 91 } }
  });
  assert.equal(updated.defaultModelId, 'discovered-model');
  assert.equal(updated.models['discovered-model']?.frontier, true);
  assert.equal(updated.models['discovered-model']?.qualityScore, 91);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('sk-ant'), false);
  assert.equal(raw.includes('apiKey'), false);
});

test('Auto catalog never chooses arbitrary discovered cloud models before provider setup selects one', async () => {
  const fixture = runtimeFixture();
  const first = await fixture.providerRuntime.routingCandidates(project(), {
    stage: 'planning',
    localModelHint: 'qwen-fast'
  });
  assert.deepEqual(
    first.candidates.map((candidate) => `${candidate.providerId}/${candidate.modelId}`),
    ['ollama/qwen-fast']
  );

  fixture.settings.update('anthropic', { defaultModelId: 'cloud-fast' });
  const configured = await fixture.providerRuntime.routingCandidates(project(), {
    stage: 'planning',
    localModelHint: 'qwen-fast'
  });
  assert.deepEqual(
    configured.candidates.map((candidate) => `${candidate.providerId}/${candidate.modelId}`),
    ['ollama/qwen-fast', `${cloudConnectionId}/cloud-fast`]
  );
});

test('explicit cloud model is cataloged under its exact connection even without a provider default', async () => {
  const fixture = runtimeFixture();
  const result = await fixture.providerRuntime.routingCandidates(project(), {
    stage: 'planning',
    localModelHint: 'qwen-fast',
    modelSelection: { mode: 'explicit', providerId: cloudConnectionId, modelId: 'cloud-other' }
  });
  const cloud = result.candidates.find((candidate) => candidate.providerId === cloudConnectionId);
  assert.equal(cloud?.modelId, 'cloud-other');
  assert.equal(cloud?.available, true);
});

test('legacy local model hint remains the only local candidate for that executor attempt', async () => {
  const fixture = runtimeFixture();
  fixture.settings.update('ollama', {
    defaultModelId: 'qwen-fast',
    models: { 'qwen-fast': {}, 'qwen-strong': { qualityScore: 95 } }
  });
  const result = await fixture.providerRuntime.routingCandidates(project(), {
    stage: 'implementation',
    localModelHint: 'qwen-strong'
  });
  assert.deepEqual(
    result.candidates.filter((candidate) => candidate.providerId === 'ollama').map((candidate) => candidate.modelId),
    ['qwen-strong']
  );
});

test('strict Local-only project bypasses the provider layer and preserves legacy Ollama runtime options', async () => {
  let received: OllamaChatOptions | undefined;
  let calls = 0;
  const legacy = {
    chat: async (
      _system: string,
      _user: string,
      _format?: 'json' | Record<string, unknown>,
      runtime?: OllamaChatOptions
    ): Promise<OllamaGeneration> => {
      calls += 1;
      received = runtime;
      return { content: 'legacy', model: 'qwen-fast', promptTokens: 1, completionTokens: 1 };
    }
  };
  const localOnly = project({
    privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] },
    credentialProfileIds: {},
    defaultRoutingPolicy: 'local-first'
  });
  const client = new ProjectRoutedChatClient(
    localOnly,
    new ProjectProviderRuntime(),
    legacy
  );
  const runtime: OllamaChatOptions = {
    model: 'qwen-strong',
    numCtx: 16_384,
    keepAlive: '30s',
    think: 'low',
    maxTokens: 2048
  };

  const generation = await client.chat('system', 'user', { type: 'object' }, runtime);
  assert.equal(generation.content, 'legacy');
  assert.equal(calls, 1);
  assert.deepEqual(received, runtime);
});

test('speed-first agent chat routes directly to configured exact cloud connection without legacy/local inference', async () => {
  const fixture = runtimeFixture();
  fixture.settings.update('anthropic', {
    unlimitedUsage: true,
    defaultModelId: 'cloud-fast',
    models: { 'cloud-fast': { frontier: true, qualityScore: 92 } }
  });
  let legacyCalls = 0;
  const legacy = {
    chat: async (): Promise<OllamaGeneration> => {
      legacyCalls += 1;
      return { content: 'legacy', model: 'qwen-fast' };
    }
  };
  const routes: string[] = [];
  const client = new ProjectRoutedChatClient(
    project({ defaultRoutingPolicy: 'speed-first' }),
    fixture.providerRuntime,
    legacy,
    {
      onRoute: ({ routing }) => routes.push(`${routing.selected.providerId}/${routing.selected.modelId}`)
    }
  );

  const generation = await client.chat(
    'You are a local coding executor.',
    'Implement the bounded task.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } }
    },
    { model: 'qwen-fast', numCtx: 16_384, keepAlive: '90s' }
  );

  assert.equal(generation.model, 'cloud-fast');
  assert.equal(fixture.local.calls.length, 0);
  assert.equal(fixture.cloud()?.calls.length, 1);
  assert.equal(legacyCalls, 0);
  assert.deepEqual(routes, [`${cloudConnectionId}/cloud-fast`]);
});

test('Ollama provider receives exact namespaced local tuning when it wins routed inference', async () => {
  let options: OllamaChatOptions | undefined;
  const provider = new OllamaInferenceProvider({
    health: async () => ({
      ok: true,
      baseUrl: 'http://local',
      configuredModel: 'qwen-fast',
      modelAvailable: true,
      fastModel: 'qwen-fast',
      fastModelAvailable: true,
      strongModel: 'qwen-strong',
      strongModelAvailable: true,
      adaptiveModelsEnabled: true,
      numCtx: 16_384,
      maxParallelInferences: 1,
      globalInferenceLock: true,
      inferenceTimeouts: { headerMs: 1, firstChunkMs: 1, idleMs: 1, maxDurationMs: 1 },
      stageBudgets: {},
      availableModels: ['qwen-fast', 'qwen-strong']
    }),
    chat: async (
      _system: string,
      _user: string,
      _format?: 'json' | Record<string, unknown>,
      runtime?: OllamaChatOptions
    ) => {
      options = runtime;
      return { content: 'ok', model: runtime?.model ?? 'qwen-fast' };
    }
  });

  await provider.invoke({
    model: 'qwen-strong',
    systemPrompt: 'system',
    userPrompt: 'user',
    providerOptions: {
      ollama: { numCtx: 32_768, keepAlive: '45s', think: 'medium' }
    },
    maxOutputTokens: 3000,
    timeoutMs: 9999
  });

  assert.equal(options?.model, 'qwen-strong');
  assert.equal(options?.numCtx, 32_768);
  assert.equal(options?.keepAlive, '45s');
  assert.equal(options?.think, 'medium');
  assert.equal(options?.maxTokens, 3000);
  assert.equal(options?.maxDurationMs, 9999);
});
