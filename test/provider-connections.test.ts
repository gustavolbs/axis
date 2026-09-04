import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore } from '../src/codex-account-profiles.js';
import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import {
  ProviderConnectionRuntime,
  apiCredentialConnectionId,
  claudeAccountConnectionId,
  chatGptAccountConnectionId
} from '../src/provider-connections.js';
import type { InferenceProvider, ModelDefinition, ProviderCapabilities } from '../src/providers/types.js';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function credentials(): CredentialManager {
  return new CredentialManager(new CredentialProfileStore(path.join(temp('local-coder-connections-creds-'), 'credentials.json')));
}

const cloudCapabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

function anthropicCatalogProvider(models: ModelDefinition[]): InferenceProvider {
  return {
    id: 'anthropic',
    kind: 'cloud',
    capabilities: cloudCapabilities,
    async listModels() { return models; },
    async health() {
      return { providerId: 'anthropic', ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0, modelsAvailable: models.length };
    },
    async invoke(request) {
      return { providerId: 'anthropic', model: request.model, content: 'ok', latencyMs: 0, usage: {} };
    }
  };
}

test('every API credential becomes a distinct stable connection instance', () => {
  const manager = credentials();
  manager.addEnvironmentCredential({ id: 'gpt-personal-a', providerId: 'openai', label: 'GPT Personal A', environmentVariable: 'OPENAI_TEST_A' });
  manager.addEnvironmentCredential({ id: 'gpt-personal-b', providerId: 'openai', label: 'GPT Personal B', environmentVariable: 'OPENAI_TEST_B' });
  const runtime = new ProviderConnectionRuntime({
    credentials: manager,
    claudeProfiles: new ClaudeAccountProfileStore(temp('local-coder-connections-claude-')),
    codexProfiles: new CodexAccountProfileStore(temp('local-coder-connections-codex-'))
  });
  const ids = runtime.list().filter((item) => item.auth === 'api-key').map((item) => item.id);
  assert.deepEqual(new Set(ids), new Set([
    apiCredentialConnectionId('openai', 'gpt-personal-a'),
    apiCredentialConnectionId('openai', 'gpt-personal-b')
  ]));
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(
    runtime.list().filter((item) => item.auth === 'api-key').map((item) => item.label),
    ['GPT Personal A', 'GPT Personal B']
  );
});

test('Claude and ChatGPT subscription profiles are different connection identities', () => {
  const claude = new ClaudeAccountProfileStore(temp('local-coder-connections-claude-'));
  const codex = new CodexAccountProfileStore(temp('local-coder-connections-codex-'));
  claude.create({ id: 'personal', name: 'Claude Personal' });
  claude.create({ id: 'livenation', name: 'Claude LiveNation', organizationLabel: 'LiveNation' });
  codex.create({ id: 'personal', name: 'ChatGPT Personal' });
  const runtime = new ProviderConnectionRuntime({ credentials: credentials(), claudeProfiles: claude, codexProfiles: codex });
  const views = runtime.list();
  assert.ok(views.some((item) => item.id === claudeAccountConnectionId('personal')));
  assert.ok(views.some((item) => item.id === claudeAccountConnectionId('livenation')));
  assert.ok(views.some((item) => item.id === chatGptAccountConnectionId('personal')));
  assert.equal(new Set(views.map((item) => item.id)).size, views.length);
});

