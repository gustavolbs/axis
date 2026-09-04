import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ClaudeAccountProfileStore,
  ClaudeAccountRuntime,
  claudeResultEnvelopeError,
  parseClaudeResultEnvelope
} from '../src/claude-account-profiles.js';
import { DEFAULT_PROVIDER_CAPABILITIES } from '../src/provider-settings.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-claude-profiles-'));
}

function fakeRuntime(root: string, baseEnv: NodeJS.ProcessEnv = process.env): {
  store: ClaudeAccountProfileStore;
  runtime: ClaudeAccountRuntime;
} {
  const store = new ClaudeAccountProfileStore(root);
  const runtime = new ClaudeAccountRuntime(store, {
    claudeBinary: process.execPath,
    commandPrefixArgs: [fixture],
    baseEnv,
    terminationGraceMs: 50
  });
  return { store, runtime };
}

test('two profiles always resolve to different config directories', () => {
  const root = tempRoot();
  const store = new ClaudeAccountProfileStore(root);
  const personal = store.create({ id: 'personal', name: 'Personal' });
  const enterprise = store.create({ id: 'livenation', name: 'LiveNation' });
  assert.notEqual(personal.configDir, enterprise.configDir);
  assert.equal(path.dirname(personal.configDir), path.resolve(root));
  assert.equal(path.dirname(enterprise.configDir), path.resolve(root));
});

test('invalid profile ids and path traversal are rejected', () => {
  const store = new ClaudeAccountProfileStore(tempRoot());
  for (const id of ['', '.', '..', '../other', 'a/b', 'a\\b', '/tmp/escape']) {
    assert.throws(() => store.create({ id, name: 'Unsafe' }), /profile id|safe filename/i);
  }
});

test('execution receives exactly the selected CLAUDE_CONFIG_DIR and never falls back to another profile', async () => {
  const root = tempRoot();
  const { store, runtime } = fakeRuntime(root);
  const personal = store.create({ id: 'personal', name: 'Personal' });
  const enterprise = store.create({ id: 'enterprise', name: 'Enterprise' });

  const personalResult = await runtime.invoke('personal', 'OK');
  assert.match(personalResult.stdout, new RegExp(`profile=${personal.configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(personalResult.stdout, new RegExp(enterprise.configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const enterpriseResult = await runtime.invoke('enterprise', 'OK');
  assert.match(enterpriseResult.stdout, new RegExp(`profile=${enterprise.configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.rejects(() => runtime.invoke('missing', 'OK'), /Unknown Claude account profile/);
  assert.rejects(() => runtime.invoke('', 'OK'), /profile id/i);
});

test('Claude account invocation forwards an explicit stable model alias', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });
  const result = await runtime.invoke('personal', 'OK', { model: 'sonnet' });
  assert.match(result.stdout, /"--model","sonnet"/);
});

test('Claude account invocation captures the canonical served model from result metadata', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });

  const result = await runtime.invoke('personal', 'OK', {
    model: 'opus',
    captureResultMetadata: true
  });
  assert.equal(result.model, 'claude-opus-5');
  assert.match(result.stdout, /"--output-format","json"/);
  assert.doesNotMatch(result.stdout, /modelUsage/);
});

test('status exposes allowlisted identity metadata but never raw credential fields', async () => {
  const root = tempRoot();
  const { store, runtime } = fakeRuntime(root);
  store.create({ id: 'personal', name: 'Personal' });
  const status = await runtime.status('personal');
  assert.equal(status.authenticated, true);
  assert.equal(status.email, 'personal@example.test');
  assert.equal(status.organization, 'personal');
  assert.equal('oauthToken' in status, false);
});

