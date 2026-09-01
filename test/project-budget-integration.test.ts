import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, type LocalCoderConfig } from '../src/config.js';
import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import type { LocalEngineerExecution, LocalEngineerInput, LocalEngineerResult } from '../src/local-engineer.js';
import type { OllamaClient } from '../src/ollama.js';
import { PricingStore } from '../src/pricing-store.js';
import { ProjectBudgetSession } from '../src/project-budget.js';
import { ProjectAwareEngineerBackend, type ProjectEngineerResult } from '../src/project-engineer-backend.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import { ProjectStore } from '../src/project-store.js';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderCapabilities,
  ProviderHealth
} from '../src/providers/types.js';
import type { SecretStore } from '../src/secret-store.js';
import { UsageLedger } from '../src/usage-ledger.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
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

class CloudProvider implements InferenceProvider {
  readonly id = 'anthropic';
  readonly kind = 'cloud' as const;
  readonly capabilities = capabilities;
  calls = 0;

  async listModels(): Promise<ModelDefinition[]> {
    return [{
      providerId: this.id,
      id: 'cloud-model',
      displayName: 'Cloud Model',
      capabilities
    }];
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      modelsAvailable: 1
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    this.calls += 1;
    return {
      providerId: this.id,
      // Providers may resolve a stable configured alias to a dated concrete model.
      model: 'cloud-model-20260831',
      content: '{"ok":true}',
      latencyMs: 25,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    };
  }
}

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-budget-integration-'));
}

function config(root: string): LocalCoderConfig {
  return {
    ...loadConfig({
      LOCAL_CODER_EXECUTION_MODE: 'local',
      LOCAL_CODER_MODEL: 'qwen3.8:27b',
      LOCAL_CODER_STRONG_MODEL: 'qwen3.8:27b'
    }),
    telemetryEnabled: false,
    telemetryPath: path.join(root, 'telemetry.jsonl'),
    contextIndexPath: path.join(root, 'indexes'),
    runStorePath: path.join(root, 'runs'),
    workerStatePath: path.join(root, 'worker')
  };
}

function success(workspace: string, goal: string, model: string): LocalEngineerResult {
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

test('Project agent returns the same priced usage persisted in its ledger', async () => {
  const root = temp();
  const workspace = path.join(root, 'repo');
  fs.mkdirSync(workspace);
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const project = projects.create({
    id: 'budgeted-cloud-project',
    name: 'Budgeted Cloud Project',
    workspace,
    organizationId: 'company-a',
    defaultRoutingPolicy: 'speed-first',
    defaultModel: { mode: 'explicit', providerId: 'anthropic', modelId: 'cloud-model' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] },
    credentialProfileIds: { anthropic: 'company-a-anthropic' },
    budgets: { dailyUsd: 1, monthlyUsd: 10, perJobUsd: 0.5 }
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
    secret: 'secret'
  });
  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  settings.update('anthropic', {
    unlimitedUsage: true,
    defaultModelId: 'cloud-model',
    models: { 'cloud-model': { frontier: true, qualityScore: 95 } }
  });
  const pricing = new PricingStore(path.join(root, 'pricing.json'));
  pricing.set('anthropic', 'cloud-model', {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 2,
    source: 'integration-price-sheet',
    verifiedAt: '2026-08-31T00:00:00.000Z'
  });
  const ledger = new UsageLedger(path.join(root, 'usage'));
  const cloud = new CloudProvider();

  const agentExecutor = async (
    model: Pick<OllamaClient, 'chat'>,
    _config: LocalCoderConfig,
    input: LocalEngineerInput
  ): Promise<LocalEngineerExecution> => {
    const generation = await model.chat(
      'You are the reasoning/planning stage of a local software-engineering agent.',
      '# GOAL\nverify budget integration',
      undefined,
      { maxTokens: 100, think: 'medium' }
    );
    return { result: success(input.workspace, input.goal, generation.model), changes: [] };
  };

  const backend = new ProjectAwareEngineerBackend(
    config(root),
    {} as OllamaClient,
    { executeEngineer: async (input) => success(input.workspace, input.goal, 'legacy') },
    {
      projects,
      agentExecutor,
      providerRuntime: {
        credentials,
        settings,
        cloudProviderFactories: { anthropic: () => cloud }
      },
      budgetSessionFactory: (definition) => new ProjectBudgetSession(
        definition,
        pricing,
        ledger,
        { jobId: 'budget-integration-job', now: () => new Date('2026-08-31T12:00:00.000Z') }
      )
    }
  );

  const result = await backend.executeEngineer({
    projectId: project.id,
    workspace,
    goal: 'use cloud safely'
  }) as ProjectEngineerResult;
  assert.equal(cloud.calls, 1);
  assert.equal(result.projectExecution?.routingTrace[0]?.providerId, 'anthropic');
  assert.equal(result.projectExecution?.routingTrace[0]?.modelId, 'cloud-model');
  assert.equal(result.modelCalls[0]?.model, 'cloud-model-20260831');

  const budget = result.projectExecution?.budget;
  assert.ok(budget);
  assert.equal(budget.jobId, 'budget-integration-job');
  assert.equal(budget.jobKnownCostUsd, 0.00014);
  assert.equal(budget.jobUnknownCostEvents, 0);
  assert.equal(budget.daily.cloudEvents, 1);
  assert.equal(budget.daily.knownCostUsd, 0.00014);
  assert.equal(budget.dailyReservedUpperBoundUsd, 0);

  const events = ledger.list(project.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.jobId, budget.jobId);
  assert.equal(events[0]?.modelId, 'cloud-model');
  assert.equal(events[0]?.costUsd, budget.jobKnownCostUsd);
  assert.equal(events[0]?.pricingSource, 'integration-price-sheet');
});
