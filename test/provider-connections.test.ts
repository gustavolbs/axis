import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ClaudeAccountProfileStore } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore } from '../src/codex-account-profiles.js';
import { CredentialManager, CredentialProfileStore } from '../src/credential-store.js';
import {
  ProviderConnectionRuntime,
  apiCredentialConnectionId,
  claudeAccountConnectionId,
  chatGptAccountConnectionId
} from '../src/provider-connections.js';

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function credentials(): CredentialManager {
  return new CredentialManager(new CredentialProfileStore(path.join(temp('local-coder-connections-creds-'), 'credentials.json')));
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
