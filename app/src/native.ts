import type { RuntimeEvent, RuntimeRequest } from './runtime-client.js';

export type DesktopCommand = 'new-chat' | 'toggle-sidebar' | 'settings' | 'projects' | 'runs';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface ClaudeAccountProfileView {
  id: string;
  name: string;
  configDir: string;
  organizationLabel?: string;
}

export interface ClaudeRuntimeDiscoveryView {
  installed: boolean;
  usable: boolean;
  version?: string;
  error?: string;
}

export interface ClaudeAccountStatusView extends ClaudeRuntimeDiscoveryView {
  profileId: string;
  authenticated: boolean;
  email?: string;
  authMethod?: string;
  organization?: string;
  subscriptionType?: string;
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

/**
 * Turns an OS account name into something addressable: `gustavo.bispo` reads as
 * "Gustavo Bispo", `gustavobispo` as "Gustavobispo". Used by both the sidebar
 * account row and the greeting, which must agree.
 */
export function displayProfileName(value: string): string {
  const clean = value.trim();
  if (!clean) return 'Local profile';
  const capitalize = (part: string) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`;
  return /[._-]/.test(clean)
    ? clean.split(/[._-]+/).filter(Boolean).map(capitalize).join(' ')
    : capitalize(clean);
}
