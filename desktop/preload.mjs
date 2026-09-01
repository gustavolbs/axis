import { contextBridge, ipcRenderer } from 'electron';

const listeners = new Map();

contextBridge.exposeInMainWorld('lc', {
  isElectron: true,
  platform: process.platform,
  pickDirectory: (defaultPath) => ipcRenderer.invoke('local-coder:pick-directory', defaultPath),
  copyText: (text) => ipcRenderer.invoke('local-coder:copy-text', String(text)),
  setTheme: (theme) => ipcRenderer.invoke('local-coder:set-theme', theme),
  getProfile: () => ipcRenderer.invoke('local-coder:get-profile'),
  getLoginItemSettings: () => ipcRenderer.invoke('local-coder:get-login-item-settings'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('local-coder:set-open-at-login', Boolean(enabled)),
  onThemeChanged: (listener) => {
    const wrapped = (_event, dark) => listener(Boolean(dark));
    listeners.set(listener, wrapped);
    ipcRenderer.on('local-coder:theme-changed', wrapped);
    return () => {
      const current = listeners.get(listener);
      if (current) ipcRenderer.removeListener('local-coder:theme-changed', current);
      listeners.delete(listener);
    };
  },
  onCommand: (listener) => {
    const wrapped = (_event, command) => listener(String(command));
    listeners.set(listener, wrapped);
    ipcRenderer.on('local-coder:command', wrapped);
    return () => {
      const current = listeners.get(listener);
      if (current) ipcRenderer.removeListener('local-coder:command', current);
      listeners.delete(listener);
    };
  }
});
