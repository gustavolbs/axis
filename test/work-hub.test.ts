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
  assert.equal(snapshot.tickets[0]?.system, 'Jira');
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

test('Work Hub Messages is restricted to Jira comments and Slack, including for Codex', async () => {
  const sources = new WorkHubSourceStore(temp('local-coder-work-hub-message-scope-'));
  const connection = {
    id: 'chatgpt-account-scope', providerFamily: 'openai', label: 'ChatGPT Scope', auth: 'chatgpt-account',
    billing: 'subscription', available: true, supportsMcpSources: true, accountProfileId: 'scope'
  };
  const connections = { view: (id: string) => id === connection.id ? connection : undefined } as unknown as ProviderConnectionRuntime;
  let prompt = '';
  let mcpPolicies: Array<{ serverId: string; toolNames?: string[]; enabled?: boolean }> | undefined;
  const codexRuntime = {
    listMcp: async () => ({
      stdout: JSON.stringify([
        { name: 'jira', enabled: true, transport: { type: 'streamable_http', url: 'https://jira.example.test/mcp' }, auth_status: 'authenticated' },
        { name: 'slack', enabled: true, transport: { type: 'streamable_http', url: 'https://slack.example.test/mcp' }, auth_status: 'authenticated' },
        { name: 'github', enabled: true, transport: { type: 'streamable_http', url: 'https://github.example.test/mcp' }, auth_status: 'authenticated' }
      ]),
      stderr: '', exitCode: 0, durationMs: 1, timedOut: false, cancelled: false
    }),
    invoke: async (_profileId: string, nextPrompt: string, options: { mcpPolicies?: Array<{ serverId: string; toolNames?: string[]; enabled?: boolean }> }) => {
      prompt = nextPrompt;
      mcpPolicies = options.mcpPolicies;
      return {
        stdout: JSON.stringify({ messages: [] }),
        stderr: '', exitCode: 0, durationMs: 1, timedOut: false, cancelled: false
      };
    }
  } as unknown as CodexAccountRuntime;
  const service = new WorkHubService(sources, { connections, codexRuntime });
  service.upsertSource({ id: 'scope-messages', label: 'Messages', connectionId: connection.id, kind: 'messages' });

  await service.refresh('scope-messages');
  assert.deepEqual(mcpPolicies, [
    { serverId: 'jira', enabled: true },
    { serverId: 'slack', enabled: true },
    { serverId: 'github', enabled: false }
  ]);
  assert.match(prompt, /recent comments.*assigned Jira tickets/i);
  assert.match(prompt, /recent Slack messages/i);
  assert.match(prompt, /Do not access GitHub, email, Teams, calendars/i);
});

test('Work Hub persists local message read and dismissal state', async () => {
  const { service, sources } = harness();
  service.upsertSource({
    id: 'message-actions',
    label: 'Messages',
    connectionId: chatGptAccountConnectionId('personal'),
    kind: 'messages'
  });
  await service.refresh('message-actions');
  assert.equal(service.snapshot().messages.length, 1);
  assert.equal(service.snapshot().messages[0]?.unread, true);

  service.markMessageRead('message-actions', 'msg-1');
  assert.equal(service.snapshot().messages[0]?.unread, false);
  assert.equal(service.snapshot().messages[0]?.requiresAttention, false);

  const restored = new WorkHubService(sources);
  assert.equal(restored.snapshot().messages[0]?.unread, false);
  restored.dismissMessage('message-actions', 'msg-1');
  assert.equal(restored.snapshot().messages.length, 0);
  assert.equal(new WorkHubService(sources).snapshot().messages.length, 0);
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
  assert.equal(snapshot.events[0]?.system, 'Google Calendar');
});

test('legacy memory retention migrates to the persistent normalized cache', async () => {
  const { service, sources } = harness();
  const source = service.upsertSource({
    id: 'memory-calendar',
    label: 'Memory Calendar',
    connectionId: claudeAccountConnectionId('livenation'),
    kind: 'calendar',
    system: 'Google Calendar',
    retention: 'memory'
  });
  await service.refresh('memory-calendar');
  assert.equal(source.retention, 'local');
  assert.equal(fs.existsSync(sources.cacheFile('memory-calendar')), true);
});

