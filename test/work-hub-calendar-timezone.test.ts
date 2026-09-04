import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ClaudeAccountRuntime } from '../src/claude-account-profiles.js';
import { ProviderConnectionRuntime } from '../src/provider-connections.js';
import { WorkHubService, WorkHubSourceStore } from '../src/work-hub.js';

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Work Hub preserves timezone-aware calendar instants and renders them correctly in the target local zone', async () => {
  const sources = new WorkHubSourceStore(temp('axis-work-hub-timezone-'));
  const connection = {
    id: 'claude-account-timezone', providerFamily: 'anthropic', label: 'Calendar Account', auth: 'claude-account',
    billing: 'subscription', available: true, supportsMcpSources: true, accountProfileId: 'timezone'
  };
  const connections = { view: () => connection } as unknown as ProviderConnectionRuntime;
  let prompt = '';
  const claudeRuntime = {
    listMcp: async () => ({
      stdout: 'claude.ai Google Calendar: https://calendar.example.test/mcp - ✔ Connected\n',
      stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false
    }),
    invoke: async (_profileId: string, nextPrompt: string) => {
      prompt = nextPrompt;
      return {
        stdout: JSON.stringify({ events: [
          {
            externalId: 'interview-10', system: 'Google Calendar', title: 'Senior Full Stack Interview with Gustavo',
            start: '2026-09-03T10:00:00-03:00', end: '2026-09-03T10:30:00-03:00', allDay: false
          },
          {
            externalId: 'meeting-1530', system: 'Google Calendar', title: 'Afternoon meeting',
            start: '2026-09-03T15:30:00-03:00', end: '2026-09-03T16:00:00-03:00', allDay: false
          },
          {
            externalId: 'naive-time', system: 'Google Calendar', title: 'Unsafe naive event',
            start: '2026-09-03T10:00:00', end: '2026-09-03T10:30:00', allDay: false
          }
        ] }),
        stderr: '', exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false
      };
    }
  } as unknown as ClaudeAccountRuntime;
  const service = new WorkHubService(sources, { connections, claudeRuntime });
  service.upsertSource({ id: 'timezone-calendar', label: 'Calendar', connectionId: connection.id, kind: 'calendar' });

  const snapshot = await service.refresh('timezone-calendar');
  assert.match(prompt, /without converting time zones/i);
  assert.match(prompt, /explicit Z or ±HH:MM offset/i);
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events[0]?.start, '2026-09-03T13:00:00.000Z');
  assert.equal(snapshot.events[1]?.start, '2026-09-03T18:30:00.000Z');

  const localClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  assert.equal(localClock.format(new Date(snapshot.events[0]!.start)), '10:00');
  assert.equal(localClock.format(new Date(snapshot.events[1]!.start)), '15:30');
  assert.equal(snapshot.events.some((event) => event.externalId === 'naive-time'), false);
});

test('Work Hub invalidates legacy calendar caches that predate the timezone contract', () => {
  const sources = new WorkHubSourceStore(temp('axis-work-hub-timezone-cache-'));
  const source = sources.upsert({ id: 'legacy-calendar', label: 'Legacy Calendar', connectionId: 'legacy-account', kind: 'calendar' });
  const file = sources.cacheFile(source.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sourceId: source.id,
    syncedAt: '2026-09-03T18:00:00.000Z',
    items: [{
      kind: 'calendar', sourceId: source.id, connectionId: source.connectionId, providerFamily: 'anthropic',
      system: 'Google Calendar', externalId: 'wrong-time', collectedAt: '2026-09-03T18:00:00.000Z',
      title: 'Wrong cached time', start: '2026-09-03T11:00:00Z', end: '2026-09-03T11:30:00Z', allDay: false
    }]
  }));
  sources.writeStates([{ sourceId: source.id, status: 'ready', lastSyncedAt: '2026-09-03T18:00:00.000Z', itemCount: 1 }]);

  const restored = new WorkHubService(sources);
  const snapshot = restored.snapshot();
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.sourceStates[0]?.status, 'idle');
  assert.equal(snapshot.sourceStates[0]?.lastSyncedAt, undefined);
  assert.equal(snapshot.sourceStates[0]?.itemCount, 0);
});
