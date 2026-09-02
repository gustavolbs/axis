import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from './claude-account-profiles.js';
import { CodexAccountProfileStore, CodexAccountRuntime } from './codex-account-profiles.js';
import { ProviderConnectionRuntime } from './provider-connections.js';

export type WorkHubSourceKind = 'calendar' | 'tickets' | 'messages';
export type WorkHubRetention = 'memory' | 'local';
export type NormalizedTicketStatus = 'backlog' | 'todo' | 'in-progress' | 'blocked' | 'review' | 'qa' | 'done' | 'cancelled' | 'unknown';

export interface WorkHubSource {
  id: string;
  label: string;
  connectionId: string;
  kind: WorkHubSourceKind;
  system: string;
  /** Legacy advanced metadata. New sources let the selected account discover and use its connected MCPs automatically. */
  toolAllowlist: string[];
  retention: WorkHubRetention;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkHubSourceInput {
  id: string;
  label: string;
  connectionId: string;
  kind: WorkHubSourceKind;
  system?: string;
  toolAllowlist?: string[];
  retention?: WorkHubRetention;
  enabled?: boolean;
}

interface WorkHubSourceFile {
  version: 1;
  sources: WorkHubSource[];
  updatedAt: string;
}

interface NormalizedBase {
  sourceId: string;
  connectionId: string;
  providerFamily: 'anthropic' | 'openai';
  system: string;
  externalId: string;
  url?: string;
  collectedAt: string;
}

export interface NormalizedCalendarEvent extends NormalizedBase {
  kind: 'calendar';
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar?: string;
  location?: string;
  meetingUrl?: string;
  organizer?: string;
  status?: string;
}

export interface NormalizedTicket extends NormalizedBase {
  kind: 'ticket';
  key: string;
  title: string;
  status: string;
  normalizedStatus: NormalizedTicketStatus;
  priority?: string;
  assignee?: string;
  dueAt?: string;
  updatedAt?: string;
  project?: string;
}

export interface NormalizedMessage extends NormalizedBase {
  kind: 'message';
  title: string;
  preview?: string;
  sender?: string;
  timestamp: string;
  channel?: string;
  unread?: boolean;
  requiresAttention?: boolean;
}

export type WorkHubItem = NormalizedCalendarEvent | NormalizedTicket | NormalizedMessage;

export interface WorkHubSourceState {
  sourceId: string;
  status: 'idle' | 'syncing' | 'ready' | 'error';
  lastSyncedAt?: string;
  itemCount: number;
  error?: string;
}

export interface WorkHubSnapshot {
  generatedAt: string;
  sources: WorkHubSource[];
  sourceStates: WorkHubSourceState[];
  events: NormalizedCalendarEvent[];
  tickets: NormalizedTicket[];
  messages: NormalizedMessage[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_QUERY_DAYS_PAST = 7;
const SOURCE_QUERY_DAYS_FUTURE = 30;

function workHubRoot(): string {
  return process.env.LOCAL_CODER_WORK_HUB_DIR?.trim() || path.join(os.homedir(), '.local-coder-mcp', 'work-hub');
}

function safeId(value: string, label: string): string {
  const clean = value.trim();
  if (!SAFE_ID.test(clean)) throw new Error(`${label} contains unsupported characters.`);
  return clean;
}

function boundedText(value: string, label: string, max = 240): string {
  const clean = value.trim();
  if (!clean || clean.length > max || /[\0\r\n]/.test(clean)) throw new Error(`${label} must be 1-${max} characters without line breaks.`);
  return clean;
}

function sourceKind(value: string): WorkHubSourceKind {
  if (value === 'calendar' || value === 'tickets' || value === 'messages') return value;
  throw new Error('Work Hub source kind must be calendar, tickets, or messages.');
}

function retention(value: string | undefined): WorkHubRetention {
  if (value === undefined || value === 'memory') return 'memory';
  if (value === 'local') return 'local';
  throw new Error('Work Hub retention must be memory or local.');
}

function tools(values: string[] | undefined): string[] {
  const clean = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  if (clean.length > 64 || clean.some((value) => value.length > 300 || /[\0\r\n]/.test(value))) {
    throw new Error('Work Hub MCP tool metadata is invalid.');
  }
  return clean;
}

export class WorkHubSourceStore {
  private readonly root: string;
  private readonly file: string;
  constructor(root = workHubRoot()) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'sources.json');
  }

  list(): WorkHubSource[] {
    return this.read().sources.map((source) => structuredClone(source));
  }

  get(id: string): WorkHubSource | undefined {
    const safe = safeId(id, 'Work Hub source id');
    const source = this.read().sources.find((item) => item.id === safe);
    return source ? structuredClone(source) : undefined;
  }

