import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeAccountProfileStore, ClaudeAccountRuntime } from './claude-account-profiles.js';
import { CodexAccountProfileStore, CodexAccountRuntime } from './codex-account-profiles.js';
import { parseClaudeMcpList, parseCodexMcpList, type McpConnector } from './mcp-connectors.js';
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
  ticketKey?: string;
  commentId?: string;
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
  stage?: 'discovering' | 'collecting' | 'normalizing';
  syncStartedAt?: string;
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  durationMs?: number;
  itemCount: number;
  systems?: string[];
  error?: string;
}

export interface WorkHubMessageState {
  sourceId: string;
  externalId: string;
  read: boolean;
  dismissed: boolean;
  updatedAt: string;
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
const SOURCE_QUERY_DAYS_PAST = 3;
const SOURCE_QUERY_DAYS_FUTURE = 14;
const CONNECTOR_CACHE_MS = 5 * 60_000;

const CONNECTOR_HINTS: Record<WorkHubSourceKind, RegExp> = {
  calendar: /calendar|outlook|microsoft\s*365|agenda/i,
  tickets: /jira|linear|asana|trello|clickup|github|gitlab|atlassian|azure\s*devops/i,
  // The Messages source is intentionally a focused cross-system alert feed:
  // Jira comments on the user's assigned tickets and Slack messages. It must
  // not broaden into every connector available on the account.
  messages: /jira|slack/i
};
const DEDICATED_TRACKER_HINT = /jira|linear|asana|trello|clickup|atlassian|azure\s*devops/i;

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

function sourceKindLabel(kind: WorkHubSourceKind): string {
  if (kind === 'calendar') return 'calendar';
  if (kind === 'tickets') return 'work tracker';
  return 'Jira comments or Slack messages';
}

function retention(value: string | undefined): WorkHubRetention {
  // Work Hub is stale-while-revalidate: previously normalized results must be
  // available immediately after reopening the desktop. `memory` is accepted as
  // a legacy value and migrated to the local normalized cache behavior.
  if (value === undefined || value === 'memory' || value === 'local') return 'local';
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
  private readonly stateFile: string;
  private readonly messageStateFile: string;
  constructor(root = workHubRoot()) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'sources.json');
    this.stateFile = path.join(this.root, 'sync-state.json');
    this.messageStateFile = path.join(this.root, 'message-state.json');
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