test('authenticated Claude accounts expose explicit stable model choices without leaking corporate Accounts into Personal', async () => {
  const claude = new ClaudeAccountProfileStore(temp('local-coder-models-claude-'));
  claude.create({ id: 'personal', name: 'Claude Personal' });
  claude.create({ id: 'company', name: 'Claude Company', organizationLabel: 'Company' });
  const runtime = new ClaudeAccountRuntime(claude, {
    claudeBinary: process.execPath,
    commandPrefixArgs: [fakeClaude]
  });
  const connections = new ProviderConnectionRuntime({
    credentials: credentials(),
    claudeProfiles: claude,
    claudeRuntime: runtime,
    codexProfiles: new CodexAccountProfileStore(temp('local-coder-models-codex-'))
  });

  const catalog = await connections.catalogProviders();
  const account = catalog.find((provider) => provider.id === claudeAccountConnectionId('personal'));
  assert.ok(account);
  assert.equal(account.ready, true);
  assert.equal(account.label, 'Account · Claude · Claude Personal');
  assert.equal(account.providerFamily, 'anthropic');
  assert.equal(account.auth, 'claude-account');
  assert.equal(account.billing, 'subscription');
  assert.deepEqual(account.models.map((model) => model.id), ['default', 'fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(account.models.map((model) => model.displayName), ['Default model', 'Fable', 'Opus', 'Sonnet', 'Haiku']);

  const companyId = claudeAccountConnectionId('company');
  const companyView = connections.view(companyId);
  assert.ok(companyView);
  assert.equal(companyView.label, 'Claude Company');
  assert.equal(companyView.auth, 'claude-account');
  assert.equal(companyView.organizationLabel, 'Company');
  assert.equal(companyView.organizationId, 'company');
  assert.equal(catalog.some((provider) => provider.id === companyId), false);
  await assert.rejects(() => connections.resolve(companyId, 'sonnet'), /requires an explicitly bound Project/);
  assert.equal((await connections.resolveForProject(companyId, 'sonnet', 'company')).provider.id, companyId);
});

test('corporate subscription Accounts of every supported family stay out of Personal before runtime discovery', async () => {
  const claude = new ClaudeAccountProfileStore(temp('local-coder-corporate-claude-'));
  const codex = new CodexAccountProfileStore(temp('local-coder-corporate-codex-'));
  claude.create({ id: 'corp', name: 'Claude Corp', organizationLabel: 'Acme' });
  codex.create({ id: 'corp', name: 'ChatGPT Corp', organizationLabel: 'Acme' });
  const runtime = new ProviderConnectionRuntime({ credentials: credentials(), claudeProfiles: claude, codexProfiles: codex });

  const corporateIds = new Set([
    claudeAccountConnectionId('corp'),
    chatGptAccountConnectionId('corp')
  ]);
  assert.equal(runtime.list().filter((item) => corporateIds.has(item.id)).every((item) => item.organizationId === 'acme'), true);
  assert.equal((await runtime.catalogProviders()).some((item) => corporateIds.has(item.id)), false);
});

test('Claude account aliases show the current version discovered from the live API catalog', async () => {
  const environmentVariable = 'LOCAL_CODER_TEST_CLAUDE_ACCOUNT_VERSION_CATALOG';
  process.env[environmentVariable] = 'sk-ant-test-version-catalog';
  try {
    const manager = credentials();
    manager.addEnvironmentCredential({
      id: 'personal-anthropic',
      providerId: 'anthropic',
      label: 'Claude API',
      environmentVariable
    });
    const claude = new ClaudeAccountProfileStore(temp('local-coder-versioned-models-claude-'));
    claude.create({ id: 'personal', name: 'Claude Personal' });
    const connections = new ProviderConnectionRuntime({
      credentials: manager,
      claudeProfiles: claude,
      claudeRuntime: new ClaudeAccountRuntime(claude, {
        claudeBinary: process.execPath,
        commandPrefixArgs: [fakeClaude]
      }),
      codexProfiles: new CodexAccountProfileStore(temp('local-coder-versioned-models-codex-')),
      apiProviderFactories: {
        anthropic: () => anthropicCatalogProvider([
          { providerId: 'anthropic', id: 'claude-opus-3-7-20250219', displayName: 'Claude Opus 3.7', createdAt: '2025-02-19T00:00:00.000Z' },
          { providerId: 'anthropic', id: 'claude-opus-5', displayName: 'Claude Opus 5', createdAt: '2026-07-24T00:00:00.000Z' },
          { providerId: 'anthropic', id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', createdAt: '2026-08-20T00:00:00.000Z' },
          { providerId: 'anthropic', id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', createdAt: '2025-10-01T00:00:00.000Z' }
        ])
      }
    });

    const catalog = await connections.catalogProviders();
    const account = catalog.find((provider) => provider.id === claudeAccountConnectionId('personal'));
    assert.ok(account);
    assert.equal(account.models.find((model) => model.id === 'opus')?.displayName, 'Opus 5 · latest alias');
    assert.equal(account.models.find((model) => model.id === 'fable')?.displayName, 'Fable 5.1 · latest alias');
    assert.equal(account.models.find((model) => model.id === 'haiku')?.displayName, 'Haiku 4.5 · latest alias');
    assert.equal(account.models.find((model) => model.id === 'sonnet')?.displayName, 'Sonnet');
  } finally {
    delete process.env[environmentVariable];
  }
});

test('organization-scoped API credentials remain Project-only and do not enter personal Chat catalog', async () => {
  const manager = credentials();
  manager.addEnvironmentCredential({
    id: 'corp-openai', providerId: 'openai', label: 'Corporate OpenAI', organizationId: 'acme', environmentVariable: 'CORP_OPENAI_TEST'
  });
  const runtime = new ProviderConnectionRuntime({
    credentials: manager,
    claudeProfiles: new ClaudeAccountProfileStore(temp('local-coder-connections-claude-')),
    codexProfiles: new CodexAccountProfileStore(temp('local-coder-connections-codex-'))
  });
  const id = apiCredentialConnectionId('openai', 'corp-openai');
  assert.ok(runtime.list().some((item) => item.id === id && item.organizationId === 'acme'));
  assert.equal((await runtime.catalogProviders()).some((item) => item.id === id), false);
  await assert.rejects(() => runtime.resolve(id, 'gpt-5.6-sol'), /requires an explicitly bound Project/);
});
