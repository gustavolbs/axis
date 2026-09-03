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
  claudeDiscover: () => ipcRenderer.invoke('local-coder:claude-discover'),
  claudeAccounts: () => ipcRenderer.invoke('local-coder:claude-accounts'),
  createClaudeAccount: (input) => ipcRenderer.invoke('local-coder:connection-center-claude-create', input),
  claudeAccountStatus: (profileId) => ipcRenderer.invoke('local-coder:claude-account-status', String(profileId)),
  loginClaudeAccount: (profileId, sso = false) => ipcRenderer.invoke('local-coder:claude-account-login', String(profileId), Boolean(sso)),
  listClaudeAccountMcps: (profileId, refresh = false) => ipcRenderer.invoke('local-coder:claude-account-mcps', String(profileId), Boolean(refresh)),
  addClaudeAccountMcp: (input) => ipcRenderer.invoke('local-coder:claude-account-mcp-add', input),
  removeClaudeAccountMcp: (profileId, name) => ipcRenderer.invoke('local-coder:claude-account-mcp-remove', String(profileId), String(name)),
  loginClaudeAccountMcp: (profileId, name) => ipcRenderer.invoke('local-coder:claude-account-mcp-login', String(profileId), String(name)),
  codexDiscover: () => ipcRenderer.invoke('local-coder:codex-discover'),
  codexAccounts: () => ipcRenderer.invoke('local-coder:codex-accounts'),
  createCodexAccount: (input) => ipcRenderer.invoke('local-coder:connection-center-codex-create', input),
  codexAccountStatus: (profileId) => ipcRenderer.invoke('local-coder:codex-account-status', String(profileId)),
  loginCodexAccount: (profileId, deviceAuth = false) => ipcRenderer.invoke('local-coder:codex-account-login', String(profileId), Boolean(deviceAuth)),
  listCodexAccountMcps: (profileId, refresh = false) => ipcRenderer.invoke('local-coder:codex-account-mcps', String(profileId), Boolean(refresh)),
  addCodexAccountMcp: (input) => ipcRenderer.invoke('local-coder:codex-account-mcp-add', input),
  removeCodexAccountMcp: (profileId, name) => ipcRenderer.invoke('local-coder:codex-account-mcp-remove', String(profileId), String(name)),
  loginCodexAccountMcp: (profileId, name) => ipcRenderer.invoke('local-coder:codex-account-mcp-login', String(profileId), String(name)),
  providerConnections: () => ipcRenderer.invoke('local-coder:connection-center-connections'),
  createApiKeyConnection: (input) => ipcRenderer.invoke('local-coder:connection-center-api-create', input),
  apiKeyConnectionDetails: (connectionId) => ipcRenderer.invoke('local-coder:connection-center-api-details', String(connectionId)),
  updateApiKeyConnection: (input) => ipcRenderer.invoke('local-coder:connection-center-api-update', input),
  rotateApiKeyConnection: (input) => ipcRenderer.invoke('local-coder:connection-center-api-rotate', input),
  setApiKeyConnectionEnabled: (input) => ipcRenderer.invoke('local-coder:connection-center-api-enabled', input),
  testApiKeyConnection: (connectionId) => ipcRenderer.invoke('local-coder:connection-center-api-test', String(connectionId)),
  removeApiKeyConnection: (connectionId) => ipcRenderer.invoke('local-coder:connection-center-api-remove', String(connectionId)),
  workHubSnapshot: () => ipcRenderer.invoke('local-coder:work-hub-snapshot'),
  upsertWorkHubSource: (input) => ipcRenderer.invoke('local-coder:work-hub-source-upsert', input),
  removeWorkHubSource: (sourceId) => ipcRenderer.invoke('local-coder:work-hub-source-remove', String(sourceId)),
  markWorkHubMessageRead: (sourceId, externalId) => ipcRenderer.invoke('local-coder:work-hub-message-read', String(sourceId), String(externalId)),
  dismissWorkHubMessage: (sourceId, externalId) => ipcRenderer.invoke('local-coder:work-hub-message-dismiss', String(sourceId), String(externalId)),
  refreshWorkHub: (sourceId) => ipcRenderer.invoke('local-coder:work-hub-refresh', sourceId === undefined ? undefined : String(sourceId)),
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