  upsert(input: CreateWorkHubSourceInput): WorkHubSource {
    const state = this.read();
    const id = safeId(input.id, 'Work Hub source id');
    const current = state.sources.find((source) => source.id === id);
    const now = new Date().toISOString();
    const source: WorkHubSource = {
      id,
      label: boundedText(input.label, 'Work Hub source label'),
      connectionId: boundedText(input.connectionId, 'Connection id'),
      kind: sourceKind(input.kind),
      system: boundedText(input.system ?? 'Connected services', 'Source system'),
      toolAllowlist: tools(input.toolAllowlist),
      retention: retention(input.retention),
      enabled: input.enabled !== false,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    state.sources = [source, ...state.sources.filter((item) => item.id !== id)];
    state.updatedAt = now;
    this.write(state);
    return structuredClone(source);
  }

  remove(id: string): boolean {
    const safe = safeId(id, 'Work Hub source id');
    const state = this.read();
    const next = state.sources.filter((source) => source.id !== safe);
    if (next.length === state.sources.length) return false;
    state.sources = next;
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return true;
  }

  cacheFile(sourceId: string): string {
    return path.join(this.root, 'cache', `${safeId(sourceId, 'Work Hub source id')}.json`);
  }

  private read(): WorkHubSourceFile {
    if (!fs.existsSync(this.file)) return { version: 1, sources: [], updatedAt: new Date(0).toISOString() };
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Work Hub source file must be an object.');
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.sources)) throw new Error('Unsupported Work Hub source file version.');
    const sources = value.sources.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Work Hub source.');
      const source = raw as Partial<WorkHubSource>;
      return this.normalizeExisting(source);
    });
    return { version: 1, sources, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString() };
  }

  private normalizeExisting(source: Partial<WorkHubSource>): WorkHubSource {
    if (!source.id || !source.label || !source.connectionId || !source.kind || !source.system) {
      throw new Error('Work Hub source metadata is incomplete.');
    }
    return {
      id: safeId(source.id, 'Work Hub source id'),
      label: boundedText(source.label, 'Work Hub source label'),
      connectionId: boundedText(source.connectionId, 'Connection id'),
      kind: sourceKind(source.kind),
      system: boundedText(source.system, 'Source system'),
      toolAllowlist: tools(Array.isArray(source.toolAllowlist) ? source.toolAllowlist : undefined),
      retention: retention(source.retention),
      enabled: source.enabled !== false,
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date(0).toISOString(),
      updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: WorkHubSourceFile): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}

