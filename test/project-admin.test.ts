import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CredentialManager,
  CredentialProfileStore
} from '../src/credential-store.js';
import { PricingStore } from '../src/pricing-store.js';
import { ProjectAdminService } from '../src/project-admin.js';
import { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import { ProjectStore } from '../src/project-store.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
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

class MemoryEnvironmentStore implements SecretStore {
  readonly backend = 'environment' as const;
  readonly values = new Map<string, string>();
  isAvailable(): boolean { return true; }
  get(id: string): string | undefined { return this.values.get(id); }
  set(id: string, value: string): void { this.values.set(id, value); }
  delete(id: string): boolean { return this.values.delete(id); }
}

class FakeProvider implements InferenceProvider {
  readonly capabilities = capabilities;

  constructor(
    readonly id: string,
    readonly kind: ProviderKind,
    private readonly models: string[]
  ) {}

  async listModels(): Promise<ModelDefinition[]> {
    return this.models.map((id, index) => ({
      providerId: this.id,
      id,
      displayName: `${id} display`,
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
      modelsAvailable: this.models.length
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    return {
      providerId: this.id,
      model: request.model,
      content: 'ok',
      latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    };
  }
}

function temp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-project-admin-'));
}

function fixture() {
  const root = temp();
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const keychain = new MemorySecretStore();
  const environment = new MemoryEnvironmentStore();
  const credentials = new CredentialManager(
    new CredentialProfileStore(path.join(root, 'credentials.json')),
    { keychain, environment }
  );
  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  const pricing = new PricingStore(path.join(root, 'pricing.json'));
  const ledger = new UsageLedger(path.join(root, 'usage'));
  const local = new FakeProvider('ollama', 'local', ['qwen-local']);
  const cloud = new FakeProvider('anthropic', 'cloud', ['claude-cloud']);
  const providerRuntime = new ProjectProviderRuntime({
    localProvider: local,
    credentials,
    settings,
    cloudProviderFactories: { anthropic: () => cloud }
  });
  const admin = new ProjectAdminService({
    projects,
    credentials,
    providerSettings: settings,
    pricing,
    ledger,
    localProvider: local,
    providerRuntime
  });
  return { root, projects, keychain, environment, credentials, settings, pricing, ledger, local, cloud, admin };
}

test('admin credential views never expose secrets and enforce organization isolation', () => {
  const f = fixture();
  const credential = f.admin.createCredential({
    backend: 'macos-keychain',
    id: 'company-a-anthropic',
    providerId: 'anthropic',
    label: 'Company A Anthropic',
    organizationId: 'company-a',
    secret: 'super-secret-value'
  });

  assert.equal(credential.available, true);
  assert.equal('secret' in credential, false);
  const serialized = JSON.stringify(f.admin.listCredentials());
  assert.equal(serialized.includes('super-secret-value'), false);
  assert.equal(serialized.includes('local-coder-mcp/provider/anthropic'), false);

  assert.throws(
    () => f.admin.createProject({
      id: 'company-b-project',
      name: 'Company B Project',
      workspace: path.join(f.root, 'repo-b'),
      organizationId: 'company-b',
      privacy: { cloudAllowed: true, allowedProviderIds: ['anthropic'] },
      credentialProfileIds: { anthropic: 'company-a-anthropic' }
    }),
    /outside project .* organization isolation boundary/
  );
  assert.equal(f.admin.listProjects().length, 0);
});

test('referenced credentials cannot be deleted until the Project binding is removed', () => {
  const f = fixture();
  f.admin.createCredential({
    backend: 'macos-keychain',
    id: 'company-a-anthropic',
    providerId: 'anthropic',
    label: 'Company A Anthropic',
    organizationId: 'company-a',
    secret: 'secret'
  });
  f.admin.createProject({
    id: 'company-a-project',
    name: 'Company A Project',
    workspace: path.join(f.root, 'repo-a'),
    organizationId: 'company-a',
    privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic'] },
    credentialProfileIds: { anthropic: 'company-a-anthropic' }
  });

  assert.throws(
    () => f.admin.removeCredential('company-a-anthropic'),
    /still referenced by Project\(s\): company-a-project/
  );
  f.admin.updateProject('company-a-project', { credentialProfileIds: {} });
  assert.equal(f.admin.removeCredential('company-a-anthropic'), true);
  assert.equal(f.keychain.values.size, 0);
});

test('project catalog combines actual provider discovery, routing settings and pricing', async () => {
  const f = fixture();
  f.admin.createCredential({
    backend: 'macos-keychain',
    id: 'company-a-anthropic',
    providerId: 'anthropic',
    label: 'Company A Anthropic',
    organizationId: 'company-a',
    secret: 'secret'
  });
  f.admin.updateProvider('anthropic', {
    defaultModelId: 'claude-cloud',
    models: { 'claude-cloud': { frontier: true, qualityScore: 97 } }
  });
  await f.admin.setPricing('anthropic', 'claude-cloud', {
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 15,
    source: 'provider-price-sheet',
    verifiedAt: '2026-08-31T00:00:00.000Z'
  });
  f.admin.createProject({
    id: 'company-a-project',
    name: 'Company A Project',
    workspace: path.join(f.root, 'repo-a'),
    organizationId: 'company-a',
    defaultRoutingPolicy: 'balanced',
    defaultModel: { mode: 'explicit', providerId: 'anthropic', modelId: 'claude-cloud' },
    privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic'] },
    credentialProfileIds: { anthropic: 'company-a-anthropic' },
    budgets: { dailyUsd: 2, monthlyUsd: 20, perJobUsd: 0.5 }
  });

  const catalog = await f.admin.catalog('company-a-project');
  assert.equal(catalog.providers.length, 2);
  const local = catalog.providers.find((provider) => provider.id === 'ollama');
  assert.equal(local?.kind, 'local');
  assert.equal(local?.ready, true);
  assert.equal(local?.models[0]?.id, 'qwen-local');
  assert.equal(local?.models[0]?.available, true);

  const cloud = catalog.providers.find((provider) => provider.id === 'anthropic');
  assert.equal(cloud?.kind, 'cloud');
  assert.equal(cloud?.ready, true);
  assert.equal(cloud?.credentialAvailable, true);
  const cloudModel = cloud?.models.find((model) => model.id === 'claude-cloud');
  assert.equal(cloudModel?.available, true);
  assert.equal(cloudModel?.providerDefault, true);
  assert.equal(cloudModel?.projectDefault, true);
  assert.equal(cloudModel?.routing.frontier, true);
  assert.equal(cloudModel?.routing.qualityScore, 97);
  assert.equal(cloudModel?.pricing?.outputPerMillionUsd, 15);
});

test('project usage returns daily/monthly spend plus active budget reservations', () => {
  const f = fixture();
  f.admin.createProject({
    id: 'usage-project',
    name: 'Usage Project',
    workspace: path.join(f.root, 'repo'),
    organizationId: 'personal',
    privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] },
    budgets: { dailyUsd: 1, monthlyUsd: 5, perJobUsd: 0.5 }
  });
  f.ledger.append({
    id: 'usage-event',
    jobId: 'job-one',
    timestamp: '2026-08-31T12:00:00.000Z',
    projectId: 'usage-project',
    organizationId: 'personal',
    stage: 'planning',
    providerId: 'ollama',
    providerKind: 'local',
    modelId: 'qwen-local',
    usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    latencyMs: 10,
    costUsd: 0,
    fallbackUsed: false
  });
  f.ledger.reserve({
    id: 'reservation-one',
    jobId: 'job-two',
    timestamp: '2026-08-31T12:05:00.000Z',
    expiresAt: '2026-08-31T13:05:00.000Z',
    projectId: 'usage-project',
    organizationId: 'personal',
    providerId: 'anthropic',
    modelId: 'cloud-model',
    upperBoundCostUsd: 0.125
  });

  const usage = f.admin.usage('usage-project', new Date('2026-08-31T12:30:00.000Z'));
  assert.equal(usage.daily.events, 1);
  assert.equal(usage.monthly.events, 1);
  assert.equal(usage.daily.inputTokens, 100);
  assert.equal(usage.activeReservations.count, 1);
  assert.equal(usage.activeReservations.upperBoundUsd, 0.125);
  assert.equal(usage.budgets.perJobUsd, 0.5);
});
