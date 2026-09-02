import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apiCredentialConnectionId } from '../src/connection-identity.js';
import { loadConfig, type LocalCoderConfig } from '../src/config.js';
import {
  CredentialManager,
  CredentialProfileStore
} from '../src/credential-store.js';
import type {
  LocalEngineerExecution,
  LocalEngineerInput,
  LocalEngineerResult
} from '../src/local-engineer.js';
import type { OllamaClient, OllamaGeneration } from '../src/ollama.js';
import {
  ProjectAwareEngineerBackend,
  type ProjectEngineerResult
} from '../src/project-engineer-backend.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import { ProjectStore, projectIsolationKey } from '../src/project-store.js';
import { AutoLocalInferenceProvider } from '../src/providers/auto-local-provider.js';
import {
  ProviderError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDefinition,
  type ProviderCapabilities,
  type ProviderHealth
} from '../src/providers/types.js';
import type { SecretStore } from '../src/secret-store.js';
import type { RemoteWorkerHealth } from '../src/remote-protocol.js';

const caps: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

class MemorySecretStore implements SecretStore {
  readonly backend = 'macos-keychain' as const;
  readonly values = new Map<string, string>();
  isAvailable(): boolean { return true; }
  get(id: string): string | undefined { return this.values.get(id); }
  set(id: string, value: string): void { this.values.set(id, value); }
  delete(id: string): boolean { return this.values.delete(id); }
}