function normalizeStatus(status: string): NormalizedTicketStatus {
  const value = status.trim().toLowerCase();
  if (/cancel|won't|wont|closed.*invalid/.test(value)) return 'cancelled';
  if (/done|closed|complete|resolved|verified|released/.test(value)) return 'done';
  if (/blocked|impediment|waiting/.test(value)) return 'blocked';
  if (/review|code review|pull request|approval/.test(value)) return 'review';
  if (/qa|test|verification/.test(value)) return 'qa';
  if (/progress|develop|coding|implement|doing/.test(value)) return 'in-progress';
  if (/backlog|groom|story writing|triage/.test(value)) return 'backlog';
  if (/new|open|ready|todo|to do|selected/.test(value)) return 'todo';
  return 'unknown';
}

function extractJson(output: string): unknown {
  const clean = output.trim();
  const candidates = [clean];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(clean)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(clean.slice(first, last + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as unknown; } catch { /* next */ }
  }
  throw new Error('Collector did not return valid normalized JSON.');
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function collectorPrompt(source: WorkHubSource): string {
  const common = [
    'You are a Local Coder Work Hub synchronization task running through one exact provider account.',
    'Discover and use the MCP servers/connectors configured for this account that are relevant to the requested data. The user does not provide MCP tool names and Local Coder does not require a manual tool allowlist.',
    'This background refresh only synchronizes remote data, so collect current state without creating, updating, deleting, sending, transitioning, or otherwise changing remote resources. Interactive user requests outside Work Hub may use write actions normally.',
    'Do not use shell/curl/browser fallbacks for remote business data. Return JSON only, with no Markdown fence or prose.'
  ];
  if (source.kind === 'calendar') {
    return [...common,
      `Read calendar events from ${SOURCE_QUERY_DAYS_PAST} days ago through ${SOURCE_QUERY_DAYS_FUTURE} days ahead across all relevant calendar services visible to this account. If more than one connected calendar service is relevant, combine the results.`,
      'Return {"events":[{"externalId":"stable remote id","system":"Google Calendar or Outlook or other actual source","title":"...","start":"ISO-8601","end":"ISO-8601","allDay":false,"calendar":"...","location":"...","meetingUrl":"...","organizer":"...","status":"...","url":"..."}]}.'
    ].join('\n');
  }
  if (source.kind === 'tickets') {
    return [...common,
      'Read work items/tickets assigned to the current account across all relevant connected issue trackers. Include unresolved items and enough recently completed items to make current status understandable. Preserve the remote status exactly.',
      'Return {"tickets":[{"externalId":"stable remote id","system":"Jira or Linear or other actual source","key":"ABC-123","title":"...","status":"...","priority":"...","assignee":"...","dueAt":"ISO-8601","updatedAt":"ISO-8601","project":"...","url":"..."}]}.'
    ].join('\n');
  }
  return [...common,
    'Read recent messages/threads across all relevant connected messaging or mail services visible to the current account. Prefer unread items and items that plausibly require the user’s attention.',
    'Return {"messages":[{"externalId":"stable remote id","system":"Teams or Slack or mail or other actual source","title":"thread/channel subject","preview":"short summary","sender":"...","timestamp":"ISO-8601","channel":"...","unread":true,"requiresAttention":true,"url":"..."}]}.'
  ].join('\n');
}

export class WorkHubService {
  private readonly items = new Map<string, WorkHubItem[]>();
  private readonly states = new Map<string, WorkHubSourceState>();
  private readonly connections: ProviderConnectionRuntime;
  private readonly claudeRuntime: ClaudeAccountRuntime;
  private readonly codexRuntime: CodexAccountRuntime;

  constructor(
    private readonly sources = new WorkHubSourceStore(),
    options: {
      connections?: ProviderConnectionRuntime;
      claudeProfiles?: ClaudeAccountProfileStore;
      claudeRuntime?: ClaudeAccountRuntime;
      codexProfiles?: CodexAccountProfileStore;
      codexRuntime?: CodexAccountRuntime;
    } = {}
  ) {
    this.connections = options.connections ?? new ProviderConnectionRuntime();
    const claudeProfiles = options.claudeProfiles ?? new ClaudeAccountProfileStore();
    this.claudeRuntime = options.claudeRuntime ?? new ClaudeAccountRuntime(claudeProfiles);
    const codexProfiles = options.codexProfiles ?? new CodexAccountProfileStore();
    this.codexRuntime = options.codexRuntime ?? new CodexAccountRuntime(codexProfiles);
    for (const source of this.sources.list()) {
      this.states.set(source.id, { sourceId: source.id, status: 'idle', itemCount: 0 });
      this.restoreCache(source);
    }
  }

  listSources(): WorkHubSource[] { return this.sources.list(); }

  upsertSource(input: CreateWorkHubSourceInput): WorkHubSource {
    const connection = this.connections.view(input.connectionId);
    if (!connection) throw new Error(`Unknown connection: ${input.connectionId}`);
    if (!connection.supportsMcpSources || !connection.accountProfileId) {
      throw new Error(`${connection.label} is model-only. Work Hub sources require an account connection with MCP/connectors.`);
    }
    const source = this.sources.upsert(input);
    this.states.set(source.id, this.states.get(source.id) ?? { sourceId: source.id, status: 'idle', itemCount: 0 });
    return source;
  }

  removeSource(id: string): boolean {
    const source = this.sources.get(id);
    const removed = this.sources.remove(id);
    if (!removed) return false;
    this.items.delete(id);
    this.states.delete(id);
    if (source) {
      try { fs.rmSync(this.sources.cacheFile(source.id), { force: true }); } catch { /* best effort */ }
    }
    return true;
  }

  snapshot(): WorkHubSnapshot {
    const items = [...this.items.values()].flat();
    return {
      generatedAt: new Date().toISOString(),
      sources: this.sources.list(),
      sourceStates: this.sources.list().map((source) => this.states.get(source.id) ?? { sourceId: source.id, status: 'idle', itemCount: 0 }),
      events: items.filter((item): item is NormalizedCalendarEvent => item.kind === 'calendar').sort((a, b) => a.start.localeCompare(b.start)),
      tickets: items.filter((item): item is NormalizedTicket => item.kind === 'ticket').sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
      messages: items.filter((item): item is NormalizedMessage => item.kind === 'message').sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    };
  }

  async refresh(sourceId?: string): Promise<WorkHubSnapshot> {
    const selected = sourceId
      ? [this.sources.get(sourceId)].filter((source): source is WorkHubSource => Boolean(source))
      : this.sources.list().filter((source) => source.enabled);
    if (sourceId && selected.length === 0) throw new Error(`Work Hub source not found: ${sourceId}`);
    // Sequential by design: different enterprise identities stay isolated, and one refresh
    // cannot stampede multiple subscription quotas/connectors at the same time.
    for (const source of selected) await this.refreshSource(source);
    return this.snapshot();
  }

  private async refreshSource(source: WorkHubSource): Promise<void> {
    this.states.set(source.id, { sourceId: source.id, status: 'syncing', itemCount: this.items.get(source.id)?.length ?? 0 });
    try {
      const connection = this.connections.view(source.connectionId);
      if (!connection?.accountProfileId) throw new Error('Work Hub source connection is missing its account profile.');
      let output: string;
      if (connection.auth === 'claude-account') {
        const result = await this.claudeRuntime.invoke(connection.accountProfileId, collectorPrompt(source), {
          timeoutMs: 180_000,
          allowedTools: ['mcp__*']
        });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
          throw new Error(result.stderr || result.stdout || 'Claude Work Hub collector failed.');
        }
        output = result.stdout;
      } else if (connection.auth === 'chatgpt-account') {
        const result = await this.codexRuntime.invoke(connection.accountProfileId, collectorPrompt(source), {
          timeoutMs: 180_000
        });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
          throw new Error(result.stderr || result.stdout || 'ChatGPT Work Hub collector failed.');
        }
        output = result.stdout;
      } else {
        throw new Error(`${connection.label} cannot collect MCP data.`);
      }
      const collectedAt = new Date().toISOString();
      const normalized = this.normalize(source, connection.providerFamily as 'anthropic' | 'openai', extractJson(output), collectedAt);
      this.items.set(source.id, normalized);
      this.states.set(source.id, { sourceId: source.id, status: 'ready', lastSyncedAt: collectedAt, itemCount: normalized.length });
      if (source.retention === 'local') this.persistCache(source, normalized, collectedAt);
      else {
        try { fs.rmSync(this.sources.cacheFile(source.id), { force: true }); } catch { /* best effort */ }
      }
    } catch (error) {
      this.states.set(source.id, {
        sourceId: source.id,
        status: 'error',
        lastSyncedAt: this.states.get(source.id)?.lastSyncedAt,
        itemCount: this.items.get(source.id)?.length ?? 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private normalize(source: WorkHubSource, providerFamily: 'anthropic' | 'openai', payload: unknown, collectedAt: string): WorkHubItem[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Collector payload must be a JSON object.');
    const value = payload as Record<string, unknown>;
    const base = (externalId: string, system?: string): NormalizedBase => ({
      sourceId: source.id,
      connectionId: source.connectionId,
      providerFamily,
      system: system ?? source.system,
      externalId,
      collectedAt
    });
    if (source.kind === 'calendar') {
      return array(value.events).flatMap((item): NormalizedCalendarEvent[] => {
        const externalId = string(item.externalId) ?? string(item.id);
        const title = string(item.title) ?? string(item.summary);
        const start = string(item.start);
        const end = string(item.end);
        if (!externalId || !title || !start || !end) return [];
        return [{
          ...base(externalId, string(item.system)), kind: 'calendar', title, start, end,
          allDay: bool(item.allDay) ?? false,
          calendar: string(item.calendar), location: string(item.location), meetingUrl: string(item.meetingUrl),
          organizer: string(item.organizer), status: string(item.status), url: string(item.url)
        }];
      });
    }
    if (source.kind === 'tickets') {
      return array(value.tickets).flatMap((item): NormalizedTicket[] => {
        const externalId = string(item.externalId) ?? string(item.id) ?? string(item.key);
        const key = string(item.key) ?? externalId;
        const title = string(item.title) ?? string(item.summary);
        const status = string(item.status);
        if (!externalId || !key || !title || !status) return [];
        return [{
          ...base(externalId, string(item.system)), kind: 'ticket', key, title, status, normalizedStatus: normalizeStatus(status),
          priority: string(item.priority), assignee: string(item.assignee), dueAt: string(item.dueAt),
          updatedAt: string(item.updatedAt), project: string(item.project), url: string(item.url)
        }];
      });
    }
    return array(value.messages).flatMap((item): NormalizedMessage[] => {
      const externalId = string(item.externalId) ?? string(item.id);
      const title = string(item.title) ?? string(item.subject) ?? string(item.channel);
      const timestamp = string(item.timestamp);
      if (!externalId || !title || !timestamp) return [];
      return [{
        ...base(externalId, string(item.system)), kind: 'message', title, timestamp, preview: string(item.preview), sender: string(item.sender),
        channel: string(item.channel), unread: bool(item.unread), requiresAttention: bool(item.requiresAttention), url: string(item.url)
      }];
    });
  }

  private persistCache(source: WorkHubSource, items: WorkHubItem[], syncedAt: string): void {
    const file = this.sources.cacheFile(source.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, sourceId: source.id, syncedAt, items }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private restoreCache(source: WorkHubSource): void {
    if (source.retention !== 'local') return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sources.cacheFile(source.id), 'utf8')) as { syncedAt?: string; items?: WorkHubItem[] };
      if (!Array.isArray(parsed.items)) return;
      this.items.set(source.id, parsed.items);
      this.states.set(source.id, { sourceId: source.id, status: 'ready', lastSyncedAt: parsed.syncedAt, itemCount: parsed.items.length });
    } catch { /* no cache is normal */ }
  }
}
