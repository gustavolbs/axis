import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CredentialManager,
  CredentialProfileStore
} from '../src/credential-store.js';
import { ProjectProviderRuntime } from '../src/project-provider-runtime.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import type {
  InferenceProvider,
  ModelDefinition,
  ProviderCapabilities
} from '../src/providers/types.js';
import type { SecretStore } from '../src/secret-store.js';

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-coder-personal-chat-${name}-`));
}

function lf(source: string): string {
  return source.replace(/\r\n/g, '\n');
}

class MemorySecretStore implements SecretStore {
  readonly backend = 'macos-keychain' as const;
  readonly values = new Map<string, string>();

  isAvailable(): boolean { return true; }
  get(id: string): string | undefined { return this.values.get(id); }
  set(id: string, value: string): void { this.values.set(id, value); }
  delete(id: string): boolean { return this.values.delete(id); }
}

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
};

function cloudFactory(
  providerId: string,
  models: ModelDefinition[],
  secrets: string[]
): (apiKey: string) => InferenceProvider {
  return (apiKey) => {
    secrets.push(apiKey);
    return {
      id: providerId,
      kind: 'cloud',
      capabilities,
      async listModels() { return models; },
      async health() {
        return {
          providerId,
          ok: true,
          checkedAt: new Date(0).toISOString(),
          latencyMs: 1,
          modelsAvailable: models.length
        };
      },
      async invoke(request) {
        return {
          providerId,
          model: request.model,
          content: 'ok',
          latencyMs: 1,
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
        };
      }
    };
  };
}

const openAiModels: ModelDefinition[] = [
  {
    providerId: 'openai',
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    createdAt: '2026-08-30T00:00:00.000Z',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000
  },
  {
    providerId: 'openai',
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    createdAt: '2026-08-29T00:00:00.000Z'
  },
  {
    providerId: 'openai',
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    createdAt: '2026-08-28T00:00:00.000Z'
  },
  {
    providerId: 'openai',
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    createdAt: '2026-07-02T00:00:00.000Z'
  },
  {
    providerId: 'openai',
    id: 'gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    createdAt: '2026-07-01T00:00:00.000Z',
    contextWindow: 400_000,
    maxOutputTokens: 64_000
  },
  { providerId: 'openai', id: 'gpt-5.5-pro-2026-04-23', displayName: 'Old snapshot' },
  { providerId: 'openai', id: 'gpt-4.1', displayName: 'GPT-4.1' },
  {
    providerId: 'openai',
    id: 'text-embedding-3-large',
    displayName: 'text-embedding-3-large'
  }
];

const anthropicModels: ModelDefinition[] = [
  {
    providerId: 'anthropic',
    id: 'claude-fable-5', displayName: 'Claude Fable 5',
    createdAt: '2026-06-09T00:00:00.000Z', contextWindow: 1_000_000, maxOutputTokens: 128_000
  },
  {
    providerId: 'anthropic', id: 'claude-opus-5', displayName: 'Claude Opus 5',
    createdAt: '2026-07-24T00:00:00.000Z', contextWindow: 1_000_000, maxOutputTokens: 128_000
  },
  {
    providerId: 'anthropic', id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5',
    createdAt: '2026-06-30T00:00:00.000Z', contextWindow: 1_000_000, maxOutputTokens: 128_000
  },
  {
    providerId: 'anthropic', id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5',
    createdAt: '2025-10-01T00:00:00.000Z', contextWindow: 200_000, maxOutputTokens: 64_000
  },
  {
    providerId: 'anthropic', id: 'claude-opus-4-1', displayName: 'Claude Opus 4.1',
    createdAt: '2025-08-01T00:00:00.000Z', contextWindow: 200_000, maxOutputTokens: 32_000
  }
];

function runtimeFixture(extraFactories: Record<string, (apiKey: string) => InferenceProvider> = {}) {
  const dir = tempDir('runtime');
  const keychain = new MemorySecretStore();
  const credentials = new CredentialManager(
    new CredentialProfileStore(path.join(dir, 'credentials.json')),
    { keychain }
  );
  const settings = new ProviderSettingsStore(path.join(dir, 'providers.json'));
  const openAiSecrets: string[] = [];
  const anthropicSecrets: string[] = [];
  const runtime = new ProjectProviderRuntime({
    credentials,
    settings,
    cloudProviderFactories: {
      openai: cloudFactory('openai', openAiModels, openAiSecrets),
      anthropic: cloudFactory('anthropic', anthropicModels, anthropicSecrets),
      ...extraFactories
    }
  });
  return { credentials, keychain, runtime, openAiSecrets, anthropicSecrets };
}

test('personal Chat discovers an available personal OpenAI credential and only conversational models', async () => {
  const { credentials, runtime, openAiSecrets } = runtimeFixture();
  credentials.addOrReplaceKeychainCredential({
    id: 'personal-openai',
    providerId: 'openai',
    label: 'Personal OpenAI',
    secret: 'sk-personal-test-value'
  });

  const catalog = await runtime.personalChatCatalog();
  const openai = catalog.providers.find((provider) => provider.id === 'openai');
  assert.ok(openai);
  assert.equal(openai.ready, true);
  assert.deepEqual(openai.models.map((model) => model.id), [
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-5.5-pro'
  ]);
  assert.equal(openai.models.some((model) => model.id.includes('embedding')), false);
  assert.equal(openai.models[0]?.contextWindow, 1_050_000);
  assert.equal(openAiSecrets.includes('sk-personal-test-value'), true);

  const resolved = await runtime.personalModelDefinition('openai', 'gpt-5.6-sol');
  assert.equal(resolved.provider.id, 'openai');
  assert.equal(resolved.model.id, 'gpt-5.6-sol');
  assert.equal(resolved.model.maxOutputTokens, 128_000);
});

test('personal Chat accepts a newly discovered OpenAI conversational model without a code update', async () => {
  const futureModel: ModelDefinition = {
    providerId: 'openai',
    id: 'gpt-6-nova',
    displayName: 'GPT-6 Nova',
    createdAt: '2027-01-01T00:00:00.000Z'
  };
  const { credentials, runtime } = runtimeFixture({
    openai: cloudFactory('openai', [...openAiModels, futureModel], [])
  });
  credentials.addOrReplaceKeychainCredential({
    id: 'personal-openai',
    providerId: 'openai',
    label: 'Personal OpenAI',
    secret: 'sk-personal-test-value'
  });

  const catalog = await runtime.personalChatCatalog();
  const openai = catalog.providers.find((provider) => provider.id === 'openai');
  assert.ok(openai);
  assert.ok(openai.models.some((model) => model.id === futureModel.id));
  const resolved = await runtime.personalModelDefinition('openai', futureModel.id);
  assert.equal(resolved.model.id, futureModel.id);
});

test('Anthropic uses the same personal credential path as OpenAI', async () => {
  const { credentials, runtime, anthropicSecrets } = runtimeFixture();
  credentials.addOrReplaceKeychainCredential({
    id: 'personal-anthropic',
    providerId: 'anthropic',
    label: 'Personal Anthropic',
    secret: 'sk-ant-personal-test-value'
  });

  const catalog = await runtime.personalChatCatalog();
  const anthropic = catalog.providers.find((provider) => provider.id === 'anthropic');
  assert.ok(anthropic);
  assert.equal(anthropic.ready, true);
  assert.deepEqual(anthropic.models.map((model) => model.id), [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-1'
  ]);
  assert.equal(anthropicSecrets.includes('sk-ant-personal-test-value'), true);

  const resolved = await runtime.personalModelDefinition('anthropic', 'claude-sonnet-5');
  assert.equal(resolved.provider.id, 'anthropic');
  assert.equal(resolved.model.id, 'claude-sonnet-5');
  assert.equal(resolved.model.contextWindow, 1_000_000);
});

test('personal Chat never uses organization-scoped credentials for any provider', async () => {
  const { credentials, runtime, openAiSecrets, anthropicSecrets } = runtimeFixture();
  credentials.addOrReplaceKeychainCredential({
    id: 'company-openai',
    providerId: 'openai',
    label: 'Company OpenAI',
    organizationId: 'company-a',
    secret: 'sk-company-openai'
  });
  credentials.addOrReplaceKeychainCredential({
    id: 'company-anthropic',
    providerId: 'anthropic',
    label: 'Company Anthropic',
    organizationId: 'company-a',
    secret: 'sk-company-anthropic'
  });

  const catalog = await runtime.personalChatCatalog();
  for (const providerId of ['openai', 'anthropic']) {
    const provider = catalog.providers.find((item) => item.id === providerId);
    assert.ok(provider);
    assert.equal(provider.ready, false);
    assert.match(provider.reason ?? '', new RegExp(`personal ${providerId} credential`));
    await assert.rejects(
      runtime.personalModelDefinition(
        providerId,
        providerId === 'openai' ? 'gpt-5.6-sol' : 'claude-sonnet-5'
      ),
      new RegExp(`personal ${providerId} credential`)
    );
  }
  assert.deepEqual(openAiSecrets, []);
  assert.deepEqual(anthropicSecrets, []);
});

test('personal Chat fails closed when multiple personal credentials could match one provider', async () => {
  const { credentials, runtime } = runtimeFixture();
  for (const id of ['personal-openai-a', 'personal-openai-b']) {
    credentials.addOrReplaceKeychainCredential({
      id,
      providerId: 'openai',
      label: id,
      secret: `sk-${id}`
    });
  }

  const catalog = await runtime.personalChatCatalog();
  const openai = catalog.providers.find((provider) => provider.id === 'openai');
  assert.ok(openai);
  assert.equal(openai.ready, false);
  assert.match(openai.reason ?? '', /Multiple personal openai credentials/);
  await assert.rejects(
    runtime.personalModelDefinition('openai', 'gpt-5.6-sol'),
    /Multiple personal openai credentials/
  );
});

test('a future registered cloud provider automatically inherits personal Chat credential isolation', async () => {
  const futureSecrets: string[] = [];
  const futureModels: ModelDefinition[] = [{
    providerId: 'future-ai',
    id: 'future-chat-1',
    displayName: 'Future Chat 1'
  }];
  const { credentials, runtime } = runtimeFixture({
    'future-ai': cloudFactory('future-ai', futureModels, futureSecrets)
  });

  let catalog = await runtime.personalChatCatalog();
  let future = catalog.providers.find((provider) => provider.id === 'future-ai');
  assert.ok(future, 'registered factories must automatically appear in the personal catalog');
  assert.equal(future.ready, false);
  assert.match(future.reason ?? '', /personal future-ai credential/);

  credentials.addOrReplaceKeychainCredential({
    id: 'company-future',
    providerId: 'future-ai',
    label: 'Company Future',
    organizationId: 'company-a',
    secret: 'future-company-secret'
  });
  catalog = await runtime.personalChatCatalog();
  future = catalog.providers.find((provider) => provider.id === 'future-ai');
  assert.ok(future);
  assert.equal(future.ready, false, 'organization credentials must remain excluded');
  assert.deepEqual(futureSecrets, []);

  credentials.addOrReplaceKeychainCredential({
    id: 'personal-future',
    providerId: 'future-ai',
    label: 'Personal Future',
    secret: 'future-personal-secret'
  });
  catalog = await runtime.personalChatCatalog();
  future = catalog.providers.find((provider) => provider.id === 'future-ai');
  assert.ok(future);
  assert.equal(future.ready, true);
  assert.deepEqual(future.models.map((model) => model.id), ['future-chat-1']);
  assert.equal(future.models[0]?.contextWindow, 128_000);
  assert.equal(future.models[0]?.maxOutputTokens, 8_192);
  assert.equal(futureSecrets.includes('future-company-secret'), false);
  assert.equal(futureSecrets.includes('future-personal-secret'), true);

  const resolved = await runtime.personalModelDefinition('future-ai', 'future-chat-1');
  assert.equal(resolved.provider.id, 'future-ai');
  assert.equal(resolved.model.id, 'future-chat-1');
});

test('projectless Chat exposes and submits exact personal provider models without weakening Cowork', () => {
  const appRuntime = lf(fs.readFileSync(path.join(process.cwd(), 'src/app-runtime.ts'), 'utf8'));
  const executionRuntime = lf(fs.readFileSync(path.join(process.cwd(), 'src/execution-runtime.ts'), 'utf8'));
  const providerRuntime = lf(fs.readFileSync(path.join(process.cwd(), 'src/project-provider-runtime.ts'), 'utf8'));
  const surface = lf(fs.readFileSync(path.join(process.cwd(), 'app/src/AgentSurfaceV2.tsx'), 'utf8'));

  assert.match(appRuntime, /pathname === '\/chat\/catalog'/);
  assert.match(appRuntime, /createExecutionRuntime\([\s\S]*this\.personalProviders/);
  assert.match(appRuntime, /providerRuntime: this\.personalProviders/);
  assert.match(appRuntime, /interactionMode !== 'chat'/);
  assert.match(appRuntime, /Local-first requires a Project/);
  assert.match(executionRuntime, /personalModelDefinition\(/);
  assert.match(executionRuntime, /new SelectedProviderChatClient/);
  assert.match(executionRuntime, /input\.interactionMode === 'chat' && !input\.projectId/);
  assert.match(providerRuntime, /\.\.\.Object\.keys\(this\.factories\)/);
  assert.match(providerRuntime, /profile\.organizationId === undefined/);

  assert.match(surface, /'\/api\/chat\/catalog'/);
  assert.match(surface, /\(catalog\?\.providers \?\? \[\]\)\.map\(\(provider\)/);
  assert.doesNotMatch(surface, /type ProviderMode = 'ollama'/);
  assert.match(surface, /modelOverrideAllowed = Boolean\(selectedProject\) \|\| mode === 'chat'/);
  assert.match(surface, /allowLocalFirst=\{Boolean\(selectedProject\)\}/);
  assert.match(surface, /Use personal Chat credentials without repository access/);
  assert.doesNotMatch(
    surface,
    /if \(!selectedProjectId\) \{\s*setCatalog\(undefined\);\s*setModelSelection\('auto'\);\s*return;/,
    'No-project Chat must load the personal provider catalog instead of clearing it'
  );
});
