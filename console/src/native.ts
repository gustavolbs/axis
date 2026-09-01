export type DesktopCommand = 'new-chat' | 'toggle-sidebar' | 'settings' | 'chats' | 'projects' | 'runs';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface LocalCoderBridge {
  isElectron: true;
  platform: string;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  setTheme(theme: ThemeMode): Promise<boolean>;
  getProfile(): Promise<{ userName: string; home: string }>;
  getLoginItemSettings(): Promise<{ openAtLogin: boolean }>;
  setOpenAtLogin(enabled: boolean): Promise<{ openAtLogin: boolean }>;
  onThemeChanged(listener: (dark: boolean) => void): () => void;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
}

declare global {
  interface Window {
    lc?: LocalCoderBridge;
  }
}

export function desktopBridge(): LocalCoderBridge | undefined {
  return window.lc;
}