test('local retention persists only normalized cache, never auth credentials', async () => {
  const { service, sources } = harness();
  service.upsertSource({
    id: 'cached-calendar',
    label: 'Cached Calendar',
    connectionId: claudeAccountConnectionId('livenation'),
    kind: 'calendar',
    system: 'Google Calendar',
    retention: 'local'
  });
  await service.refresh('cached-calendar');
  const cache = fs.readFileSync(sources.cacheFile('cached-calendar'), 'utf8');
  assert.match(cache, /Daily/);
  assert.doesNotMatch(cache, /oauth|bearer|sk-ant|credentials/i);
});

test('Work Hub restores cached data immediately after a restart', async () => {
  const { service, sources } = harness();
  service.upsertSource({
    id: 'restart-calendar',
    label: 'Restart Calendar',
    connectionId: claudeAccountConnectionId('livenation'),
    kind: 'calendar'
  });
  await service.refresh('restart-calendar');

  const restored = new WorkHubService(sources);
  const snapshot = restored.snapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.title, 'Daily');
  assert.equal(snapshot.sourceStates[0]?.status, 'ready');
  assert.equal(snapshot.sourceStates[0]?.itemCount, 1);
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
    id: 'bad-source', label: 'Bad', connectionId: 'openai-api-test', kind: 'tickets', system: 'Jira', retention: 'memory'
  }), /model-only|account connection/i);
});

test('Work Hub auto-discovers account connectors without manual MCP tool names', async () => {
  const { service } = harness();
  const source = service.upsertSource({
    id: 'auto-work',
    label: 'LiveNation Work',
    connectionId: claudeAccountConnectionId('livenation'),
    kind: 'tickets',
    retention: 'memory'
  });
  assert.deepEqual(source.toolAllowlist, []);
  assert.equal(source.system, 'Connected services');
  const snapshot = await service.refresh('auto-work');
  assert.equal(snapshot.tickets.length, 1);
  assert.equal(snapshot.tickets[0]?.system, 'Jira');
  assert.deepEqual(snapshot.sourceStates[0]?.systems, ['LN Jira']);
});

test('Work Hub uses the fast Teams and Jira intents for enterprise collectors', async () => {
  const sources = new WorkHubSourceStore(temp('local-coder-work-hub-enterprise-prompts-'));
  const connection = {
    id: 'claude-account-enterprise', providerFamily: 'anthropic', label: 'Claude Enterprise', auth: 'claude-account',
    billing: 'subscription', available: true, supportsMcpSources: true, accountProfileId: 'enterprise'
  };
  const connections = { view: () => connection } as unknown as ProviderConnectionRuntime;
  const prompts: string[] = [];
  const claudeRuntime = {
    listMcp: async () => ({
      stdout: 'claude.ai Microsoft 365: https://microsoft.example.test/mcp - ✔ Connected\nclaude.ai LN Jira: https://jira.example.test/mcp - ✔ Connected\n',
      stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false
    }),
    invoke: async (_profileId: string, prompt: string) => {
      prompts.push(prompt);
      return {
        stdout: prompt.includes('MCP do Teams') ? JSON.stringify({ events: [] }) : JSON.stringify({ tickets: [] }),
        stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false
      };
    }
  } as unknown as ClaudeAccountRuntime;
  const service = new WorkHubService(sources, { connections, claudeRuntime });
  service.upsertSource({ id: 'enterprise-calendar', label: 'Enterprise Calendar', connectionId: connection.id, kind: 'calendar' });
  service.upsertSource({ id: 'enterprise-tickets', label: 'Enterprise Tickets', connectionId: connection.id, kind: 'tickets' });

  await service.refresh();
  assert.match(prompts.find((prompt) => prompt.includes('MCP do Teams')) ?? '', /reuniões/);
  assert.match(prompts.find((prompt) => prompt.includes('MCP do Jira')) ?? '', /assignadas pra mim/);
});

