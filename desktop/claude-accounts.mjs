import { ipcMain } from 'electron';

const CHANNELS = [
  'local-coder:claude-discover',
  'local-coder:claude-accounts',
  'local-coder:claude-account-create',
  'local-coder:claude-account-status',
  'local-coder:claude-account-login',
  'local-coder:claude-account-mcps'
];

let resourcesPromise;

async function resources() {
  if (!resourcesPromise) {
    resourcesPromise = import('../dist/claude-account-profiles.js').then((module) => {
      const profiles = new module.ClaudeAccountProfileStore();
      const runtime = new module.ClaudeAccountRuntime(profiles);
      return { profiles, runtime };
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

  ipcMain.handle('local-coder:claude-discover', async () => {
    const { runtime } = await resources();
    return await runtime.discover();
  });

  ipcMain.handle('local-coder:claude-accounts', async () => {
    const { profiles } = await resources();
    return profiles.list();
  });

  ipcMain.handle('local-coder:claude-account-create', async (_event, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Claude account input must be an object.');
    }
    const { profiles } = await resources();
    return profiles.create({
      id: requiredString(input.id, 'Profile id'),
      name: requiredString(input.name, 'Profile name'),
      organizationLabel: optionalString(input.organizationLabel)
    });
  });

  ipcMain.handle('local-coder:claude-account-status', async (_event, profileId) => {
    const { runtime } = await resources();
    return await runtime.status(requiredString(profileId, 'Profile id'));
  });

  ipcMain.handle('local-coder:claude-account-login', async (_event, profileId, sso) => {
    const { runtime } = await resources();
    const id = requiredString(profileId, 'Profile id');
    assertSuccessful(
      await runtime.login(id, { sso: sso === true }),
      sso === true ? 'Claude SSO login' : 'Claude login'
    );
    return await runtime.status(id);
  });

  ipcMain.handle('local-coder:claude-account-mcps', async (_event, profileId) => {
    const { runtime } = await resources();
    const result = assertSuccessful(
      await runtime.listMcp(requiredString(profileId, 'Profile id')),
      'Claude MCP discovery'
    );
    return {
      output: result.stdout || result.stderr,
      durationMs: result.durationMs
    };
  });
}
