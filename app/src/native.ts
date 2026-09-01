import type { RuntimeEvent, RuntimeRequest } from './runtime-client.js';

export type DesktopCommand = 'new-chat' | 'toggle-sidebar' | 'settings' | 'chats' | 'projects' | 'runs';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface LocalCoderBridge {
  isElectron: true;
  platform: string;
  request<T>(request: RuntimeRequest): Promise<T>;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  setTheme(theme: ThemeMode): Promise<boolean>;
  getProfile(): Promise<{ userName: string; home: string }>;
  getLoginItemSettings(): Promise<{ openAtLogin: boolean }>;
  setOpenAtLogin(enabled: boolean): Promise<{ openAtLogin: boolean }>;
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
