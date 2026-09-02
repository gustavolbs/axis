import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore, CodexAccountRuntime } from '../src/codex-account-profiles.js';
import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import { projectChatDefaultModelSelection } from '../src/project-chat-default.js';
import {
  ProviderConnectionRuntime,
  apiCredentialConnectionId,
  claudeAccountConnectionId
} from '../src/provider-connections.js';
import { ProjectStore } from '../src/project-store.js';
import { StandaloneJobManager } from '../src/standalone-job-manager.js';
import type { InferenceProvider, ProviderCapabilities } from '../src/providers/types.js';
import type { SecretStore } from '../src/secret-store.js';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

const capabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: false,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: false
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

function fakeProvider(apiKey: string, seen: string[]): InferenceProvider {
  seen.push(apiKey);
  const modelId = apiKey === 'secret-a' ? 'model-a' : 'model-b';
  return {
    id: 'openai',
    kind: 'cloud',
    capabilities,
    async listModels() {
      return [{ providerId: 'openai', id: modelId, displayName: modelId, capabilities }];
    },
    async health() {
      return { providerId: 'openai', ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0, modelsAvailable: 1 };
    },
    async invoke(request) {
      return { providerId: 'openai', model: request.model, content: apiKey, latencyMs: 0, usage: {} };
    }
  };
}

test('Project connections deny personal and cross-organization accounts', () => {
  const claude = new ClaudeAccountProfileStore(temp('local-coder-org-claude-'));
  claude.create({ id: 'personal', name: 'Claude Personal' });
  claude.create({ id: 'acme', name: 'Claude Acme', organizationLabel: 'Acme' });
  claude.create({ id: 'other', name: 'Claude Other', organizationLabel: 'Other Corp' });
  const runtime = new ProviderConnectionRuntime({
    credentials: new CredentialManager(new CredentialProfileStore(path.join(temp('local-coder-org-creds-'), 'credentials.json'))),
    claudeProfiles: claude,
    codexProfiles: new CodexAccountProfileStore(temp('local-coder-org-codex-'))
  });

  const acmeId = claudeAccountConnectionId('acme');
  assert.equal(runtime.providerForProject(acmeId, 'acme').id, acmeId);
  assert.throws(
    () => runtime.providerForProject(claudeAccountConnectionId('personal'), 'acme'),
    /belongs to organization personal, not Project organization acme/
  );
  assert.throws(
    () => runtime.providerForProject(claudeAccountConnectionId('other'), 'acme'),
    /belongs to organization other-corp, not Project organization acme/
  );
});

test('exact connection selection never falls back to another identity of the same provider family', async () => {
  const profiles = new CredentialProfileStore(path.join(temp('local-coder-no-fallback-'), 'credentials.json'));
  const secrets = new MemorySecretStore();
  const credentials = new CredentialManager(profiles, { keychain: secrets });
  credentials.addOrReplaceKeychainCredential({
    id: 'acme-a', providerId: 'openai', label: 'Acme A', organizationId: 'acme', secret: 'secret-a'
  });
  credentials.addOrReplaceKeychainCredential({
    id: 'acme-b', providerId: 'openai', label: 'Acme B', organizationId: 'acme', secret: 'secret-b'
  });
  const seen: string[] = [];
  const runtime = new ProviderConnectionRuntime({
    credentials,
    claudeProfiles: new ClaudeAccountProfileStore(temp('local-coder-no-fallback-claude-')),
    codexProfiles: new CodexAccountProfileStore(temp('local-coder-no-fallback-codex-')),
    apiProviderFactories: { openai: (apiKey) => fakeProvider(apiKey, seen) }
  });
  const connectionA = apiCredentialConnectionId('openai', 'acme-a');

  await assert.rejects(
    () => runtime.resolveForProject(connectionA, 'model-b', 'acme'),
    new RegExp(`Model model-b is not available through connection ${connectionA}`)
  );
  assert.deepEqual(seen, ['secret-a']);

  const resolved = await runtime.resolveForProject(connectionA, 'model-a', 'acme');
  assert.equal(resolved.provider.id, connectionA);
  assert.equal(resolved.model.providerId, connectionA);
  assert.equal(resolved.model.id, 'model-a');
  assert.deepEqual(seen, ['secret-a', 'secret-a']);
});

test('a Project Chat snapshots its default identity and later Project edits only affect new chats', () => {
  const store = new ProjectStore(path.join(temp('local-coder-chat-default-'), 'projects.json'));
  const project = store.create({
    id: 'acme',
    name: 'Acme',
    organizationId: 'acme',
    privacy: { cloudAllowed: true, allowedProviderIds: ['openai'] },
    defaultModel: { mode: 'explicit', providerId: 'openai-a', modelId: 'model-a' },
    connectionPolicy: {
      chat: { defaultConnectionId: 'openai-a', defaultModelId: 'model-a', allowedConnectionIds: ['openai-a', 'openai-b'] },
      inference: { allowedConnectionIds: ['openai-a'] },
      workSourceIds: []
    }
  });
  const originalSelection = projectChatDefaultModelSelection(project);
  assert.deepEqual(originalSelection, { mode: 'explicit', providerId: 'openai-a', modelId: 'model-a' });

  const execution = {
    async executeEngineer() {
      return { status: 'success', phase: 'complete', summary: 'ok', changedFiles: [], diff: '', validation: [], repairRounds: 0 } as never;
    },
    async prepareEscalation() { throw new Error('not used'); },
    async consultEscalation() { throw new Error('not used'); }
  };
  const jobs = new StandaloneJobManager(execution);
  const oldChat = jobs.create({
    projectId: project.id,
    workspace: '',
    goal: 'hello',
    interactionMode: 'chat',
    modelSelection: originalSelection
  });

  const updated = store.update(project.id, {
    defaultModel: { mode: 'explicit', providerId: 'openai-b', modelId: 'model-b' },
    connectionPolicy: {
      chat: { defaultConnectionId: 'openai-b', defaultModelId: 'model-b', allowedConnectionIds: ['openai-a', 'openai-b'] },
      inference: { allowedConnectionIds: ['openai-a'] },
      workSourceIds: []
    }
  });

  assert.deepEqual(jobs.get(oldChat.id)?.input.modelSelection, originalSelection);
  assert.deepEqual(projectChatDefaultModelSelection(updated), { mode: 'explicit', providerId: 'openai-b', modelId: 'model-b' });
});

test('subscription account runtimes pass structured-output schemas through official CLI flags', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

  const claudeStore = new ClaudeAccountProfileStore(temp('local-coder-schema-claude-'));
  claudeStore.create({ id: 'personal', name: 'Personal' });
  const claude = new ClaudeAccountRuntime(claudeStore, {
    claudeBinary: process.execPath,
    commandPrefixArgs: [fakeClaude],
    terminationGraceMs: 50
  });
  const claudeResult = await claude.invoke('personal', 'OK', { jsonSchema: schema });
  assert.match(claudeResult.stdout, /--json-schema/);
  assert.match(claudeResult.stdout, /additionalProperties/);

  const codexStore = new CodexAccountProfileStore(temp('local-coder-schema-codex-'));
  codexStore.create({ id: 'personal', name: 'Personal' });
  const codex = new CodexAccountRuntime(codexStore, {
    codexBinary: process.execPath,
    commandPrefixArgs: [fakeCodex],
    terminationGraceMs: 50
  });
  const codexResult = await codex.invoke('personal', 'OK', { outputSchema: schema });
  assert.match(codexResult.stdout, /--output-schema/);
  assert.doesNotMatch(codexResult.stdout, /oauth|access[_-]?token/i);
});
