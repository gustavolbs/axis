import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ClaudeAccountProfileStore } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore } from '../src/codex-account-profiles.js';
import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import { PricingStore } from '../src/pricing-store.js';
import { ProjectAdminService } from '../src/project-admin.js';
import { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import { ProviderConnectionRuntime, apiCredentialConnectionId } from '../src/provider-connections.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import { ProjectStore } from '../src/project-store.js';
import type { InferenceProvider, ProviderCapabilities } from '../src/providers/types.js';
import type { SecretStore } from '../src/secret-store.js';
import { UsageLedger } from '../src/usage-ledger.js';
import { WorkHubSourceStore } from '../src/work-hub.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: true
};

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

class MemorySecretStore implements SecretStore {
  readonly backend = 'macos-keychain' as const;
  readonly values = new Map<string, string>();
  isAvailable(): boolean { return true; }
  get(id: string): string | undefined { return this.values.get(id); }
  set(id: string, value: string): void { this.values.set(id, value); }
  delete(id: string): boolean { return this.values.delete(id); }
}

function fakeOpenAI(_apiKey: string): InferenceProvider {
  return {
    id: 'openai',
    kind: 'cloud',
    capabilities,
    async listModels() {
      return [{ providerId: 'openai', id: 'gpt-test', displayName: 'GPT Test', capabilities }];
    },
    async health() {
      return { providerId: 'openai', ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0, modelsAvailable: 1 };
    },
    async invoke(request) {
      return { providerId: 'openai', model: request.model, content: 'ok', latencyMs: 0, usage: {} };
    }
  };
}

test('Projects inherit Chat and Cowork Connections from Context without leaking sibling Companies', async () => {
  const root = temp('axis-project-context-connections-');
  const secrets = new MemorySecretStore();
  const credentials = new CredentialManager(
    new CredentialProfileStore(path.join(root, 'credentials.json')),
    { keychain: secrets }
  );
  credentials.addOrReplaceKeychainCredential({ id: 'personal-openai', providerId: 'openai', label: 'Personal OpenAI', secret: 'personal-secret' });
  credentials.addOrReplaceKeychainCredential({ id: 'acme-openai', providerId: 'openai', label: 'Acme OpenAI', organizationId: 'acme', secret: 'acme-secret' });
  credentials.addOrReplaceKeychainCredential({ id: 'other-openai', providerId: 'openai', label: 'Other OpenAI', organizationId: 'other', secret: 'other-secret' });

  const settings = new ProviderSettingsStore(path.join(root, 'providers.json'));
  const connections = new ProviderConnectionRuntime({
    credentials,
    settings,
    claudeProfiles: new ClaudeAccountProfileStore(path.join(root, 'claude')),
    codexProfiles: new CodexAccountProfileStore(path.join(root, 'codex')),
    apiProviderFactories: { openai: fakeOpenAI }
  });
  const providerRuntime = new ProjectProviderRuntime({
    credentials,
    settings,
    connections,
    cloudProviderFactories: { openai: fakeOpenAI }
  });
  const projects = new ProjectStore(path.join(root, 'projects.json'));
  const personalProject = projects.create({ id: 'personal-project', name: 'Personal Project', organizationId: 'personal' });
  const acmeProject = projects.create({ id: 'acme-project', name: 'Acme Project', organizationId: 'acme' });
  const admin = new ProjectAdminService({
    projects,
    credentials,
    providerSettings: settings,
    pricing: new PricingStore(path.join(root, 'pricing.json')),
    ledger: new UsageLedger(path.join(root, 'usage-ledger')),
    connections,
    providerRuntime,
    workHubSources: new WorkHubSourceStore(path.join(root, 'work-hub'))
  });

  const personalId = apiCredentialConnectionId('openai', 'personal-openai');
  const acmeId = apiCredentialConnectionId('openai', 'acme-openai');
  const otherId = apiCredentialConnectionId('openai', 'other-openai');

  assert.deepEqual(personalProject.connectionPolicy?.inference.allowedConnectionIds, ['ollama']);
  assert.deepEqual(acmeProject.connectionPolicy?.inference.allowedConnectionIds, ['ollama']);

  const personalCatalog = await admin.catalog(personalProject.id);
  assert.ok(personalCatalog.providers.some((provider) => provider.id === personalId && provider.ready));
  assert.ok(personalCatalog.connectionPolicy.chat.allowedConnectionIds.includes(personalId));
  assert.ok(personalCatalog.connectionPolicy.inference.allowedConnectionIds.includes(personalId));
  assert.equal(personalCatalog.providers.some((provider) => provider.id === acmeId), false);
  assert.equal(personalCatalog.providers.some((provider) => provider.id === otherId), false);

  const acmeCatalog = await admin.catalog(acmeProject.id);
  assert.ok(acmeCatalog.providers.some((provider) => provider.id === personalId && provider.ready));
  assert.ok(acmeCatalog.providers.some((provider) => provider.id === acmeId && provider.ready));
  assert.equal(acmeCatalog.providers.some((provider) => provider.id === otherId), false);
  assert.ok(acmeCatalog.connectionPolicy.chat.allowedConnectionIds.includes(personalId));
  assert.ok(acmeCatalog.connectionPolicy.chat.allowedConnectionIds.includes(acmeId));
  assert.ok(acmeCatalog.connectionPolicy.inference.allowedConnectionIds.includes(personalId));
  assert.ok(acmeCatalog.connectionPolicy.inference.allowedConnectionIds.includes(acmeId));

  const direct = await providerRuntime.modelDefinition(personalProject, personalId, 'gpt-test');
  assert.equal(direct?.model.id, 'gpt-test');

  const routed = await providerRuntime.routingCandidates(acmeProject, {
    stage: 'implementation',
    connectionScope: 'cowork',
    modelSelection: { mode: 'explicit', providerId: personalId, modelId: 'gpt-test' }
  });
  assert.ok(routed.candidates.some((candidate) =>
    candidate.providerId === personalId && candidate.modelId === 'gpt-test' && candidate.available
  ));
  assert.equal(routed.candidates.some((candidate) => candidate.providerId === otherId), false);
});