function temp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-coder-${name}-`));
}

function config(root: string, mode: 'local' | 'remote' | 'auto'): LocalCoderConfig {
  return {
    ...loadConfig({
      LOCAL_CODER_EXECUTION_MODE: mode,
      LOCAL_CODER_MODEL: 'qwen3.8:27b',
      LOCAL_CODER_STRONG_MODEL: 'qwen3.8:27b',
      ...(mode === 'local' ? {} : {
        LOCAL_CODER_REMOTE_WORKER_URL: 'http://windows-worker:7337',
        LOCAL_CODER_REMOTE_WORKER_TOKEN: 'worker-token'
      })
    }),
    telemetryEnabled: false,
    telemetryPath: path.join(root, 'telemetry.jsonl'),
    contextIndexPath: path.join(root, 'indexes'),
    runStorePath: path.join(root, 'runs'),
    workerStatePath: path.join(root, 'worker')
  };
}

function workerHealth(): RemoteWorkerHealth {
  return {
    protocolVersion: 1,
    workerVersion: '0.14.0',
    ok: true,
    hostname: 'windows-worker',
    platform: 'win32',
    model: 'qwen3.8:27b',
    bootstrap: 'none',
    ollama: {}
  };
}

function successResult(workspace: string, goal: string, model = 'test-model'): LocalEngineerResult {
  return {
    status: 'success',
    phase: 'complete',
    workspace,
    goal,
    summary: 'done',
    investigation: { searchQueries: [], evidenceFiles: [], researchRequests: [] },
    repairRounds: 0,
    changedFiles: [],
    diff: '',
    validation: [],
    modelCalls: [{ stage: 'planning', model }]
  };
}

function fakeAgent(
  capture: { repoMemoryScopeKey?: string; calls: number }
) {
  return async (
    model: Pick<OllamaClient, 'chat'>,
    _config: LocalCoderConfig,
    input: LocalEngineerInput & { repoMemoryScopeKey?: string }
  ): Promise<LocalEngineerExecution> => {
    capture.calls += 1;
    capture.repoMemoryScopeKey = input.repoMemoryScopeKey;
    const generation = await model.chat(
      'You are the reasoning/planning stage of a local software-engineering agent.',
      '# GOAL\nroute this project job',
      {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } }
      },
      { model: 'qwen3.8:27b', think: 'medium', numCtx: 16_384, keepAlive: '90s' }
    );
    return { result: successResult(input.workspace, input.goal, generation.model), changes: [] };
  };
}

class FakeProvider implements InferenceProvider {
  readonly capabilities = caps;
  constructor(
    readonly id: string,
    readonly kind: 'local' | 'cloud',
    private readonly modelId: string,
    private readonly invokeFn: (request: InferenceRequest) => Promise<InferenceResult>
  ) {}
  async listModels(): Promise<ModelDefinition[]> {
    return [{ providerId: this.id, id: this.modelId, displayName: this.modelId, capabilities: caps }];
  }
  async health(): Promise<ProviderHealth> {
    return { providerId: this.id, ok: true, checkedAt: new Date().toISOString(), latencyMs: 1, modelsAvailable: 1 };
  }
  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    return await this.invokeFn(request);
  }
}

test('unregistered workspace keeps the exact legacy engineer backend', async () => {
  const root = temp('project-agent-legacy');
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace);
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  let legacyCalls = 0;
  const legacy = {
    executeEngineer: async (input: LocalEngineerInput) => {
      legacyCalls += 1;
      return successResult(input.workspace, input.goal, 'legacy');
    }
  };
  const agentCapture = { calls: 0 };
  const backend = new ProjectAwareEngineerBackend(
    config(root, 'remote'),
    {} as OllamaClient,
    legacy,
    { projects, agentExecutor: fakeAgent(agentCapture) }
  );

  const result = await backend.executeEngineer({ workspace, goal: 'legacy please' });
  assert.equal(legacyCalls, 1);
  assert.equal(agentCapture.calls, 0);
  assert.equal(result.modelCalls[0]?.model, 'legacy');
  assert.equal((result as ProjectEngineerResult).projectExecution, undefined);
});

test('registered speed-first Project invokes cloud directly from desktop app agent', async () => {
  const root = temp('project-agent-cloud');
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace);
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const project = projects.create({
    id: 'company-a-app',
    name: 'Company A App',
    workspace,
    organizationId: 'company-a',
    defaultRoutingPolicy: 'speed-first',
    privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic'] },
    credentialProfileIds: { anthropic: 'company-a-anthropic' }
  });

  const keychain = new MemorySecretStore();
  const credentials = new CredentialManager(
    new CredentialProfileStore(path.join(root, 'credentials.json')),
    { keychain }
  );
  credentials.addOrReplaceKeychainCredential({
    id: 'company-a-anthropic',
    providerId: 'anthropic',
    label: 'Company A Anthropic',
    organizationId: 'company-a',
    secret: 'cloud-secret'
  });
  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  settings.update('anthropic', {
    unlimitedUsage: true,
    defaultModelId: 'cloud-fast',
    models: { 'cloud-fast': { frontier: true, qualityScore: 95 } }
  });

  let remoteChatCalls = 0;
  let cloudCalls = 0;
  let cloudSecret: string | undefined;
  const remoteClient = {
    health: async () => workerHealth(),
    chat: async (): Promise<OllamaGeneration> => {
      remoteChatCalls += 1;
      return { content: '{"ok":true}', model: 'qwen3.8:27b' };
    }
  };
  const agentCapture = { calls: 0, repoMemoryScopeKey: undefined as string | undefined };
  const backend = new ProjectAwareEngineerBackend(
    config(root, 'remote'),
    {} as OllamaClient,
    { executeEngineer: async (input) => successResult(input.workspace, input.goal, 'legacy') },
    {
      projects,
      credentials: undefined,
      remoteClient,
      agentExecutor: fakeAgent(agentCapture),
      providerRuntime: {
        credentials,
        settings,
        cloudProviderFactories: {
          anthropic: (apiKey) => {
            cloudSecret = apiKey;
            return new FakeProvider('anthropic', 'cloud', 'cloud-fast', async (request) => {
              cloudCalls += 1;
              return {
                providerId: 'anthropic',
                model: request.model,
                content: '{"ok":true}',
                latencyMs: 20,
                usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 }
              };
            });
          }
        },
        metrics: {
          get: async (_projectId, _stage, providerId) => providerId === 'anthropic'
            ? { queueDelayMs: 0, p50LatencyMs: 1_000, qualityScore: undefined, estimatedCostUsd: 0.02 }
            : { queueDelayMs: 600_000, p50LatencyMs: 900_000, estimatedCostUsd: 0 }
        }
      }
    } as never
  );

  const result = await backend.executeEngineer({ projectId: project.id, workspace, goal: 'ship quickly' }) as ProjectEngineerResult;
  assert.equal(agentCapture.calls, 1);
  assert.equal(agentCapture.repoMemoryScopeKey, projectIsolationKey(project));
  assert.equal(cloudSecret, 'cloud-secret');
  assert.equal(cloudCalls, 1);
  assert.equal(remoteChatCalls, 0);
  assert.equal(result.projectExecution?.agentHost, 'desktop-app');
  assert.equal(result.projectExecution?.projectId, project.id);
  assert.equal(result.projectExecution?.routingTrace[0]?.stage, 'planning');
  assert.equal(
    result.projectExecution?.routingTrace[0]?.providerId,
    apiCredentialConnectionId('anthropic', 'company-a-anthropic')
  );
  assert.equal(result.projectExecution?.routingTrace[0]?.fallbackUsed, false);
});

test('registered Local-only Project runs desktop app agent with Qwen chat on Windows worker', async () => {
  const root = temp('project-agent-worker');
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace);
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const project = projects.create({
    id: 'local-app',
    name: 'Local App',
    workspace,
    organizationId: 'personal',
    privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] }
  });
  let remoteChatCalls = 0;
  const remoteClient = {
    health: async () => workerHealth(),
    chat: async (): Promise<OllamaGeneration> => {
      remoteChatCalls += 1;
      return { content: '{"ok":true}', model: 'qwen3.8:27b', promptTokens: 5, completionTokens: 2 };
    }
  };
  const agentCapture = { calls: 0, repoMemoryScopeKey: undefined as string | undefined };
  const backend = new ProjectAwareEngineerBackend(
    config(root, 'remote'),
    {} as OllamaClient,
    { executeEngineer: async (input) => successResult(input.workspace, input.goal, 'legacy') },
    { projects, remoteClient, agentExecutor: fakeAgent(agentCapture) }
  );

  const result = await backend.executeEngineer({ projectId: project.id, workspace, goal: 'stay local' }) as ProjectEngineerResult;
  assert.equal(agentCapture.calls, 1);
  assert.equal(remoteChatCalls, 1);
  assert.equal(agentCapture.repoMemoryScopeKey, projectIsolationKey(project));
  assert.equal(result.modelCalls[0]?.model, 'qwen3.8:27b');
  assert.equal(result.projectExecution?.agentHost, 'desktop-app');
  assert.equal(result.projectExecution?.localInference, 'windows-worker');
  assert.deepEqual(result.projectExecution?.routingTrace, []);
});

test('explicit Project id cannot be used against a different workspace', async () => {
  const root = temp('project-agent-isolation');
  const workspaceA = path.join(root, 'a');
  const workspaceB = path.join(root, 'b');
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  projects.create({
    id: 'project-a',
    name: 'A',
    workspace: workspaceA,
    organizationId: 'company-a'
  });
  const backend = new ProjectAwareEngineerBackend(
    config(root, 'local'),
    {} as OllamaClient,
    { executeEngineer: async (input) => successResult(input.workspace, input.goal, 'legacy') },
    { projects, agentExecutor: fakeAgent({ calls: 0 }) }
  );

  await assert.rejects(
    backend.executeEngineer({ projectId: 'project-a', workspace: workspaceB, goal: 'cross boundary' }),
    /defaults to .* refusing workspace/
  );
});

test('auto local provider uses Mac Ollama when Windows worker discovery is unavailable', async () => {
  let fallbackCalls = 0;
  const preferred = new FakeProvider('ollama', 'local', 'qwen3.8:27b', async () => {
    throw new ProviderError('ollama', 'worker down', { retryable: true });
  });
  preferred.listModels = async () => {
    throw new ProviderError('ollama', 'worker down', { retryable: true });
  };
  const fallback = new FakeProvider('ollama', 'local', 'qwen3.8:27b', async (request) => {
    fallbackCalls += 1;
    return {
      providerId: 'ollama',
      model: request.model,
      content: 'mac',
      latencyMs: 1,
      usage: {}
    };
  });
  const auto = new AutoLocalInferenceProvider(preferred, fallback);

  const models = await auto.listModels();
  assert.equal(models[0]?.id, 'qwen3.8:27b');
  assert.equal(models[0]?.metadata?.autoLocalSource, 'mac-ollama');
  const result = await auto.invoke({ model: 'qwen3.8:27b', systemPrompt: 's', userPrompt: 'u' });
  assert.equal(result.content, 'mac');
  assert.equal(fallbackCalls, 1);
});
