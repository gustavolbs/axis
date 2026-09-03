import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ApiConnectionEndpointStore,
  installApiConnectionEndpointRouting,
  normalizeApiConnectionHeaders
} from '../src/api-connection-endpoints.js';
import { ApiKeyConnectionLifecycle } from '../src/api-key-connection-lifecycle.js';
import { ClaudeAccountProfileStore } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore } from '../src/codex-account-profiles.js';
import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import { ProviderConnectionRuntime, apiCredentialConnectionId } from '../src/provider-connections.js';
import type { SecretStore } from '../src/secret-store.js';

class MemoryKeychain implements SecretStore {
  readonly backend = 'macos-keychain' as const;
  readonly values = new Map<string, string>();
  isAvailable() { return true; }
  get(id: string) { return this.values.get(id); }
  set(id: string, value: string) { this.values.set(id, value); }
  delete(id: string) { return this.values.delete(id); }
}

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const root = temp('axis-api-lifecycle-');
const configStore = new ApiConnectionEndpointStore(path.join(root, 'api-connections.json'));
installApiConnectionEndpointRouting(configStore);

test('API connection headers are a provider-specific non-secret allowlist', () => {
  assert.deepEqual(
    normalizeApiConnectionHeaders('openai', { 'OpenAI-Project': 'project-123', 'openai-organization': 'org-456' }),
    { 'openai-project': 'project-123', 'openai-organization': 'org-456' }
  );
  assert.deepEqual(
    normalizeApiConnectionHeaders('anthropic', { 'Anthropic-Beta': 'files-api-2025-04-14' }),
    { 'anthropic-beta': 'files-api-2025-04-14' }
  );
  assert.throws(() => normalizeApiConnectionHeaders('openai', { authorization: 'Bearer attacker' }), /not allowed/);
  assert.throws(() => normalizeApiConnectionHeaders('anthropic', { 'x-api-key': 'attacker' }), /not allowed/);
  assert.throws(() => normalizeApiConnectionHeaders('openai', { 'openai-project': 'line1\nline2' }), /control line breaks/);
});

test('API Key lifecycle edits, tests, rotates, disables and removes one connection without touching its sibling', async () => {
  const caseRoot = temp('axis-api-lifecycle-case-');
  const keychain = new MemoryKeychain();
  const credentials = new CredentialManager(
    new CredentialProfileStore(path.join(caseRoot, 'credentials.json')),
    { keychain }
  );
  credentials.addOrReplaceKeychainCredential({
    id: 'openai-a',
    providerId: 'openai',
    label: 'OpenAI A',
    organizationId: 'acme',
    secret: 'secret-a'
  });
  credentials.addOrReplaceKeychainCredential({
    id: 'openai-b',
    providerId: 'openai',
    label: 'OpenAI B',
    organizationId: 'acme',
    secret: 'secret-b'
  });
  const connectionA = apiCredentialConnectionId('openai', 'openai-a');
  const connectionB = apiCredentialConnectionId('openai', 'openai-b');
  configStore.upsert({ connectionId: connectionA, providerFamily: 'openai', credentialId: 'openai-a' });
  configStore.upsert({ connectionId: connectionB, providerFamily: 'openai', credentialId: 'openai-b' });

  const runtime = new ProviderConnectionRuntime({
    credentials,
    claudeProfiles: new ClaudeAccountProfileStore(path.join(caseRoot, 'claude')),
    codexProfiles: new CodexAccountProfileStore(path.join(caseRoot, 'codex'))
  });
  const lifecycle = new ApiKeyConnectionLifecycle(credentials, configStore, runtime);

  const beforeB = lifecycle.details(connectionB);
  const editedA = lifecycle.edit(connectionA, {
    name: 'OpenAI Gateway A',
    endpoint: 'https://gateway.example/v1/',
    headers: { 'OpenAI-Project': 'project-a' }
  });
  assert.equal(editedA.name, 'OpenAI Gateway A');
  assert.equal(editedA.endpoint, 'https://gateway.example/v1');
  assert.deepEqual(editedA.headers, { 'openai-project': 'project-a' });
  assert.equal(editedA.companyId, 'acme');
  assert.equal(credentials.resolve('openai-a'), 'secret-a');
  assert.deepEqual(lifecycle.details(connectionB), beforeB);

  lifecycle.rotate(connectionA, 'rotated-a');
  assert.equal(credentials.resolve('openai-a'), 'rotated-a');
  assert.equal(credentials.resolve('openai-b'), 'secret-b');
  assert.equal(credentials.getProfile('openai-a')?.secret.backend, 'macos-keychain');

  const requests: Array<{ url: string; method: string; authorization?: string | null; project?: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      project: headers.get('openai-project')
    });
    return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  try {
    const health = await lifecycle.test(connectionA);
    assert.equal(health.ok, true);
    assert.deepEqual(requests, [{
      url: 'https://gateway.example/v1/models',
      method: 'GET',
      authorization: 'Bearer rotated-a',
      project: 'project-a'
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const disabledA = lifecycle.setEnabled(connectionA, false);
  assert.equal(disabledA.enabled, false);
  assert.equal(disabledA.available, false);
  assert.match(disabledA.reason ?? '', /Disabled/);
  await assert.rejects(() => lifecycle.test(connectionA), /disabled/);
  assert.equal(lifecycle.details(connectionB).enabled, true);
  lifecycle.setEnabled(connectionA, true);
  assert.equal(lifecycle.details(connectionA).enabled, true);

  assert.equal(lifecycle.remove(connectionA), true);
  assert.equal(credentials.getProfile('openai-a'), undefined);
  assert.equal(configStore.get(connectionA), undefined);
  assert.equal(runtime.view(connectionA), undefined);
  assert.ok(runtime.view(connectionB));
  assert.equal(credentials.resolve('openai-b'), 'secret-b');
  assert.deepEqual(lifecycle.details(connectionB), beforeB);
});