  readStates(): WorkHubSourceState[] {
    if (!fs.existsSync(this.stateFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { version?: unknown; states?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.states)) return [];
      return parsed.states.flatMap((raw): WorkHubSourceState[] => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const value = raw as Partial<WorkHubSourceState>;
        if (!value.sourceId || !['idle', 'syncing', 'ready', 'error'].includes(value.status ?? '')) return [];
        return [{
          sourceId: safeId(value.sourceId, 'Work Hub source id'),
          status: value.status!,
          stage: value.stage === 'discovering' || value.stage === 'collecting' || value.stage === 'normalizing' ? value.stage : undefined,
          syncStartedAt: string(value.syncStartedAt),
          lastAttemptAt: string(value.lastAttemptAt),
          lastSyncedAt: string(value.lastSyncedAt),
          durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? Math.max(0, value.durationMs) : undefined,
          itemCount: typeof value.itemCount === 'number' && Number.isFinite(value.itemCount) ? Math.max(0, Math.floor(value.itemCount)) : 0,
          systems: Array.isArray(value.systems) ? value.systems.flatMap((entry) => string(entry) ?? []).slice(0, 16) : undefined,
          error: string(value.error)?.slice(0, 2_000)
        }];
      });
    } catch {
      return [];
    }
  }

  writeStates(states: WorkHubSourceState[]): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, states, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.stateFile);
      try { fs.chmodSync(this.stateFile, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  readMessageStates(): WorkHubMessageState[] {
    if (!fs.existsSync(this.messageStateFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.messageStateFile, 'utf8')) as { version?: unknown; states?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.states)) return [];
      return parsed.states.flatMap((raw): WorkHubMessageState[] => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const value = raw as Partial<WorkHubMessageState>;
        if (typeof value.sourceId !== 'string' || typeof value.externalId !== 'string' || typeof value.updatedAt !== 'string') return [];
        const externalId = value.externalId.trim();
        if (!externalId || externalId.length > 512 || /[\0\r\n]/.test(externalId)) return [];
        return [{
          sourceId: safeId(value.sourceId, 'Work Hub source id'),
          externalId,
          read: value.read === true,
          dismissed: value.dismissed === true,
          updatedAt: value.updatedAt
        }];
      });
    } catch {
      return [];
    }
  }

  writeMessageStates(states: WorkHubMessageState[]): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = `${this.messageStateFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, states, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.messageStateFile);
      try { fs.chmodSync(this.messageStateFile, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
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

function collectorFailure(
  label: string,
  result: { stderr: string; exitCode: number | null; timedOut: boolean; cancelled: boolean }
): Error {
  if (result.timedOut) return new Error(`${label} timed out after 3 minutes. Check the connector status in Settings → Connections, then try again.`);
  if (result.cancelled) return new Error(`${label} was cancelled before it finished.`);
  const detail = result.stderr.trim().replace(/\s+/g, ' ').slice(0, 600);
  return new Error(detail ? `${label} failed: ${detail}` : `${label} failed with exit code ${String(result.exitCode)}.`);
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function messageExternalId(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 512 || /[\0\r\n]/.test(clean)) throw new Error('Work Hub message id is invalid.');
  return clean;
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function jiraConnectorOrigin(connectors: McpConnector[]): string | undefined {
  for (const connector of connectors) {
    if (!/jira/i.test(connector.name) || !connector.target) continue;
    try {
      const target = new URL(connector.target);
      if (target.protocol === 'https:' && !target.username && !target.password) return target.origin;
    } catch { /* ignore malformed connector metadata */ }
  }
  return undefined;
}

function jiraIssueKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key && /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : undefined;
}

function jiraCommentId(value: string | undefined): string | undefined {
  const id = value?.trim();
  return id && /^\d+$/.test(id) ? id : undefined;
}

function jiraBrowserUrl(
  connectors: McpConnector[],
  keyValue: string | undefined,
  commentIdValue?: string
): string | undefined {
  const origin = jiraConnectorOrigin(connectors);
  const key = jiraIssueKey(keyValue);
  if (!origin || !key) return undefined;
  const issueUrl = `${origin}/browse/${encodeURIComponent(key)}`;
  const commentId = jiraCommentId(commentIdValue);
  return commentId ? `${issueUrl}?focusedCommentId=${encodeURIComponent(commentId)}` : issueUrl;
}

function collectorPrompt(source: WorkHubSource, systems: string[] = []): string {
  const date = (offsetDays: number) => {
    const value = new Date();
    value.setDate(value.getDate() + offsetDays);
    return value.toISOString().slice(0, 10);
  };
  if (source.kind === 'calendar' && systems.some((system) => /microsoft\s*365/i.test(system))) {
    return [
      `Usando o MCP do Teams, diga quais são minhas reuniões entre ${date(-SOURCE_QUERY_DAYS_PAST)} e ${date(SOURCE_QUERY_DAYS_FUTURE)}. Não altere nada.`,
      'Responda apenas JSON, sem Markdown ou explicações, no formato {"events":[{"externalId":"id estável","system":"Outlook","title":"...","start":"ISO-8601","end":"ISO-8601","allDay":false,"calendar":"...","location":"...","meetingUrl":"...","organizer":"...","status":"...","url":"..."}]}.'
    ].join('\n');
  }
  if (source.kind === 'tickets' && systems.some((system) => /jira/i.test(system))) {
    return [
      'Usando o MCP do Jira, diga quais tasks estão assignadas pra mim e o status de cada uma. Não altere nada e não busque histórico de tasks concluídas.',
      'Para cada task, peça explicitamente ao MCP a URL canônica de navegador ou permalink. Se a listagem não trouxer esse campo, consulte os detalhes da task pelo MCP antes de finalizar. Copie em "url" somente a URL exata que o MCP retornar.',
      'Nunca monte, complete, reescreva ou adivinhe uma URL usando a key, o nome da conta ou um domínio conhecido. Se o MCP não retornar uma URL direta, omita "url"; o aplicativo usará apenas a origem HTTPS configurada para esse mesmo MCP como fallback.',
      'Responda apenas JSON, sem Markdown ou explicações, no formato {"tickets":[{"externalId":"id estável","system":"Jira","key":"ABC-123","title":"...","status":"...","url":"URL exata retornada pelo MCP"}]}.'
    ].join('\n');
  }
  const common = [
    'You are a Local Coder Work Hub synchronization task running through one exact provider account.',
    'Discover and use the MCP servers/connectors configured for this account that are relevant to the requested data. The user does not provide MCP tool names and Local Coder does not require a manual tool allowlist.',
    'This background refresh only synchronizes remote data, so collect current state without creating, updating, deleting, sending, transitioning, or otherwise changing remote resources. Interactive user requests outside Work Hub may use write actions normally.',
    'For every remote item, explicitly ask its MCP for a canonical browser URL or permalink. If a list response omits it, use a relevant MCP detail/link lookup before finalizing. Copy every returned url field verbatim.',
    'Never derive, assemble, transform, repair, or guess a URL from an item key, id, account name, tenant, or familiar hostname. If the MCP response has no direct URL, omit the url field; the application may use only the HTTPS origin configured for that same MCP as a constrained fallback.',
    'Do not use shell/curl/browser fallbacks for remote business data. Return JSON only, with no Markdown fence or prose.'
  ];
  if (source.kind === 'calendar') {
    return [...common,
      `Read calendar events from ${date(-SOURCE_QUERY_DAYS_PAST)} through ${date(SOURCE_QUERY_DAYS_FUTURE)} inclusive across the relevant calendar services visible to this account. Do not read outside that date range. If more than one connected calendar service is relevant, combine the results.`,
      'Return {"events":[{"externalId":"stable remote id","system":"Google Calendar or Outlook or other actual source","title":"...","start":"ISO-8601","end":"ISO-8601","allDay":false,"calendar":"...","location":"...","meetingUrl":"...","organizer":"...","status":"...","url":"..."}]}.'
    ].join('\n');
  }
  if (source.kind === 'tickets') {
    return [...common,
      'Read only the current work items/tickets assigned to this account and their current status. Preserve the remote status exactly and do not crawl source-code repositories or request completed-item history.',
      'Return {"tickets":[{"externalId":"stable remote id","system":"Jira or Linear or other actual source","key":"ABC-123","title":"...","status":"...","priority":"...","assignee":"...","dueAt":"ISO-8601","updatedAt":"ISO-8601","project":"...","url":"..."}]}.'
    ].join('\n');
  }
  return [...common,
    'This Messages source is deliberately limited to two places: (1) recent comments on the current account\'s assigned Jira tickets, and (2) recent Slack messages or threads that plausibly require the user\'s attention. Do not access GitHub, email, Teams, calendars, or any other connector, and do not read unrelated Jira tickets or broad Jira history.',
    'For Jira comments, ask the Jira MCP for the exact comment permalink; otherwise ask for the exact ticket browser URL. Do not append focusedCommentId or substitute an Atlassian Cloud hostname yourself. Include ticketKey and commentId as separate values returned by Jira so the application can use the configured Jira MCP origin if that server omits browser links.',
    'Return {"messages":[{"externalId":"stable remote id","system":"Jira or Slack","ticketKey":"ABC-123 for Jira","commentId":"numeric Jira comment id","title":"ticket key and comment or Slack thread/channel subject","preview":"short comment or message summary","sender":"...","timestamp":"ISO-8601","channel":"...","unread":true,"requiresAttention":true,"url":"exact URL returned by the MCP"}]}.'
  ].join('\n');
}

function claudeServerId(connector: McpConnector): string {
  const safeName = connector.name.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${connector.managed ? 'claude_ai_' : ''}${safeName}`;
}

