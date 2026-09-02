import type { RuntimeEvent, RuntimeRequest } from './runtime-client.js';

export type DesktopCommand = 'new-chat' | 'toggle-sidebar' | 'settings' | 'projects' | 'runs';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface AccountProfileView {
  id: string;
  name: string;
  configDir: string;
  organizationLabel?: string;
}
export type ClaudeAccountProfileView = AccountProfileView;
export type CodexAccountProfileView = AccountProfileView;

export interface RuntimeDiscoveryView {
  installed: boolean;
  usable: boolean;
  version?: string;
  error?: string;
}
export type ClaudeRuntimeDiscoveryView = RuntimeDiscoveryView;
export type CodexRuntimeDiscoveryView = RuntimeDiscoveryView;

export interface ClaudeAccountStatusView extends ClaudeRuntimeDiscoveryView {
  profileId: string;
  authenticated: boolean;
  email?: string;
  authMethod?: string;
  organization?: string;
  subscriptionType?: string;
}

export interface CodexAccountStatusView extends CodexRuntimeDiscoveryView {
  profileId: string;
  authenticated: boolean;
  authMethod?: 'chatgpt' | 'api-key' | 'agent-identity' | 'unknown';
  detail?: string;
}

export interface ProviderConnectionView {
  id: string;
  providerFamily: 'ollama' | 'anthropic' | 'openai';
  label: string;
  auth: 'local' | 'api-key' | 'claude-account' | 'chatgpt-account';
  billing: 'local' | 'api' | 'subscription';
  organizationId?: string;
  organizationLabel?: string;
  credentialId?: string;
  accountProfileId?: string;
  available: boolean;
  reason?: string;
  supportsMcpSources: boolean;
}

export type WorkHubSourceKind = 'calendar' | 'tickets' | 'messages';
export type WorkHubRetention = 'memory' | 'local';

export interface WorkHubSourceView {
  id: string;
  label: string;
  connectionId: string;
  kind: WorkHubSourceKind;
  system: string;
  toolAllowlist: string[];
  retention: WorkHubRetention;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WorkHubItemBaseView {
  sourceId: string;
  connectionId: string;
  providerFamily: 'anthropic' | 'openai';
  system: string;
  externalId: string;
  url?: string;
  collectedAt: string;
}

export interface WorkHubCalendarEventView extends WorkHubItemBaseView {
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

export interface WorkHubTicketView extends WorkHubItemBaseView {
  kind: 'ticket';
  key: string;
  title: string;
  status: string;
  normalizedStatus: 'backlog' | 'todo' | 'in-progress' | 'blocked' | 'review' | 'qa' | 'done' | 'cancelled' | 'unknown';
  priority?: string;
  assignee?: string;
  dueAt?: string;
  updatedAt?: string;
  project?: string;
}

export interface WorkHubMessageView extends WorkHubItemBaseView {
  kind: 'message';
  title: string;
  preview?: string;
  sender?: string;
  timestamp: string;
  channel?: string;
  unread?: boolean;
  requiresAttention?: boolean;
}

export interface WorkHubSourceStateView {
  sourceId: string;
  status: 'idle' | 'syncing' | 'ready' | 'error';
  lastSyncedAt?: string;
  itemCount: number;
  error?: string;
}

export interface WorkHubSnapshotView {
  generatedAt: string;
  sources: WorkHubSourceView[];
  sourceStates: WorkHubSourceStateView[];
  events: WorkHubCalendarEventView[];
  tickets: WorkHubTicketView[];
  messages: WorkHubMessageView[];
}

export interface LocalCoderBridge {
  isElectron: true;
  platform: string;
  request<T>(request: RuntimeRequest): Promise<T>;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  copyText(text: string): Promise<boolean>;
  setTheme(theme: ThemeMode): Promise<boolean>;
  getProfile(): Promise<{ userName: string; home: string }>;
  getLoginItemSettings(): Promise<{ openAtLogin: boolean }>;
  setOpenAtLogin(enabled: boolean): Promise<{ openAtLogin: boolean }>;

  claudeDiscover(): Promise<ClaudeRuntimeDiscoveryView>;
  claudeAccounts(): Promise<ClaudeAccountProfileView[]>;
  createClaudeAccount(input: { id: string; name: string; organizationLabel?: string }): Promise<ClaudeAccountProfileView>;
  claudeAccountStatus(profileId: string): Promise<ClaudeAccountStatusView>;
  loginClaudeAccount(profileId: string, sso?: boolean): Promise<ClaudeAccountStatusView>;
  listClaudeAccountMcps(profileId: string): Promise<{ output: string; durationMs: number }>;

  codexDiscover(): Promise<CodexRuntimeDiscoveryView>;
  codexAccounts(): Promise<CodexAccountProfileView[]>;
  createCodexAccount(input: { id: string; name: string; organizationLabel?: string }): Promise<CodexAccountProfileView>;
  codexAccountStatus(profileId: string): Promise<CodexAccountStatusView>;
  loginCodexAccount(profileId: string, deviceAuth?: boolean): Promise<CodexAccountStatusView>;
  listCodexAccountMcps(profileId: string): Promise<{ output: string; durationMs: number }>;

  providerConnections(): Promise<ProviderConnectionView[]>;
  workHubSnapshot(): Promise<WorkHubSnapshotView>;
  upsertWorkHubSource(input: {
    id: string;
    label: string;
    connectionId: string;
    kind: WorkHubSourceKind;
    system: string;
    toolAllowlist: string[];
    retention?: WorkHubRetention;
    enabled?: boolean;
  }): Promise<WorkHubSourceView>;
  removeWorkHubSource(sourceId: string): Promise<boolean>;
  refreshWorkHub(sourceId?: string): Promise<WorkHubSnapshotView>;

  onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
  onThemeChanged(listener: (dark: boolean) => void): () => void;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
}

declare global {
  interface Window {
    localCoder?: LocalCoderBridge;
    /** Temporary renderer migration alias; not a separate runtime surface. */
    lc?: LocalCoderBridge;
  }
}

export function desktopBridge(): LocalCoderBridge | undefined {
  return window.localCoder ?? window.lc;
}

export function displayProfileName(value: string): string {
  const clean = value.trim();
  if (!clean) return 'Local profile';
  const capitalize = (part: string) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`;
  return /[._-]/.test(clean)
    ? clean.split(/[._-]+/).filter(Boolean).map(capitalize).join(' ')
    : capitalize(clean);
}
