import { ipcMain } from 'electron';

const CHANNELS = [
  'local-coder:claude-discover',
  'local-coder:claude-accounts',
  'local-coder:claude-account-create',
  'local-coder:claude-account-status',
  'local-coder:claude-account-login',
  'local-coder:claude-account-mcps',
  'local-coder:claude-account-mcp-add',
  'local-coder:claude-account-mcp-remove',
  'local-coder:claude-account-mcp-login',
  'local-coder:codex-discover',
  'local-coder:codex-accounts',
  'local-coder:codex-account-create',
  'local-coder:codex-account-status',
  'local-coder:codex-account-login',
  'local-coder:codex-account-mcps',
  'local-coder:codex-account-mcp-add',
  'local-coder:codex-account-mcp-remove',
  'local-coder:codex-account-mcp-login',
  'local-coder:connections',
  'local-coder:work-hub-snapshot',
  'local-coder:work-hub-source-upsert',
  'local-coder:work-hub-source-remove',
  'local-coder:work-hub-refresh'
];

let resourcesPromise;
const mcpDiscoveryCache = new Map();

function mcpCacheKey(provider, profileId) {
  return `${provider}:${profileId}`;
}

function invalidateMcpCache(provider, profileId) {
  mcpDiscoveryCache.delete(mcpCacheKey(provider, profileId));
}

async function resources() {
  if (!resourcesPromise) {
    resourcesPromise = Promise.all([
      import('../dist/claude-account-profiles.js'),
      import('../dist/codex-account-profiles.js'),
      import('../dist/provider-connections.js'),
      import('../dist/work-hub.js'),
      import('../dist/mcp-connectors.js')
    ]).then(([claude, codex, connectionsModule, workHubModule, mcpConnectors]) => {
      const claudeProfiles = new claude.ClaudeAccountProfileStore();
      const claudeRuntime = new claude.ClaudeAccountRuntime(claudeProfiles);
      const codexProfiles = new codex.CodexAccountProfileStore();
      const codexRuntime = new codex.CodexAccountRuntime(codexProfiles);
      const connections = new connectionsModule.ProviderConnectionRuntime({
        claudeProfiles,
        claudeRuntime,
        codexProfiles,
        codexRuntime
      });
      const workHub = new workHubModule.WorkHubService(
        new workHubModule.WorkHubSourceStore(),
        { connections, claudeProfiles, claudeRuntime, codexProfiles, codexRuntime }
      );
      return { claudeProfiles, claudeRuntime, codexProfiles, codexRuntime, connections, workHub, mcpConnectors };
    });
  }
  return await resourcesPromise;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertSuccessful(result, action) {
  if (result.cancelled) throw new Error(`${action} was cancelled.`);
  if (result.timedOut) throw new Error(`${action} timed out.`);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `${action} failed with exit code ${String(result.exitCode)}.`);
  }
  return result;
}