function relevantConnectors(kind: WorkHubSourceKind, connectors: McpConnector[]): McpConnector[] {
  const relevant = connectors.filter((connector) => connector.status === 'connected' && CONNECTOR_HINTS[kind].test(connector.name));
  if (kind !== 'tickets') return relevant;
  // Prefer the dedicated issue tracker when an account also has a broad source
  // code connector. This keeps a Jira board refresh bounded instead of asking a
  // single collector to crawl both Jira and every accessible GitHub repository.
  const dedicated = relevant.filter((connector) => DEDICATED_TRACKER_HINT.test(connector.name));
  return dedicated.length > 0 ? dedicated : relevant;
}

export class WorkHubService {
  private readonly items = new Map<string, WorkHubItem[]>();
  private readonly messageStates = new Map<string, WorkHubMessageState>();
  private readonly states = new Map<string, WorkHubSourceState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly accountQueues = new Map<string, Promise<void>>();
  private readonly connectorCache = new Map<string, { expiresAt: number; connectors: McpConnector[] }>();
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
    const restoredStates = new Map(this.sources.readStates().map((state) => [state.sourceId, state]));
    for (const state of this.sources.readMessageStates()) this.messageStates.set(`${state.sourceId}\u0000${state.externalId}`, state);
    for (const source of this.sources.list()) {
      const restored = restoredStates.get(source.id);
      this.states.set(source.id, restored?.status === 'syncing'
        ? { ...restored, status: 'error', stage: undefined, syncStartedAt: undefined, error: 'The previous sync was interrupted when Local Coder closed.' }
        : restored ?? { sourceId: source.id, status: 'idle', itemCount: 0 });
      const cacheRestored = this.restoreCache(source);
      if (!cacheRestored && this.states.get(source.id)?.status === 'ready') {
        this.states.set(source.id, { ...this.states.get(source.id)!, status: 'idle', itemCount: 0 });
      }
    }
    this.persistStates();
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
    for (const key of this.messageStates.keys()) {
      if (key.startsWith(`${id}\u0000`)) this.messageStates.delete(key);
    }
    this.persistMessageStates();
    this.persistStates();
    return true;
  }

  markMessageRead(sourceId: string, externalId: string): WorkHubSnapshot {
    return this.updateMessageState(sourceId, externalId, 'read');
  }

  dismissMessage(sourceId: string, externalId: string): WorkHubSnapshot {
    return this.updateMessageState(sourceId, externalId, 'dismiss');
  }

  snapshot(): WorkHubSnapshot {
    const items = [...this.items.values()].flat();
    return {
      generatedAt: new Date().toISOString(),
      sources: this.sources.list(),
      sourceStates: this.sources.list().map((source) => this.states.get(source.id) ?? { sourceId: source.id, status: 'idle', itemCount: 0 }),
      events: items.filter((item): item is NormalizedCalendarEvent => item.kind === 'calendar').sort((a, b) => a.start.localeCompare(b.start)),
      tickets: items.filter((item): item is NormalizedTicket => item.kind === 'ticket').sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
      messages: items
        .filter((item): item is NormalizedMessage => item.kind === 'message')
        .map((item) => {
          const state = this.messageStates.get(`${item.sourceId}\u0000${item.externalId}`);
          return state?.read ? { ...item, unread: false, requiresAttention: false } : item;
        })
        .filter((item) => this.messageStates.get(`${item.sourceId}\u0000${item.externalId}`)?.dismissed !== true)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    };
  }

  async refresh(sourceId?: string): Promise<WorkHubSnapshot> {
    const selected = sourceId
      ? [this.sources.get(sourceId)].filter((source): source is WorkHubSource => Boolean(source))
      : this.sources.list().filter((source) => source.enabled);
    if (sourceId && selected.length === 0) throw new Error(`Work Hub source not found: ${sourceId}`);
    // Keep one collector at a time inside each account, but let isolated accounts sync
    // together. A second click on an in-flight source joins the existing promise.
    const byConnection = new Map<string, WorkHubSource[]>();
    for (const source of selected) byConnection.set(source.connectionId, [...(byConnection.get(source.connectionId) ?? []), source]);
    await Promise.all([...byConnection.values()].map(async (accountSources) => {
      for (const source of accountSources) await this.refreshSource(source);
    }));
    return this.snapshot();
  }

  private refreshSource(source: WorkHubSource): Promise<void> {
    const current = this.inFlight.get(source.id);
    if (current) return current;
    const previous = this.accountQueues.get(source.connectionId) ?? Promise.resolve();
    const run = previous.then(() => this.runRefreshSource(source));
    const pending = run.finally(() => {
      this.inFlight.delete(source.id);
      if (this.accountQueues.get(source.connectionId) === pending) this.accountQueues.delete(source.connectionId);
    });
    this.inFlight.set(source.id, pending);
    this.accountQueues.set(source.connectionId, pending);
    return pending;
  }

  private async runRefreshSource(source: WorkHubSource): Promise<void> {
    const startedAt = new Date().toISOString();
    this.setState({
      sourceId: source.id,
      status: 'syncing',
      stage: 'discovering',
      syncStartedAt: startedAt,
      lastAttemptAt: startedAt,
      lastSyncedAt: this.states.get(source.id)?.lastSyncedAt,
      itemCount: this.items.get(source.id)?.length ?? 0,
      systems: this.states.get(source.id)?.systems
    });
    try {
      const connection = this.connections.view(source.connectionId);
      if (!connection?.accountProfileId) throw new Error('Work Hub source connection is missing its account profile.');
      let output: string;
      let systems: string[] | undefined;
      let connectorMetadata: McpConnector[] = [];
      if (connection.auth === 'claude-account') {
        const connectors = await this.connectorsFor('claude', connection.accountProfileId);
        const relevant = relevantConnectors(source.kind, connectors);
        if (relevant.length === 0) {
          throw new Error(`No connected ${sourceKindLabel(source.kind)} connector was found for ${connection.label}. Open Settings → Connections to connect one, then try again.`);
        }
        systems = relevant.map((connector) => connector.name);
        connectorMetadata = relevant;
        this.setState({ ...this.states.get(source.id)!, stage: 'collecting', systems });
        const result = await this.claudeRuntime.invoke(connection.accountProfileId, collectorPrompt(source, systems), {
          timeoutMs: 180_000,
          allowedTools: relevant.map((connector) => `mcp__${claudeServerId(connector)}__*`),
          stopOnValidJson: true
        });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
          throw collectorFailure('Claude Work Hub sync', result);
        }
        output = result.stdout;
      } else if (connection.auth === 'chatgpt-account') {
        const connectors = await this.connectorsFor('codex', connection.accountProfileId);
        const relevant = relevantConnectors(source.kind, connectors);
        if (relevant.length === 0) {
          throw new Error(`No connected ${sourceKindLabel(source.kind)} connector was found for ${connection.label}. Open Settings → Connections to connect one, then try again.`);
        }
        systems = relevant.map((connector) => connector.name);
        connectorMetadata = relevant;
        this.setState({ ...this.states.get(source.id)!, stage: 'collecting', systems });
        const result = await this.codexRuntime.invoke(connection.accountProfileId, collectorPrompt(source, systems), {
          timeoutMs: 180_000,
          mcpPolicies: connectors.map((connector) => ({
            serverId: connector.name,
            enabled: relevant.some((candidate) => candidate.name === connector.name)
          })),
          stopOnValidJson: true
        });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
          throw collectorFailure('ChatGPT Work Hub sync', result);
        }
        output = result.stdout;
      } else {
        throw new Error(`${connection.label} cannot collect MCP data.`);
      }
      const collectedAt = new Date().toISOString();
      this.setState({ ...this.states.get(source.id)!, stage: 'normalizing', systems });
      const normalized = this.normalize(
        source,
        connection.providerFamily as 'anthropic' | 'openai',
        extractJson(output),
        collectedAt,
        systems?.[0],
        connectorMetadata
      );
      this.items.set(source.id, normalized);
      this.setState({
        sourceId: source.id,
        status: 'ready',
        lastAttemptAt: startedAt,
        lastSyncedAt: collectedAt,
        durationMs: Date.now() - Date.parse(startedAt),
        itemCount: normalized.length,
        systems
      });
      this.persistCache(source, normalized, collectedAt);
    } catch (error) {
      this.setState({
        sourceId: source.id,
        status: 'error',
        lastAttemptAt: startedAt,
        lastSyncedAt: this.states.get(source.id)?.lastSyncedAt,
        durationMs: Date.now() - Date.parse(startedAt),
        itemCount: this.items.get(source.id)?.length ?? 0,
        systems: this.states.get(source.id)?.systems,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async connectorsFor(provider: 'claude' | 'codex', profileId: string): Promise<McpConnector[]> {
    const key = `${provider}:${profileId}`;
    const cached = this.connectorCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.connectors;
    let result = provider === 'claude'
      ? await this.claudeRuntime.listMcp(profileId, { timeoutMs: 45_000 })
      : await this.codexRuntime.listMcp(profileId, { timeoutMs: 45_000, json: true });
    if (provider === 'codex' && (result.exitCode !== 0 || result.timedOut || result.cancelled)) {
      result = await this.codexRuntime.listMcp(profileId, { timeoutMs: 45_000 });
    }
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
      throw new Error(result.timedOut ? 'Connector discovery timed out.' : result.stderr || result.stdout || 'Could not discover account connectors.');
    }
    const connectors = provider === 'claude' ? parseClaudeMcpList(result.stdout || result.stderr) : parseCodexMcpList(result.stdout || result.stderr);
    this.connectorCache.set(key, { expiresAt: Date.now() + CONNECTOR_CACHE_MS, connectors });
    return connectors;
  }

  private setState(state: WorkHubSourceState): void {
    this.states.set(state.sourceId, state);
    this.persistStates();
  }

  private persistStates(): void {
    try { this.sources.writeStates([...this.states.values()]); } catch { /* status persistence must not break a sync */ }
  }

  private persistMessageStates(): void {
    try { this.sources.writeMessageStates([...this.messageStates.values()]); } catch { /* local inbox state must not break a sync */ }
  }

  private updateMessageState(sourceId: string, externalId: string, action: 'read' | 'dismiss'): WorkHubSnapshot {
    const source = this.sources.get(sourceId);
    if (!source || source.kind !== 'messages') throw new Error(`Work Hub message source not found: ${sourceId}`);
    const cleanExternalId = messageExternalId(externalId);
    const key = `${source.id}\u0000${cleanExternalId}`;
    const current = this.messageStates.get(key);
    this.messageStates.set(key, {
      sourceId: source.id,
      externalId: cleanExternalId,
      read: current?.read === true || action === 'read',
      dismissed: current?.dismissed === true || action === 'dismiss',
      updatedAt: new Date().toISOString()
    });
    this.persistMessageStates();
    return this.snapshot();
  }

  private normalize(
    source: WorkHubSource,
    providerFamily: 'anthropic' | 'openai',
    payload: unknown,
    collectedAt: string,
    discoveredSystem?: string,
    connectors: McpConnector[] = []
  ): WorkHubItem[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Collector payload must be a JSON object.');
    const value = payload as Record<string, unknown>;
    const base = (externalId: string, system?: string): NormalizedBase => ({
      sourceId: source.id,
      connectionId: source.connectionId,
      providerFamily,
      system: system ?? discoveredSystem ?? source.system,
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
        const system = string(item.system);
        return [{
          ...base(externalId, system), kind: 'ticket', key, title, status, normalizedStatus: normalizeStatus(status),
          priority: string(item.priority), assignee: string(item.assignee), dueAt: string(item.dueAt),
          updatedAt: string(item.updatedAt), project: string(item.project),
          url: string(item.url) ?? (/jira/i.test(system ?? discoveredSystem ?? '') ? jiraBrowserUrl(connectors, key) : undefined)
        }];
      });
    }
    return array(value.messages).flatMap((item): NormalizedMessage[] => {
      const externalId = string(item.externalId) ?? string(item.id);
      const title = string(item.title) ?? string(item.subject) ?? string(item.channel);
      const timestamp = string(item.timestamp);
      if (!externalId || !title || !timestamp) return [];
      const system = string(item.system);
      const ticketKey = string(item.ticketKey) ?? (/jira/i.test(system ?? '') ? title.match(/\b[A-Z][A-Z0-9_]*-\d+\b/)?.[0] : undefined);
      const commentId = string(item.commentId) ?? (/jira/i.test(system ?? '') ? externalId.match(/(?:^|[-_:])comment[-_:]?(\d+)$/i)?.[1] : undefined);
      return [{
        ...base(externalId, system), kind: 'message', title, timestamp, ticketKey, commentId,
        preview: string(item.preview), sender: string(item.sender), channel: string(item.channel), unread: bool(item.unread),
        requiresAttention: bool(item.requiresAttention),
        url: string(item.url) ?? (/jira/i.test(system ?? discoveredSystem ?? '') ? jiraBrowserUrl(connectors, ticketKey, commentId) : undefined)
      }];
    });
  }

  private persistCache(source: WorkHubSource, items: WorkHubItem[], syncedAt: string): void {
    const file = this.sources.cacheFile(source.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, sourceId: source.id, syncedAt, items }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, file);
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  private restoreCache(source: WorkHubSource): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sources.cacheFile(source.id), 'utf8')) as { version?: number; sourceId?: string; syncedAt?: string; items?: WorkHubItem[] };
      if (parsed.version !== 1 || parsed.sourceId !== source.id || !Array.isArray(parsed.items)) return false;
      this.items.set(source.id, parsed.items);
      const current = this.states.get(source.id);
      this.states.set(source.id, current?.status === 'error'
        ? { ...current, itemCount: parsed.items.length }
        : { ...current, sourceId: source.id, status: 'ready', lastSyncedAt: parsed.syncedAt ?? current?.lastSyncedAt, itemCount: parsed.items.length });
      return true;
    } catch {
      return false;
    }
  }
}