test('stdout and stderr redact token-shaped values', async () => {
  const root = tempRoot();
  const { store, runtime } = fakeRuntime(root, {
    ...process.env,
    ANTHROPIC_API_KEY: 'known-sensitive-api-key-value',
    SOME_SECRET: 'known-sensitive-secret-value'
  });
  store.create({ id: 'personal', name: 'Personal' });
  const result = await runtime.invoke('personal', 'LEAK');
  assert.doesNotMatch(result.stdout, /sk-ant-/);
  assert.doesNotMatch(result.stderr, /abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(result.stdout, /\[REDACTED\]/);
  assert.match(result.stderr, /Bearer \[REDACTED\]/);
});

test('timeout terminates the subprocess', async () => {
  const root = tempRoot();
  const { store, runtime } = fakeRuntime(root);
  store.create({ id: 'personal', name: 'Personal' });
  const startedAt = Date.now();
  const result = await runtime.invoke('personal', 'HANG', { timeoutMs: 80 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 2_000, 'timed out child should be terminated promptly');
  assert.notEqual(result.signal, null);
});

test('AbortSignal cancellation terminates the subprocess', async () => {
  const root = tempRoot();
  const { store, runtime } = fakeRuntime(root);
  store.create({ id: 'personal', name: 'Personal' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const startedAt = Date.now();
  const result = await runtime.invoke('personal', 'HANG', { timeoutMs: 5_000, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 2_000, 'cancelled child should be terminated promptly');
  assert.notEqual(result.signal, null);
});

test('structured Claude collection finishes when complete JSON arrives even if MCP keeps the process open', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  store.create({ id: 'personal', name: 'Personal' });
  const result = await runtime.invoke('personal', 'JSON_THEN_HANG', { timeoutMs: 5_000, stopOnValidJson: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  assert.ok(result.durationMs < 2_000);
});

test('missing Claude binary produces a clear discovery and invocation error', async () => {
  const store = new ClaudeAccountProfileStore(tempRoot());
  const runtime = new ClaudeAccountRuntime(store, {
    claudeBinary: path.join(tempRoot(), 'definitely-missing-claude')
  });
  store.create({ id: 'personal', name: 'Personal' });
  const discovery = await runtime.discover();
  assert.equal(discovery.installed, false);
  assert.equal(discovery.usable, false);
  assert.match(discovery.error ?? '', /Claude Code runtime not found/);
  await assert.rejects(() => runtime.invoke('personal', 'OK'), /Claude Code runtime not found/);
});

test('persisted profile metadata cannot contain OAuth tokens', () => {
  const root = tempRoot();
  const store = new ClaudeAccountProfileStore(root);
  store.create({
    id: 'personal',
    name: 'Personal',
    organizationLabel: 'Personal org',
    oauthToken: 'must-not-persist'
  } as Parameters<typeof store.create>[0] & { oauthToken: string });
  const metadata = fs.readFileSync(store.metadataPath(), 'utf8');
  assert.doesNotMatch(metadata, /must-not-persist/);
  assert.doesNotMatch(metadata, /oauthToken/i);
});

test('ambient provider secrets are not inherited by Claude account subprocesses', async () => {
  const root = tempRoot();
  const baseEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: 'known-sensitive-api-key-value',
    ANTHROPIC_AUTH_TOKEN: 'known-sensitive-auth-token-value',
    CLAUDE_CODE_OAUTH_TOKEN: 'known-sensitive-oauth-token-value'
  };
  const { store, runtime } = fakeRuntime(root, baseEnv);
  store.create({ id: 'personal', name: 'Personal' });
  const result = await runtime.invoke('personal', 'OK');
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /known-sensitive/);
});

test('Claude MCP management is profile-scoped and accepts only safe remote connectors', async () => {
  const { store, runtime } = fakeRuntime(tempRoot());
  const profile = store.create({ id: 'personal', name: 'Personal' });
  const added = await runtime.addRemoteMcp('personal', { name: 'trusted-mcp', url: 'https://mcp.example.test/mcp' });
  assert.match(added.stdout, new RegExp(profile.configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(added.stdout, /"--transport","http","--scope","user","trusted-mcp"/);
  const removed = await runtime.removeMcp('personal', 'trusted-mcp');
  assert.match(removed.stdout, /"remove","--scope","user","trusted-mcp"/);
  await assert.rejects(() => runtime.addRemoteMcp('personal', { name: '../unsafe', url: 'https://mcp.example.test/mcp' }), /connector name/i);
  await assert.rejects(() => runtime.addRemoteMcp('personal', { name: 'unsafe-url', url: 'http://mcp.example.test/mcp' }), /HTTPS/i);
  await assert.rejects(() => runtime.addRemoteMcp('personal', { name: 'secret-url', url: 'https://mcp.example.test/mcp?token=secret' }), /query parameters/i);
});

test('spike does not weaken the existing provider capability defaults', () => {
  assert.equal(DEFAULT_PROVIDER_CAPABILITIES.mcps.enabled, false);
  assert.equal(DEFAULT_PROVIDER_CAPABILITIES.plugins.enabled, false);
  assert.equal(DEFAULT_PROVIDER_CAPABILITIES.tools.enabled, false);

  const source = fs.readFileSync(fileURLToPath(new URL('../src/claude-account-profiles.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /ProviderBudget|ProviderSettingsStore|ProviderCapabilityPolicyManager|ProjectStore/);
});

test('the result envelope is found even when MCP diagnostics pollute stdout', () => {
  const noisy = 'Client.listTools() called but server does not advertise tools capability\n'
    + JSON.stringify({ type: 'result', is_error: false, result: 'OK', modelUsage: {} })
    + '\ntrailing diagnostic line';
  const envelope = parseClaudeResultEnvelope(noisy);
  assert.equal(envelope?.result, 'OK');
  assert.equal(claudeResultEnvelopeError(envelope), undefined);
});

test('turn-level CLI failures inside a zero-exit result envelope surface as errors with reconnect guidance', async () => {
  const root = tempRoot();
  const failing = path.join(root, 'fake-claude-not-logged-in.mjs');
  fs.writeFileSync(failing, [
    "process.stdout.write('Client.listTools() warning noise\\n');",
    "process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', modelUsage: {} }) + '\\n');",
    'process.exit(0);'
  ].join('\n'));
  const store = new ClaudeAccountProfileStore(root);
  const runtime = new ClaudeAccountRuntime(store, {
    claudeBinary: process.execPath,
    commandPrefixArgs: [failing],
    terminationGraceMs: 50
  });
  store.create({ id: 'personal', name: 'Personal' });
  await assert.rejects(
    () => runtime.invoke('personal', 'OK', { captureResultMetadata: true }),
    /Not logged in[\s\S]*Settings → Connections/
  );
});