export function installClaudeAccountBridge() {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  ipcMain.handle('local-coder:claude-discover', async () => (await resources()).claudeRuntime.discover());
  ipcMain.handle('local-coder:claude-accounts', async () => (await resources()).claudeProfiles.list());
  ipcMain.handle('local-coder:claude-account-create', async (_event, raw) => {
    const input = object(raw, 'Claude account input');
    return (await resources()).claudeProfiles.create({
      id: requiredString(input.id, 'Profile id'),
      name: requiredString(input.name, 'Profile name'),
      organizationLabel: optionalString(input.organizationLabel)
    });
  });
  ipcMain.handle('local-coder:claude-account-status', async (_event, profileId) =>
    (await resources()).claudeRuntime.status(requiredString(profileId, 'Profile id'))
  );
  ipcMain.handle('local-coder:claude-account-login', async (_event, profileId, sso) => {
    const { claudeRuntime } = await resources();
    const id = requiredString(profileId, 'Profile id');
    assertSuccessful(
      await claudeRuntime.login(id, { sso: sso === true }),
      sso === true ? 'Claude SSO login' : 'Claude login'
    );
    return await claudeRuntime.status(id);
  });
  ipcMain.handle('local-coder:claude-account-mcps', async (_event, profileId, refresh) => {
    const { claudeRuntime, mcpConnectors } = await resources();
    const id = requiredString(profileId, 'Profile id');
    const cacheKey = mcpCacheKey('claude', id);
    if (refresh !== true && mcpDiscoveryCache.has(cacheKey)) return mcpDiscoveryCache.get(cacheKey);
    const result = assertSuccessful(
      await claudeRuntime.listMcp(id),
      'Claude MCP discovery'
    );
    const output = result.stdout || result.stderr;
    const discovery = { output, connectors: mcpConnectors.parseClaudeMcpList(output), durationMs: result.durationMs };
    mcpDiscoveryCache.set(cacheKey, discovery);
    return discovery;
  });
  ipcMain.handle('local-coder:claude-account-mcp-add', async (_event, raw) => {
    const input = object(raw, 'Claude MCP input');
    const id = requiredString(input.profileId, 'Profile id');
    const result = assertSuccessful(await (await resources()).claudeRuntime.addRemoteMcp(
      id,
      { name: requiredString(input.name, 'Connector name'), url: requiredString(input.url, 'Connector URL') }
    ), 'Add Claude MCP connector');
    invalidateMcpCache('claude', id);
    return result;
  });
  ipcMain.handle('local-coder:claude-account-mcp-remove', async (_event, profileId, name) => {
    const id = requiredString(profileId, 'Profile id');
    const result = assertSuccessful(await (await resources()).claudeRuntime.removeMcp(
      id, requiredString(name, 'Connector name')
    ), 'Remove Claude MCP connector');
    invalidateMcpCache('claude', id);
    return result;
  });
  ipcMain.handle('local-coder:claude-account-mcp-login', async (_event, profileId, name) => {
    const id = requiredString(profileId, 'Profile id');
    const result = assertSuccessful(await (await resources()).claudeRuntime.loginMcp(
      id, requiredString(name, 'Connector name')
    ), 'Authenticate Claude MCP connector');
    invalidateMcpCache('claude', id);
    return result;
  });

  ipcMain.handle('local-coder:codex-discover', async () => (await resources()).codexRuntime.discover());
  ipcMain.handle('local-coder:codex-accounts', async () => (await resources()).codexProfiles.list());
  ipcMain.handle('local-coder:codex-account-create', async (_event, raw) => {
    const input = object(raw, 'ChatGPT account input');
    return (await resources()).codexProfiles.create({
      id: requiredString(input.id, 'Profile id'),
      name: requiredString(input.name, 'Profile name'),
      organizationLabel: optionalString(input.organizationLabel)
    });
  });
  ipcMain.handle('local-coder:codex-account-status', async (_event, profileId) =>
    (await resources()).codexRuntime.status(requiredString(profileId, 'Profile id'))
  );
  ipcMain.handle('local-coder:codex-account-login', async (_event, profileId, deviceAuth) => {
    const { codexRuntime } = await resources();
    const id = requiredString(profileId, 'Profile id');
    assertSuccessful(
      await codexRuntime.login(id, { deviceAuth: deviceAuth === true }),
      deviceAuth === true ? 'ChatGPT device login' : 'ChatGPT login'
    );
    return await codexRuntime.status(id);
  });
  ipcMain.handle('local-coder:codex-account-mcps', async (_event, profileId, refresh) => {
    const { codexRuntime, mcpConnectors } = await resources();
    const id = requiredString(profileId, 'Profile id');
    const cacheKey = mcpCacheKey('codex', id);
    if (refresh !== true && mcpDiscoveryCache.has(cacheKey)) return mcpDiscoveryCache.get(cacheKey);
    let result = await codexRuntime.listMcp(id, { json: true });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) result = await codexRuntime.listMcp(id);
    assertSuccessful(result, 'Codex MCP discovery');
    const output = result.stdout || result.stderr;
    const discovery = { output, connectors: mcpConnectors.parseCodexMcpList(output), durationMs: result.durationMs };
    mcpDiscoveryCache.set(cacheKey, discovery);
    return discovery;
  });
  ipcMain.handle('local-coder:codex-account-mcp-add', async (_event, raw) => {
    const input = object(raw, 'Codex MCP input');
    const id = requiredString(input.profileId, 'Profile id');
    const result = assertSuccessful(await (await resources()).codexRuntime.addRemoteMcp(
      id,
      { name: requiredString(input.name, 'Connector name'), url: requiredString(input.url, 'Connector URL') }
    ), 'Add Codex MCP connector');
    invalidateMcpCache('codex', id);
    return result;
  });
  ipcMain.handle('local-coder:codex-account-mcp-remove', async (_event, profileId, name) => {
    const id = requiredString(profileId, 'Profile id');
    const result = assertSuccessful(await (await resources()).codexRuntime.removeMcp(
      id, requiredString(name, 'Connector name')
    ), 'Remove Codex MCP connector');
    invalidateMcpCache('codex', id);
    return result;
  });
  ipcMain.handle('local-coder:codex-account-mcp-login', async (_event, profileId, name) => {
    const id = requiredString(profileId, 'Profile id');
    const result = assertSuccessful(await (await resources()).codexRuntime.loginMcp(
      id, requiredString(name, 'Connector name')
    ), 'Authenticate Codex MCP connector');
    invalidateMcpCache('codex', id);
    return result;
  });

  ipcMain.handle('local-coder:connections', async () => (await resources()).connections.list());

  ipcMain.handle('local-coder:work-hub-snapshot', async () => (await resources()).workHub.snapshot());
  ipcMain.handle('local-coder:work-hub-source-upsert', async (_event, raw) => {
    const input = object(raw, 'Work Hub source input');
    return (await resources()).workHub.upsertSource({
      id: requiredString(input.id, 'Source id'),
      label: requiredString(input.label, 'Source label'),
      connectionId: requiredString(input.connectionId, 'Connection id'),
      kind: requiredString(input.kind, 'Source kind'),
      system: requiredString(input.system, 'Source system'),
      toolAllowlist: Array.isArray(input.toolAllowlist)
        ? input.toolAllowlist.filter((value) => typeof value === 'string')
        : [],
      retention: optionalString(input.retention),
      enabled: input.enabled !== false
    });
  });
  ipcMain.handle('local-coder:work-hub-source-remove', async (_event, sourceId) =>
    (await resources()).workHub.removeSource(requiredString(sourceId, 'Source id'))
  );
  ipcMain.handle('local-coder:work-hub-refresh', async (_event, sourceId) =>
    (await resources()).workHub.refresh(optionalString(sourceId))
  );
}
