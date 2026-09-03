'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const themeListeners = new Map();
const commandListeners = new Map();
const runtimeListeners = new Map();

const bridge = {
  isElectron: true,
  platform: process.platform,
  request: (request) => ipcRenderer.invoke('local-coder:runtime-request', request),
  pickDirectory: (defaultPath) => ipcRenderer.invoke('local-coder:pick-directory', defaultPath),
  copyText: (text) => ipcRenderer.invoke('local-coder:copy-text', String(text)),
  setTheme: (theme) => ipcRenderer.invoke('local-coder:set-theme', theme),
  getProfile: () => ipcRenderer.invoke('local-coder:get-profile'),
  getLoginItemSettings: () => ipcRenderer.invoke('local-coder:get-login-item-settings'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('local-coder:set-open-at-login', Boolean(enabled)),

  claudeDiscover: () => ipcRenderer.invoke('local-coder:claude-discover'),
  claudeAccounts: () => ipcRenderer.invoke('local-coder:claude-accounts'),
  createClaudeAccount: (input) => ipcRenderer.invoke('local-coder:claude-account-create', input),
  claudeAccountStatus: (profileId) => ipcRenderer.invoke('local-coder:claude-account-status', String(profileId)),
  loginClaudeAccount: (profileId, sso = false) => ipcRenderer.invoke('local-coder:claude-account-login', String(profileId), Boolean(sso)),
  listClaudeAccountMcps: (profileId, refresh = false) => ipcRenderer.invoke('local-coder:claude-account-mcps', String(profileId), Boolean(refresh)),
  addClaudeAccountMcp: (input) => ipcRenderer.invoke('local-coder:claude-account-mcp-add', input),
  removeClaudeAccountMcp: (profileId, name) => ipcRenderer.invoke('local-coder:claude-account-mcp-remove', String(profileId), String(name)),
  loginClaudeAccountMcp: (profileId, name) => ipcRenderer.invoke('local-coder:claude-account-mcp-login', String(profileId), String(name)),

  codexDiscover: () => ipcRenderer.invoke('local-coder:codex-discover'),
  codexAccounts: () => ipcRenderer.invoke('local-coder:codex-accounts'),
  createCodexAccount: (input) => ipcRenderer.invoke('local-coder:codex-account-create', input),
  codexAccountStatus: (profileId) => ipcRenderer.invoke('local-coder:codex-account-status', String(profileId)),
  loginCodexAccount: (profileId, deviceAuth = false) => ipcRenderer.invoke('local-coder:codex-account-login', String(profileId), Boolean(deviceAuth)),
  listCodexAccountMcps: (profileId, refresh = false) => ipcRenderer.invoke('local-coder:codex-account-mcps', String(profileId), Boolean(refresh)),
  addCodexAccountMcp: (input) => ipcRenderer.invoke('local-coder:codex-account-mcp-add', input),
  removeCodexAccountMcp: (profileId, name) => ipcRenderer.invoke('local-coder:codex-account-mcp-remove', String(profileId), String(name)),
  loginCodexAccountMcp: (profileId, name) => ipcRenderer.invoke('local-coder:codex-account-mcp-login', String(profileId), String(name)),

  providerConnections: () => ipcRenderer.invoke('local-coder:connections'),
  createApiKeyConnection: (input) => ipcRenderer.invoke('local-coder:api-connection-create', input),
  workHubSnapshot: () => ipcRenderer.invoke('local-coder:work-hub-snapshot'),
  upsertWorkHubSource: (input) => ipcRenderer.invoke('local-coder:work-hub-source-upsert', input),
  removeWorkHubSource: (sourceId) => ipcRenderer.invoke('local-coder:work-hub-source-remove', String(sourceId)),
  markWorkHubMessageRead: (sourceId, externalId) => ipcRenderer.invoke('local-coder:work-hub-message-read', String(sourceId), String(externalId)),
  dismissWorkHubMessage: (sourceId, externalId) => ipcRenderer.invoke('local-coder:work-hub-message-dismiss', String(sourceId), String(externalId)),
  // A source-less refresh used to let the renderer auto-sync every configured
  // provider as soon as Work Hub mounted. In a desktop app those provider CLIs
  // are responsible child processes, so their macOS privacy prompts are
  // attributed to Axis. Keep startup/read-all behavior passive: only an
  // explicit source-specific Sync is allowed to launch a provider CLI.
  refreshWorkHub: (sourceId) => sourceId === undefined
    ? ipcRenderer.invoke('local-coder:work-hub-snapshot')
    : ipcRenderer.invoke('local-coder:work-hub-refresh', String(sourceId)),

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
};

contextBridge.exposeInMainWorld('localCoder', bridge);
contextBridge.exposeInMainWorld('lc', bridge);
