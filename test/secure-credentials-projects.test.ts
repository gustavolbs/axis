import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  CredentialManager,
  CredentialProfileStore,
  type CredentialProfile
} from '../src/credential-store.js';
import {
  readControlPlaneConfig,
  writeControlPlaneConfig
} from '../src/control-plane-config.js';
import {
  ProjectStore,
  assertProjectCredentialIsolation,
  projectIsolationKey
} from '../src/project-store.js';
import {
  MacOSKeychainSecretStore,
  type CommandResult,
  type SecretStore
} from '../src/secret-store.js';

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `local-coder-${name}-`));
}

class MemorySecretStore implements SecretStore {
  readonly backend = 'macos-keychain' as const;
  readonly values = new Map<string, string>();

  isAvailable(): boolean { return true; }
  get(id: string): string | undefined { return this.values.get(id); }
  set(id: string, value: string): void { this.values.set(id, value); }
  delete(id: string): boolean { return this.values.delete(id); }
}

test('macOS Keychain writer sends secrets through stdin, never process argv', () => {
  const secret = 'sk-ant-this-must-never-be-process-argv';
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner = (args: string[], input?: string): CommandResult => {
    calls.push({ args, input });
    if (args[0] === 'help') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'find-generic-password') {
      return { status: 0, stdout: `${secret}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const store = new MacOSKeychainSecretStore('com.test.local-coder', runner, 'darwin');

  assert.equal(store.isAvailable(), true);
  store.set('provider/anthropic/company-a', secret);
  assert.equal(store.get('provider/anthropic/company-a'), secret);
  assert.equal(store.delete('provider/anthropic/company-a'), true);

  const write = calls.find((call) => call.args[0] === 'add-generic-password');
  assert.ok(write);
  assert.equal(write.args.at(-1), '-w');
  assert.equal(write.args.some((arg) => arg.includes(secret)), false);
  assert.equal(write.input, `${secret}\n`);
});

test('macOS Keychain errors redact the secret value', () => {
  const secret = 'sk-openai-secret-on-error';
  const store = new MacOSKeychainSecretStore(
    'com.test.local-coder',
    (args, input) => ({
      status: args[0] === 'help' ? 0 : 1,
      stdout: '',
      stderr: args[0] === 'help' ? '' : `unexpected ${input ?? secret}`
    }),
    'darwin'
  );
  assert.throws(
    () => store.set('provider/openai/company-a', secret),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      assert.ok(error.message.includes('[REDACTED]'));
      return true;
    }
  );
});

test('credential metadata never persists API keys', () => {
  const dir = tempDir('credentials');
  const file = path.join(dir, 'credentials.json');
  const profiles = new CredentialProfileStore(file);
  const keychain = new MemorySecretStore();
  const manager = new CredentialManager(profiles, {
    keychain,
    environment: {
      backend: 'environment',
      isAvailable: () => true,
      get: (id) => id === 'OPENAI_API_KEY' ? 'env-openai-value' : undefined,
      set: () => { throw new Error('read-only'); },
      delete: () => { throw new Error('read-only'); }
    }
  });
  const anthropicSecret = 'sk-ant-never-write-me';

  const profile = manager.addOrReplaceKeychainCredential({
    id: 'company-a-anthropic',
    providerId: 'anthropic',
    label: 'Company A Anthropic',
    organizationId: 'company-a',
    secret: anthropicSecret
  });
  manager.addEnvironmentCredential({
    id: 'headless-openai',
    providerId: 'openai',
    label: 'Headless OpenAI',
    organizationId: 'personal',
    environmentVariable: 'OPENAI_API_KEY'
  });

  assert.equal(profile.secret.backend, 'macos-keychain');
  assert.equal(manager.resolve('company-a-anthropic'), anthropicSecret);
  assert.equal(manager.resolve('headless-openai'), 'env-openai-value');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(anthropicSecret), false);
  assert.equal(raw.includes('sk-ant-'), false);
  assert.ok(raw.includes('provider/anthropic/company-a-anthropic'));
  assert.equal(manager.remove('company-a-anthropic'), true);
  assert.equal(keychain.values.size, 0);
});

test('projects default to local-only-safe settings and persist isolation fields', () => {
  const dir = tempDir('projects');
  const store = new ProjectStore(path.join(dir, 'projects.json'));
  const project = store.create({
    id: 'change-pilot',
    name: 'ChangePilot',
    workspace: path.join(dir, 'repo'),
    organizationId: 'personal'
  });

  assert.equal(project.defaultRoutingPolicy, 'local-first');
  assert.deepEqual(project.defaultModel, { mode: 'auto' });
  assert.equal(project.privacy.cloudAllowed, false);
  assert.deepEqual(project.privacy.allowedProviderIds, ['ollama']);
  assert.equal(project.repoIntelligenceScope, 'project');
  assert.equal(project.concurrency, 1);
  assert.equal(project.budgets.hardStopFraction, 1);
  assert.deepEqual(project.budgets.warningFractions, [0.5, 0.75, 0.9]);
  assert.match(projectIsolationKey(project), /^[a-f0-9]{64}$/);
  assert.deepEqual(store.get('change-pilot'), project);
});

test('corporate projects enforce provider and credential organization isolation', () => {
  const dir = tempDir('corporate-project');
  const store = new ProjectStore(path.join(dir, 'projects.json'));
  const project = store.create({
    id: 'live-nation',
    name: 'LiveNation',
    workspace: path.join(dir, 'live-nation'),
    organizationId: 'live-nation',
    organizationName: 'Live Nation',
    defaultRoutingPolicy: 'speed-first',
    defaultModel: { mode: 'explicit', providerId: 'anthropic', modelId: 'claude-sonnet-5' },
    privacy: {
      cloudAllowed: true,
      allowedProviderIds: ['ollama', 'anthropic']
    },
    credentialProfileIds: { anthropic: 'live-nation-anthropic' },
    budgets: { monthlyUsd: 100, perJobUsd: 5 },
    concurrency: 2
  });

  const validCredential: CredentialProfile = {
    id: 'live-nation-anthropic',
    providerId: 'anthropic',
    label: 'Live Nation Anthropic',
    organizationId: 'live-nation',
    secret: { backend: 'macos-keychain', id: 'provider/anthropic/live-nation-anthropic' },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  assert.doesNotThrow(() => assertProjectCredentialIsolation(project, [validCredential]));
  assert.throws(
    () => assertProjectCredentialIsolation(project, [{ ...validCredential, organizationId: 'company-b' }]),
    /outside project.*organization isolation boundary/
  );
  assert.throws(
    () => assertProjectCredentialIsolation(project, [{ ...validCredential, providerId: 'openai' }]),
    /belongs to openai, not anthropic/
  );
});

test('control-plane v2 writer strips legacy inline worker token while legacy files remain readable', () => {
  const dir = tempDir('control-plane');
  const file = path.join(dir, 'control-plane.json');
  const previous = process.env.LOCAL_CODER_CONTROL_PLANE_CONFIG_PATH;
  process.env.LOCAL_CODER_CONTROL_PLANE_CONFIG_PATH = file;
  try {
    writeControlPlaneConfig({
      executionMode: 'remote',
      remoteWorkerUrl: 'http://windows-worker:7337',
      remoteWorkerToken: 'legacy-worker-secret',
      remoteWorkerCredentialRef: 'remote-worker/default',
      model: 'qwen3.8:27b'
    });
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('legacy-worker-secret'), false);
    assert.equal(raw.includes('remoteWorkerToken'), false);
    const modern = readControlPlaneConfig();
    assert.equal(modern?.version, 2);
    assert.equal(modern?.remoteWorkerCredentialRef, 'remote-worker/default');

    fs.writeFileSync(file, JSON.stringify({
      executionMode: 'remote',
      remoteWorkerUrl: 'http://legacy:7337',
      remoteWorkerToken: 'legacy-worker-secret',
      model: 'qwen3.8:27b'
    }));
    const legacy = readControlPlaneConfig();
    assert.equal(legacy?.remoteWorkerToken, 'legacy-worker-secret');
    assert.equal(loadConfig({}).remoteWorkerToken, 'legacy-worker-secret');
  } finally {
    if (previous === undefined) delete process.env.LOCAL_CODER_CONTROL_PLANE_CONFIG_PATH;
    else process.env.LOCAL_CODER_CONTROL_PLANE_CONFIG_PATH = previous;
  }
});