test('Work Hub reports live progress and limits Claude to relevant connector servers', async () => {
  const sources = new WorkHubSourceStore(temp('local-coder-work-hub-progress-'));
  const connection = {
    id: 'claude-account-progress', providerFamily: 'anthropic', label: 'Claude Progress', auth: 'claude-account',
    billing: 'subscription', available: true, supportsMcpSources: true, accountProfileId: 'progress'
  };
  const connections = { view: (id: string) => id === connection.id ? connection : undefined } as unknown as ProviderConnectionRuntime;
  let release: (() => void) | undefined;
  let invokeCount = 0;
  let allowedTools: string[] | undefined;
  const claudeRuntime = {
    listMcp: async () => ({
      stdout: 'claude.ai Google Calendar: https://calendar.example.test/mcp - ✔ Connected\nclaude.ai Slack: https://slack.example.test/mcp - ✔ Connected\n',
      stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false
    }),
    invoke: async (_profileId: string, _prompt: string, options: { allowedTools?: string[] }) => {
      invokeCount += 1;
      allowedTools = options.allowedTools;
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        stdout: JSON.stringify({ events: [{ externalId: 'evt-live', system: 'Google Calendar', title: 'Live progress', start: '2026-09-02T12:00:00Z', end: '2026-09-02T12:30:00Z' }] }),
        stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false
      };
    }
  } as unknown as ClaudeAccountRuntime;
  const service = new WorkHubService(sources, { connections, claudeRuntime });
  service.upsertSource({ id: 'progress-calendar', label: 'Progress calendar', connectionId: connection.id, kind: 'calendar' });

  const first = service.refresh('progress-calendar');
  const duplicate = service.refresh('progress-calendar');
  await new Promise((resolve) => setImmediate(resolve));
  const progress = service.snapshot().sourceStates[0];
  assert.equal(progress?.status, 'syncing');
  assert.equal(progress?.stage, 'collecting');
  assert.deepEqual(progress?.systems, ['Google Calendar']);
  assert.ok(progress?.syncStartedAt);
  assert.deepEqual(allowedTools, ['mcp__claude_ai_Google_Calendar__*']);
  assert.equal(invokeCount, 1);

  release?.();
  await Promise.all([first, duplicate]);
  const ready = service.snapshot().sourceStates[0];
  assert.equal(ready?.status, 'ready');
  assert.equal(ready?.itemCount, 1);
  assert.equal(ready?.stage, undefined);
  assert.ok(ready?.durationMs !== undefined);
});

test('Work Hub persists actionable sync failures across restarts', async () => {
  const sources = new WorkHubSourceStore(temp('local-coder-work-hub-state-'));
  const connection = {
    id: 'claude-account-state', providerFamily: 'anthropic', label: 'Claude State', auth: 'claude-account',
    billing: 'subscription', available: true, supportsMcpSources: true, accountProfileId: 'state'
  };
  const connections = { view: () => connection } as unknown as ProviderConnectionRuntime;
  const claudeRuntime = {
    listMcp: async () => ({ stdout: 'claude.ai Slack: https://slack.example.test/mcp - ✔ Connected\n', stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false })
  } as unknown as ClaudeAccountRuntime;
  const service = new WorkHubService(sources, { connections, claudeRuntime });
  service.upsertSource({ id: 'missing-calendar', label: 'Missing calendar', connectionId: connection.id, kind: 'calendar' });
  await service.refresh('missing-calendar');
  assert.match(service.snapshot().sourceStates[0]?.error ?? '', /No connected calendar connector/);

  const restored = new WorkHubService(sources, { connections, claudeRuntime });
  assert.equal(restored.snapshot().sourceStates[0]?.status, 'error');
  assert.match(restored.snapshot().sourceStates[0]?.error ?? '', /Settings → Connections/);
});
