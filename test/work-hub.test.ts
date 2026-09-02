import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from '../src/claude-account-profiles.js';
import { CodexAccountProfileStore, CodexAccountRuntime } from '../src/codex-account-profiles.js';
import {
  ProviderConnectionRuntime,
  claudeAccountConnectionId,
  chatGptAccountConnectionId
} from '../src/provider-connections.js';
import { WorkHubService, WorkHubSourceStore } from '../src/work-hub.js';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function harness() {
  const claudeProfiles = new ClaudeAccountProfileStore(temp('local-coder-work-hub-claude-'));
  const codexProfiles = new CodexAccountProfileStore(temp('local-coder-work-hub-codex-'));
  claudeProfiles.create({ id: 'livenation', name: 'Claude LiveNation', organizationLabel: 'LiveNation' });
  codexProfiles.create({ id: 'personal', name: 'ChatGPT Personal' });
  const claudeRuntime = new ClaudeAccountRuntime(claudeProfiles, {
    claudeBinary: process.execPath,
    commandPrefixArgs: [fakeClaude],
    terminationGraceMs: 50
  });
  const codexRuntime = new CodexAccountRuntime(codexProfiles, {
    codexBinary: process.execPath,
    commandPrefixArgs: [fakeCodex],
    terminationGraceMs: 50
  });
  const connections = new ProviderConnectionRuntime({
    claudeProfiles,
    claudeRuntime,
    codexProfiles,
    codexRuntime
  });
  const sources = new WorkHubSourceStore(temp('local-coder-work-hub-store-'));
  const service = new WorkHubService(sources, {
    connections,
    claudeProfiles,
    claudeRuntime,
    codexProfiles,
    codexRuntime
  });
  return { service, sources };
}

test('Work Hub normalizes Jira-like ticket states while preserving the source status', async () => {
  const { service } = harness();
  service.upsertSource({
    id: 'livenation-jira',
    label: 'LiveNation Jira',
    connectionId: claudeAccountConnectionId('livenation'),
    kind: 'tickets',
    system: 'Jira',
    toolAllowlist: ['mcp__claude_ai_LN_Jira__jira_search'],
    retention: 'memory'
  });
  const snapshot = await service.refresh('livenation-jira');
  assert.equal(snapshot.tickets.length, 1);
  assert.equal(snapshot.tickets[0]?.status, 'Ready for Code Review');
  assert.equal(snapshot.tickets[0]?.normalizedStatus, 'review');
  assert.equal(snapshot.tickets[0]?.connectionId, claudeAccountConnectionId('livenation'));
  assert.equal(snapshot.tickets[0]?.providerFamily, 'anthropic');
});

test('Work Hub collects ChatGPT/Codex MCP data into the same normalized store', async () => {
  const { service } = harness();
  service.upsertSource({
    id: 'personal-messages',
    label: 'Personal Inbox',
    connectionId: chatGptAccountConnectionId('personal'),
    kind: 'messages',
    system: 'Teams',
    toolAllowlist: ['teams/read_messages'],
    retention: 'memory'
  });
  const snapshot = await service.refresh('personal-messages');
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0]?.requiresAttention, true);
  assert.equal(snapshot.messages[0]?.providerFamily, 'openai');
});

test('Work Hub keeps calendar data normalized and source-scoped', async () => {
  const { service } = harness();
  service.upsertSource({
    id: 'company-calendar',
    label: 'Company Calendar',
    connectionId: claudeAccountConnectionId('livenation'),
    kind: 'calendar',
    system: 'Google Calendar',
    toolAllowlist: ['mcp__claude_ai_Google_Calendar__list_events'],
    retention: 'memory'
  });
  const snapshot = await service.refresh('company-calendar');
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.title, 'Daily');
  assert.equal(snapshot.events[0]?.sourceId, 'company-calendar');
  assert.equal(snapshot.events[0]?.calendar, 'livenation');
});

test('memory retention does not write normalized remote data to disk', async () => {
  const { service, sources } = harness();
  service.upsertSource({
    id: 'memory-calendar',
    label: 'Memory Calendar',
    connectionId: claudeAccountConnectionId('livenation'),
    kind: 'calendar',
    system: 'Google Calendar',
    toolAllowlist: ['mcp__claude_ai_Google_Calendar__list_events'],
    retention: 'memory'
  });
  await service.refresh('memory-calendar');
  assert.equal(fs.existsSync(sources.cacheFile('memory-calendar')), false);
});

test('local retention persists only normalized cache, never auth credentials', async () => {
  const { service, sources } = harness();
  service.upsertSource({
    id: 'cached-calendar',
    label: 'Cached Calendar',
    connectionId: claudeAccountConnectionId('livenation'),
    kind: 'calendar',
    system: 'Google Calendar',
    toolAllowlist: ['mcp__claude_ai_Google_Calendar__list_events'],
    retention: 'local'
  });
  await service.refresh('cached-calendar');
  const cache = fs.readFileSync(sources.cacheFile('cached-calendar'), 'utf8');
  assert.match(cache, /Daily/);
  assert.doesNotMatch(cache, /oauth|bearer|sk-ant|credentials/i);
});

test('Work Hub refuses model-only/API connections as MCP data sources', () => {
  const sources = new WorkHubSourceStore(temp('local-coder-work-hub-model-only-'));
  const connections = {
    view: () => ({
      id: 'openai-api-test', providerFamily: 'openai', label: 'GPT API', auth: 'api-key', billing: 'api',
      available: true, supportsMcpSources: false
    })
  } as unknown as ProviderConnectionRuntime;
  const service = new WorkHubService(sources, { connections });
  assert.throws(() => service.upsertSource({
    id: 'bad-source', label: 'Bad', connectionId: 'openai-api-test', kind: 'tickets', system: 'Jira',
    toolAllowlist: ['jira/read'], retention: 'memory'
  }), /model-only|account connection/i);
});

test('Work Hub requires an explicit MCP tool allowlist', () => {
  const { service } = harness();
  assert.throws(() => service.upsertSource({
    id: 'unsafe', label: 'Unsafe', connectionId: claudeAccountConnectionId('livenation'), kind: 'tickets', system: 'Jira',
    toolAllowlist: [], retention: 'memory'
  }), /requires at least one exact read-only MCP tool/i);
});
