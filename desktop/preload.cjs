'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const themeListeners = new Map();
const commandListeners = new Map();
const runtimeListeners = new Map();

contextBridge.exposeInMainWorld('localCoder', {
  isElectron: true,
  platform: process.platform,
  request: (request) => ipcRenderer.invoke('local-coder:runtime-request', request),
  pickDirectory: (defaultPath) => ipcRenderer.invoke('local-coder:pick-directory', defaultPath),
  setTheme: (theme) => ipcRenderer.invoke('local-coder:set-theme', theme),
  getProfile: () => ipcRenderer.invoke('local-coder:get-profile'),
  getLoginItemSettings: () => ipcRenderer.invoke('local-coder:get-login-item-settings'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('local-coder:set-open-at-login', Boolean(enabled)),
  onRuntimeEvent: (listener) => {
    const wrapped = (_event, event) => listener(event);
    runtimeListeners.set(listener, wrapped);
    ipcRenderer.on('local-coder:runtime-event', wrapped);
    return () => {
      const current = runtimeListeners.get(listener);
      if (current) ipcRenderer.removeListener('local-coder:runtime-event', current);
      runtimeListeners.delete(listener);
    };
  },
  onThemeChanged: (listener) => {
    const wrapped = (_event, dark) => listener(Boolean(dark));
    themeListeners.set(listener, wrapped);
    ipcRenderer.on('local-coder:theme-changed', wrapped);
    return () => {
      const current = themeListeners.get(listener);
      if (current) ipcRenderer.removeListener('local-coder:theme-changed', current);
      themeListeners.delete(listener);
    };
  },
  onCommand: (listener) => {
    const wrapped = (_event, command) => listener(String(command));
    commandListeners.set(listener, wrapped);
    ipcRenderer.on('local-coder:command', wrapped);
    return () => {
      const current = commandListeners.get(listener);
      if (current) ipcRenderer.removeListener('local-coder:command', current);
      commandListeners.delete(listener);
    };
  }
});
