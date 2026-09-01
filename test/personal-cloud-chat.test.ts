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

function openAiFactory(secrets: string[]): (apiKey: string) => InferenceProvider {
  return (apiKey) => {
    secrets.push(apiKey);
    return {
      id: 'openai',
      kind: 'cloud',
      capabilities,
      async listModels() {
        return [
          {
            providerId: 'openai',
            id: 'gpt-5.6',
            displayName: 'GPT-5.6',
            createdAt: '2026-08-30T00:00:00.000Z',
            contextWindow: 1_050_000,
            maxOutputTokens: 131_072
          },
          {
            providerId: 'openai',
            id: 'gpt-5.5',
            displayName: 'GPT-5.5',
            createdAt: '2026-07-01T00:00:00.000Z',
            contextWindow: 400_000,
            maxOutputTokens: 64_000
          },
          {
            providerId: 'openai',
            id: 'text-embedding-3-large',
            displayName: 'text-embedding-3-large'
          }
        ];
      },
      async health() {
        return {
          providerId: 'openai',
          ok: true,
          checkedAt: new Date(0).toISOString(),
          latencyMs: 1,
          modelsAvailable: 3
        };
      },
      async invoke(request) {
        return {
          providerId: 'openai',
          model: request.model,
          content: 'ok',
          latencyMs: 1,
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }
        };
      }
    };
  };
}

function runtimeFixture() {
  const dir = tempDir('runtime');
  const keychain = new MemorySecretStore();
  const credentials = new CredentialManager(
    new CredentialProfileStore(path.join(dir, 'credentials.json')),
    { keychain }
  );
  const settings = new ProviderSettingsStore(path.join(dir, 'providers.json'));
  const secrets: string[] = [];
  const runtime = new ProjectProviderRuntime({
    credentials,
    settings,
    cloudProviderFactories: { openai: openAiFactory(secrets) }
  });
  return { credentials, keychain, runtime, secrets };
}

test('personal Chat discovers an available personal OpenAI credential and only conversational models', async () => {
  const { credentials, runtime, secrets } = runtimeFixture();
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
  assert.deepEqual(openai.models.map((model) => model.id), ['gpt-5.6', 'gpt-5.5']);
  assert.equal(openai.models.some((model) => model.id.includes('embedding')), false);
  assert.equal(openai.models[0]?.contextWindow, 1_050_000);
  assert.equal(secrets.includes('sk-personal-test-value'), true);

  const resolved = await runtime.personalModelDefinition('openai', 'gpt-5.6');
  assert.equal(resolved.provider.id, 'openai');
  assert.equal(resolved.model.id, 'gpt-5.6');
  assert.equal(resolved.model.maxOutputTokens, 131_072);
});

test('personal Chat never uses organization-scoped credentials', async () => {
  const { credentials, runtime, secrets } = runtimeFixture();
  credentials.addOrReplaceKeychainCredential({
    id: 'company-openai',
    providerId: 'openai',
    label: 'Company OpenAI',
    organizationId: 'company-a',
    secret: 'sk-company-test-value'
  });

  const catalog = await runtime.personalChatCatalog();
  const openai = catalog.providers.find((provider) => provider.id === 'openai');
  assert.ok(openai);
  assert.equal(openai.ready, false);
  assert.match(openai.reason ?? '', /personal OpenAI API key/);
  assert.deepEqual(secrets, []);
  await assert.rejects(
    runtime.personalModelDefinition('openai', 'gpt-5.6'),
    /personal OpenAI API key/
  );
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
    runtime.personalModelDefinition('openai', 'gpt-5.6'),
    /Multiple personal openai credentials/
  );
});

test('projectless Chat exposes and submits exact personal provider models without weakening Cowork', () => {
  const appRuntime = lf(fs.readFileSync(path.join(process.cwd(), 'src/app-runtime.ts'), 'utf8'));
  const executionRuntime = lf(fs.readFileSync(path.join(process.cwd(), 'src/execution-runtime.ts'), 'utf8'));
  const surface = lf(fs.readFileSync(path.join(process.cwd(), 'app/src/AgentSurfaceV2.tsx'), 'utf8'));

  assert.match(appRuntime, /pathname === '\/chat\/catalog'/);
  assert.match(appRuntime, /interactionMode !== 'chat'/);
  assert.match(appRuntime, /Local-first requires a Project/);
  assert.match(executionRuntime, /personalModelDefinition\(/);
  assert.match(executionRuntime, /new SelectedProviderChatClient/);
  assert.match(executionRuntime, /input\.interactionMode === 'chat' && !input\.projectId/);

  assert.match(surface, /'\/api\/chat\/catalog'/);
  assert.match(surface, /modelOverrideAllowed = Boolean\(selectedProject\) \|\| mode === 'chat'/);
  assert.match(surface, /allowLocalFirst=\{Boolean\(selectedProject\)\}/);
  assert.match(surface, /Use personal Chat credentials without repository access/);
  assert.doesNotMatch(
    surface,
    /if \(!selectedProjectId\) \{\s*setCatalog\(undefined\);\s*setModelSelection\('auto'\);\s*return;/,
    'No-project Chat must load the personal provider catalog instead of clearing it'
  );
});
