import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ClaudeAccountProfileStore, ClaudeAccountRuntime } from '../src/claude-account-profiles.js';
import type { CodexAccountProfileStore, CodexAccountRuntime } from '../src/codex-account-profiles.js';
import { PERSONAL_ORGANIZATION_ID } from '../src/connection-identity.js';
import type { CredentialManager } from '../src/credential-store.js';
import { ProviderConnectionRuntime } from '../src/provider-connections.js';
import { ProviderSettingsStore } from '../src/provider-settings.js';
import type {
  InferenceProvider,
  ModelDefinition,
  ProviderCapabilities
} from '../src/providers/types.js';

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: true
};

function apiProvider(id: 'openai' | 'anthropic', models: ModelDefinition[]): InferenceProvider {
  return {
    id,
    kind: 'cloud',
    capabilities,
    async listModels() { return models; },
    async health() {
      return {
        providerId: id,
        ok: true,
        checkedAt: '2026-09-03T12:00:00.000Z',
        latencyMs: 0,
        modelsAvailable: models.length
      };
    },
    async invoke(request) {
      return {
        providerId: id,
        model: request.model,
        content: 'ok',
        latencyMs: 0,
        usage: {}
      };
    }
  };
}

test('Chat catalog makes connection type explicit and normalizes model labels across API Keys and Accounts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-chat-catalog-'));
  const credentials = {
    list() {
      return [
        {
          id: 'openai-personal',
          providerId: 'openai',
          label: 'Personal OpenAI',
          organizationId: PERSONAL_ORGANIZATION_ID,
          secret: { backend: 'environment', id: 'OPENAI_TEST' },
          createdAt: '2026-09-03T12:00:00.000Z',
          updatedAt: '2026-09-03T12:00:00.000Z'
        },
        {
          id: 'anthropic-personal',
          providerId: 'anthropic',
          label: 'Personal Claude',
          organizationId: PERSONAL_ORGANIZATION_ID,
          secret: { backend: 'environment', id: 'ANTHROPIC_TEST' },
          createdAt: '2026-09-03T12:00:00.000Z',
          updatedAt: '2026-09-03T12:00:00.000Z'
        }
      ];
    },
    resolve(id: string) {
      return id === 'openai-personal' ? 'openai-secret' : id === 'anthropic-personal' ? 'anthropic-secret' : undefined;
    }
  } as unknown as CredentialManager;
  const claudeProfiles = {
    list() {
      return [{ id: 'claude-personal', name: 'Claude Personal', configDir: '/tmp/claude-personal' }];
    }
  } as unknown as ClaudeAccountProfileStore;
  const codexProfiles = {
    list() {
      return [{ id: 'chatgpt-personal', name: 'ChatGPT Personal', configDir: '/tmp/chatgpt-personal' }];
    }
  } as unknown as CodexAccountProfileStore;
  const claudeRuntime = {
    async status(profileId: string) {
      return { profileId, installed: true, usable: true, authenticated: true };
    }
  } as unknown as ClaudeAccountRuntime;
  const codexRuntime = {
    async status(profileId: string) {
      return { profileId, installed: true, usable: true, authenticated: true };
    }
  } as unknown as CodexAccountRuntime;

  const runtime = new ProviderConnectionRuntime({
    credentials,
    settings: new ProviderSettingsStore(path.join(directory, 'providers.json')),
    claudeProfiles,
    claudeRuntime,
    codexProfiles,
    codexRuntime,
    apiProviderFactories: {
      openai: () => apiProvider('openai', [{
        providerId: 'openai',
        id: 'gpt-5.6-luna',
        displayName: 'gpt-5.6-luna'
      }]),
      anthropic: () => apiProvider('anthropic', [{
        providerId: 'anthropic',
        id: 'claude-fable-5-1',
        displayName: 'claude-fable-5-1',
        createdAt: '2026-09-03T12:00:00.000Z'
      }])
    }
  });

  const catalog = await runtime.catalogProviders();
  const openAiApi = catalog.find((provider) => provider.auth === 'api-key' && provider.providerFamily === 'openai');
  const claudeApi = catalog.find((provider) => provider.auth === 'api-key' && provider.providerFamily === 'anthropic');
  const chatGptAccount = catalog.find((provider) => provider.auth === 'chatgpt-account');
  const claudeAccount = catalog.find((provider) => provider.auth === 'claude-account');

  assert.match(openAiApi?.label ?? '', /^API Key · /);
  assert.equal(openAiApi?.models[0]?.displayName, 'GPT 5.6 Luna');
  assert.match(claudeApi?.label ?? '', /^API Key · /);
  assert.equal(claudeApi?.models[0]?.displayName, 'Fable 5.1');
  assert.match(chatGptAccount?.label ?? '', /^Account · ChatGPT · /);
  assert.equal(chatGptAccount?.models[0]?.displayName, 'Default model');
  assert.match(claudeAccount?.label ?? '', /^Account · Claude · /);
  assert.equal(claudeAccount?.models.find((model) => model.id === 'default')?.displayName, 'Default model');
  assert.equal(claudeAccount?.models.find((model) => model.id === 'fable')?.displayName, 'Fable 5.1 · latest alias');

  fs.rmSync(directory, { recursive: true, force: true });
});
