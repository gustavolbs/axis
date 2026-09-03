import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ApiConnectionEndpointStore,
  installApiConnectionEndpointRouting,
  normalizeApiEndpoint
} from '../src/api-connection-endpoints.js';
import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore, CodexAccountRuntime } from '../src/codex-account-profiles.js';
import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import {
  ProviderConnectionRuntime,
  apiCredentialConnectionId,
  chatGptAccountConnectionId,
  claudeAccountConnectionId
} from '../src/provider-connections.js';
import type { InferenceProvider, ProviderCapabilities } from '../src/providers/types.js';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const localCapabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: false,
  promptCaching: false,
  toolUse: false
};

function localProvider(): InferenceProvider {
  return {
    id: 'ollama-local',
    kind: 'local',
    capabilities: localCapabilities,
    async listModels() {
      return [{ providerId: 'ollama-local', id: 'qwen-test', displayName: 'Qwen Test' }];
    },
    async health() {
      return { providerId: 'ollama-local', ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0, modelsAvailable: 1 };
    },
    async invoke(request) {
      return { providerId: 'ollama-local', model: request.model, content: 'local-ok', latencyMs: 0, usage: {} };
    }
  };
}

function emptyCredentials(root: string): CredentialManager {
  return new CredentialManager(new CredentialProfileStore(path.join(root, 'credentials.json')));
}

const endpointStore = new ApiConnectionEndpointStore(path.join(temp('axis-api-endpoint-routing-'), 'endpoints.json'));
installApiConnectionEndpointRouting(endpointStore);

test('API endpoint metadata is local, normalized and rejects embedded credentials', () => {
  assert.equal(normalizeApiEndpoint(undefined), undefined);
  assert.equal(normalizeApiEndpoint(' https://gateway.example/v1/ '), 'https://gateway.example/v1');
  assert.equal(normalizeApiEndpoint('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1');
  assert.throws(() => normalizeApiEndpoint('ftp://gateway.example/v1'), /http or https/);
  assert.throws(() => normalizeApiEndpoint('https://user:secret@gateway.example/v1'), /embedded credentials/);
});

test('Ollama works as the only configured connection', async () => {
  const root = temp('axis-independent-ollama-');
  const runtime = new ProviderConnectionRuntime({
    localProvider: localProvider(),
    credentials: emptyCredentials(root),
    claudeProfiles: new ClaudeAccountProfileStore(path.join(root, 'claude')),
    codexProfiles: new CodexAccountProfileStore(path.join(root, 'codex'))
  });

  assert.deepEqual(runtime.list().map((connection) => connection.auth), ['local']);
  const resolved = await runtime.resolve('ollama-local', 'qwen-test');
  assert.equal(resolved.provider.id, 'ollama-local');
  assert.equal(resolved.model.id, 'qwen-test');
});

test('Claude Account works without Ollama, ChatGPT or API credentials', async () => {
  const root = temp('axis-independent-claude-');
  const profiles = new ClaudeAccountProfileStore(path.join(root, 'claude'));
  profiles.create({ id: 'personal', name: 'Claude Personal' });
  const runtime = new ProviderConnectionRuntime({
    credentials: emptyCredentials(root),
    claudeProfiles: profiles,
    claudeRuntime: new ClaudeAccountRuntime(profiles, {
      claudeBinary: process.execPath,
      commandPrefixArgs: [fakeClaude]
    }),
    codexProfiles: new CodexAccountProfileStore(path.join(root, 'codex'))
  });

  const catalog = await runtime.catalogProviders();
  assert.deepEqual(catalog.map((connection) => connection.id), [claudeAccountConnectionId('personal')]);
  assert.equal(catalog[0]?.auth, 'claude-account');
  assert.equal(catalog[0]?.ready, true);
});

test('ChatGPT/Codex Account works without Ollama, Claude or API credentials', async () => {
  const root = temp('axis-independent-codex-');
  const profiles = new CodexAccountProfileStore(path.join(root, 'codex'));
  profiles.create({ id: 'personal', name: 'ChatGPT Personal' });
  const runtime = new ProviderConnectionRuntime({
    credentials: emptyCredentials(root),
    claudeProfiles: new ClaudeAccountProfileStore(path.join(root, 'claude')),
    codexProfiles: profiles,
    codexRuntime: new CodexAccountRuntime(profiles, {
      codexBinary: process.execPath,
      commandPrefixArgs: [fakeCodex]
    })
  });

  const catalog = await runtime.catalogProviders();
  assert.deepEqual(catalog.map((connection) => connection.id), [chatGptAccountConnectionId('personal')]);
  assert.equal(catalog[0]?.auth, 'chatgpt-account');
  assert.equal(catalog[0]?.ready, true);
});

test('an API Key connection uses its own custom endpoint without any Account or Ollama dependency', async () => {
  const root = temp('axis-independent-api-');
  const variable = 'AXIS_TEST_CUSTOM_ENDPOINT_KEY';
  process.env[variable] = 'sk-test-custom-endpoint-value';
  const credentials = emptyCredentials(root);
  credentials.addEnvironmentCredential({
    id: 'custom-openai',
    providerId: 'openai',
    label: 'OpenAI Gateway',
    environmentVariable: variable
  });
  const connectionId = apiCredentialConnectionId('openai', 'custom-openai');
  endpointStore.upsert({
    connectionId,
    providerFamily: 'openai',
    credentialId: 'custom-openai',
    endpoint: 'https://gateway.example/v1/'
  });

  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: 'gpt-gateway' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  try {
    const runtime = new ProviderConnectionRuntime({
      credentials,
      claudeProfiles: new ClaudeAccountProfileStore(path.join(root, 'claude')),
      codexProfiles: new CodexAccountProfileStore(path.join(root, 'codex'))
    });
    const views = runtime.list();
    assert.equal(views.length, 1);
    assert.equal(views[0]?.auth, 'api-key');
    assert.equal((views[0] as typeof views[number] & { endpoint?: string }).endpoint, 'https://gateway.example/v1');

    const resolved = await runtime.resolve(connectionId, 'gpt-gateway');
    assert.equal(resolved.provider.id, connectionId);
    assert.equal(resolved.model.id, 'gpt-gateway');
    assert.deepEqual(requested, ['https://gateway.example/v1/models']);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env[variable];
  }
});
