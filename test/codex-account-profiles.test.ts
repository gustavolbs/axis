import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CodexAccountProfileStore,
  CodexAccountRuntime
} from '../src/codex-account-profiles.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-codex-profiles-'));
}

function fakeRuntime(root: string, baseEnv: NodeJS.ProcessEnv = process.env) {
  const store = new CodexAccountProfileStore(root);
  const runtime = new CodexAccountRuntime(store, {
    codexBinary: process.execPath,
    commandPrefixArgs: [fixture],
    baseEnv,
    terminationGraceMs: 50
  });
  return { store, runtime };
}

test('Codex account profiles always use distinct CODEX_HOME directories', () => {
  const store = new CodexAccountProfileStore(tempRoot());
  const personal = store.create({ id: 'personal', name: 'Personal' });
  const company = store.create({ id: 'company', name: 'Company' });
  assert.notEqual(personal.configDir, company.configDir);
  assert.equal(path.dirname(personal.configDir), path.dirname(company.configDir));
});

test('Codex profile ids reject traversal', () => {
  const store = new CodexAccountProfileStore(tempRoot());
  for (const id of ['', '.', '..', '../escape', 'a/b', 'a\\b', '/tmp/escape']) {
    assert.throws(() => store.create({ id, name: 'Unsafe' }), /profile id|safe filename/i);
  }
});

test('Codex status is profile-scoped and reports ChatGPT auth without credentials', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });
  const status = await runtime.status('personal');
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'chatgpt');
  assert.match(status.detail ?? '', /Logged in using ChatGPT/);
  assert.equal('token' in status, false);
});

test('Codex invocation receives only the selected CODEX_HOME and never falls back', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  const personal = store.create({ id: 'personal', name: 'Personal' });
  const enterprise = store.create({ id: 'enterprise', name: 'Enterprise' });
  const result = await runtime.invoke('personal', 'OK');
  assert.match(result.stdout, new RegExp(personal.configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stdout, new RegExp(enterprise.configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assert.rejects(() => runtime.invoke('missing', 'OK'), /Unknown Codex account profile/);
});

test('Codex invocation applies read-only sandbox, never approval and ephemeral session', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });
  const result = await runtime.invoke('personal', 'OK');
  assert.match(result.stdout, /"-a","never"/);
  assert.match(result.stdout, /"--sandbox","read-only"/);
  assert.match(result.stdout, /"--ephemeral"/);
});

test('Codex MCP policies are explicit per server/tool', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });
  const result = await runtime.invoke('personal', 'OK', {
    mcpPolicies: [{ serverId: 'calendar', toolNames: ['list_events', 'get_event'] }]
  });
  assert.match(result.stdout, /enabled_tools/);
  assert.match(result.stdout, /list_events/);
  assert.match(result.stdout, /get_event/);
  assert.match(result.stdout, /default_tools_approval_mode/);
});

test('ambient OpenAI credentials are not inherited by Codex account subprocesses', async () => {
  const { store, runtime } = fakeRuntime(tempRoot(), {
    ...process.env,
    OPENAI_API_KEY: 'known-sensitive-openai-api-key-value',
    CODEX_API_KEY: 'known-sensitive-codex-api-key-value',
    CODEX_ACCESS_TOKEN: 'known-sensitive-codex-access-token-value'
  });
  store.create({ id: 'personal', name: 'Personal' });
  const result = await runtime.invoke('personal', 'OK');
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /known-sensitive/);
});

test('Codex output redacts secret-shaped values', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });
  const result = await runtime.invoke('personal', 'LEAK');
  assert.doesNotMatch(result.stdout, /sk-proj-example-secret/);
  assert.doesNotMatch(result.stderr, /abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.match(result.stderr, /Bearer \[REDACTED\]/);
});

test('Codex timeout and AbortSignal terminate the child', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });
  const timed = await runtime.invoke('personal', 'HANG', { timeoutMs: 80 });
  assert.equal(timed.timedOut, true);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const cancelled = await runtime.invoke('personal', 'HANG', { timeoutMs: 5_000, signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
});

test('missing Codex binary gives a clear error', async () => {
  const store = new CodexAccountProfileStore(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });
  const runtime = new CodexAccountRuntime(store, { codexBinary: path.join(tempRoot(), 'missing-codex') });
  const discovery = await runtime.discover();
  assert.equal(discovery.installed, false);
  assert.match(discovery.error ?? '', /Codex runtime not found/);
  await assert.rejects(() => runtime.invoke('personal', 'OK'), /Codex runtime not found/);
});

test('Codex profile metadata never persists OAuth/API token fields', () => {
  const root = tempRoot();
  const store = new CodexAccountProfileStore(root);
  store.create({ id: 'personal', name: 'Personal', oauthToken: 'must-not-persist' } as Parameters<typeof store.create>[0] & { oauthToken: string });
  const metadata = fs.readFileSync(store.metadataPath(), 'utf8');
  assert.doesNotMatch(metadata, /must-not-persist|oauthToken/i);
});

test('Codex MCP management is profile-scoped and delegates to the official CLI', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  const profile = store.create({ id: 'personal', name: 'Personal' });
  const added = await runtime.addRemoteMcp('personal', { name: 'trusted-mcp', url: 'https://mcp.example.test/mcp' });
  assert.match(added.stdout, new RegExp(profile.configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(added.stdout, /"add","trusted-mcp","--url","https:\/\/mcp\.example\.test\/mcp"/);
  const removed = await runtime.removeMcp('personal', 'trusted-mcp');
  assert.match(removed.stdout, /"remove","trusted-mcp"/);
});
