import { ipcMain } from 'electron';

const CHANNELS = [
  'local-coder:connection-center-connections',
  'local-coder:connection-center-claude-create',
  'local-coder:connection-center-codex-create',
  'local-coder:connection-center-api-create',
  'local-coder:connection-center-api-details',
  'local-coder:connection-center-api-update',
  'local-coder:connection-center-api-rotate',
  'local-coder:connection-center-api-enabled',
  'local-coder:connection-center-api-test',
  'local-coder:connection-center-api-remove'
];

let resourcesPromise;

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

function optionalHeaders(value) {
  if (value === undefined) return undefined;
  const record = object(value, 'API headers');
  return Object.fromEntries(Object.entries(record).map(([name, headerValue]) => {
    if (typeof headerValue !== 'string') throw new Error(`API header ${name} must be a string.`);
    return [name, headerValue];
  }));
}

async function resources() {
  if (!resourcesPromise) {
    resourcesPromise = Promise.all([
      import('../dist/claude-account-profiles.js'),
      import('../dist/codex-account-profiles.js'),
      import('../dist/provider-connections.js'),
      import('../dist/credential-store.js'),
      import('../dist/company-context.js'),
      import('../dist/company-connection-ownership.js'),
      import('../dist/api-connection-endpoints.js'),
      import('../dist/api-key-connection-lifecycle.js')
    ]).then(([claude, codex, connectionsModule, credentialModule, companyModule, ownershipModule, endpointModule, lifecycleModule]) => {
      const claudeProfiles = new claude.ClaudeAccountProfileStore();
      const codexProfiles = new codex.CodexAccountProfileStore();
      const credentials = new credentialModule.CredentialManager();
      const companies = new companyModule.CompanyContextStore();
      const ownership = new ownershipModule.CompanyConnectionOwnership(companies);
      const apiEndpoints = new endpointModule.ApiConnectionEndpointStore();
      const connections = new connectionsModule.ProviderConnectionRuntime({
        credentials,
        claudeProfiles,
        codexProfiles
      });
      const apiLifecycle = new lifecycleModule.ApiKeyConnectionLifecycle(credentials, apiEndpoints, connections);
      return {
        claudeProfiles,
        codexProfiles,
        credentials,
        companies,
        ownership,
        apiEndpoints,
        apiLifecycle,
        connections,
        connectionIds: {
          claude: connectionsModule.claudeAccountConnectionId,
          codex: connectionsModule.chatGptAccountConnectionId,
          api: connectionsModule.apiCredentialConnectionId
        },
        personalCompanyId: companyModule.PERSONAL_COMPANY_ID
      };
    });
  }
  return await resourcesPromise;
}

function selectedCompanyId(input, personalCompanyId) {
  return optionalString(input.companyId) ?? personalCompanyId;
}

function assertNewProfile(store, id, label) {
  if (store.list().some((profile) => profile.id === id)) {
    throw new Error(`${label} already exists: ${id}`);
  }
}

function canonicalConnectionViews(companies, connections) {
  const views = connections.list();
  const snapshot = companies.reconcile({
    projects: [],
    sessions: [],
    connections: views
  });
  const ownerByConnection = new Map();
  for (const company of snapshot.companies) {
    for (const connectionId of company.connectionIds) ownerByConnection.set(connectionId, company);
  }

  return views.map((connection) => {
    if (connection.auth === 'local') return { ...connection };
    const company = ownerByConnection.get(connection.id);
    if (!company) throw new Error(`Connection ${connection.id} is missing a canonical Company binding.`);
    return {
      ...connection,
      organizationId: company.id,
      companyId: company.id,
      companyName: company.name,
      companyArchived: Boolean(company.archivedAt)
    };
  });
}

export function installConnectionCenterBridge() {
  // Dedicated channels avoid handler-order coupling with the provider-owned
  // account bridge. Login/status/MCP remain on that bridge; the Center owns
  // canonical inventory and Company-aware lifecycle operations.
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  ipcMain.handle('local-coder:connection-center-connections', async () => {
    const { connections, companies } = await resources();
    return canonicalConnectionViews(companies, connections);
  });

  ipcMain.handle('local-coder:connection-center-claude-create', async (_event, raw) => {
    const input = object(raw, 'Claude account input');
    const { claudeProfiles, ownership, connectionIds, personalCompanyId } = await resources();
    const id = requiredString(input.id, 'Profile id');
    const name = requiredString(input.name, 'Profile name');
    const companyId = selectedCompanyId(input, personalCompanyId);
    const company = ownership.company(companyId);
    assertNewProfile(claudeProfiles, id, 'Claude account profile');
    ownership.bind({
      id: connectionIds.claude(id),
      label: name,
      auth: 'claude-account',
      organizationLabel: optionalString(input.organizationLabel) ?? company.name
    }, company.id);
    return claudeProfiles.create({
      id,
      name,
      organizationLabel: optionalString(input.organizationLabel)
    });
  });

  ipcMain.handle('local-coder:connection-center-codex-create', async (_event, raw) => {
    const input = object(raw, 'ChatGPT account input');
    const { codexProfiles, ownership, connectionIds, personalCompanyId } = await resources();
    const id = requiredString(input.id, 'Profile id');
    const name = requiredString(input.name, 'Profile name');
    const companyId = selectedCompanyId(input, personalCompanyId);
    const company = ownership.company(companyId);
    assertNewProfile(codexProfiles, id, 'Codex account profile');
    ownership.bind({
      id: connectionIds.codex(id),
      label: name,
      auth: 'chatgpt-account',
      organizationLabel: optionalString(input.organizationLabel) ?? company.name
    }, company.id);
    return codexProfiles.create({
      id,
      name,
      organizationLabel: optionalString(input.organizationLabel)
    });
  });

  ipcMain.handle('local-coder:connection-center-api-create', async (_event, raw) => {
    const input = object(raw, 'API connection input');
    const { credentials, ownership, apiEndpoints, connections, connectionIds, personalCompanyId } = await resources();
    const providerFamily = requiredString(input.providerFamily, 'Provider');
    if (providerFamily !== 'openai' && providerFamily !== 'anthropic') {
      throw new Error('Provider must be openai or anthropic for an API Key connection.');
    }
    const id = requiredString(input.id, 'Credential id');
    const name = requiredString(input.name, 'Connection name');
    const secret = requiredString(input.secret, 'API key');
    const endpoint = optionalString(input.endpoint);
    const headers = optionalHeaders(input.headers);
    if (credentials.getProfile(id)) throw new Error(`Credential already exists: ${id}`);
    const companyId = selectedCompanyId(input, personalCompanyId);
    const company = ownership.company(companyId);
    const connectionId = connectionIds.api(providerFamily, id);

    // Bind before touching Keychain so a stale id/company conflict fails without
    // replacing a secret. A failed Keychain write can leave only a harmless
    // metadata binding; retrying the same id is then constrained to that Company.
    ownership.bind({
      id: connectionId,
      label: name,
      auth: 'api-key',
      organizationId: company.id,
      organizationLabel: company.name
    }, company.id);

    credentials.addOrReplaceKeychainCredential({
      id,
      providerId: providerFamily,
      label: name,
      organizationId: company.id,
      secret
    });
    try {
      apiEndpoints.upsert({
        connectionId,
        providerFamily,
        credentialId: id,
        endpoint,
        headers
      });
    } catch (error) {
      // Transport metadata is part of the connection contract. Do not leave a
      // newly-created Keychain credential behind if its validated config fails.
      try { credentials.remove(id); } catch { /* best effort rollback */ }
      throw error;
    }

    const connection = connections.view(connectionId);
    if (!connection) throw new Error(`Connection ${connectionId} was not created.`);
    return ownership.canonicalize([connection])[0];
  });

  ipcMain.handle('local-coder:connection-center-api-details', async (_event, connectionIdValue) => {
    const { apiLifecycle } = await resources();
    return apiLifecycle.details(requiredString(connectionIdValue, 'Connection id'));
  });

  ipcMain.handle('local-coder:connection-center-api-update', async (_event, raw) => {
    const input = object(raw, 'API connection update');
    const { apiLifecycle } = await resources();
    const connectionId = requiredString(input.connectionId, 'Connection id');
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(input, 'name')) patch.name = requiredString(input.name, 'Connection name');
    if (Object.prototype.hasOwnProperty.call(input, 'endpoint')) {
      patch.endpoint = input.endpoint === null ? null : optionalString(input.endpoint) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'headers')) patch.headers = optionalHeaders(input.headers) ?? {};
    return apiLifecycle.edit(connectionId, patch);
  });

  ipcMain.handle('local-coder:connection-center-api-rotate', async (_event, raw) => {
    const input = object(raw, 'API key rotation');
    const { apiLifecycle } = await resources();
    return apiLifecycle.rotate(
      requiredString(input.connectionId, 'Connection id'),
      requiredString(input.secret, 'Replacement API key')
    );
  });

  ipcMain.handle('local-coder:connection-center-api-enabled', async (_event, raw) => {
    const input = object(raw, 'API connection enabled state');
    if (typeof input.enabled !== 'boolean') throw new Error('Enabled state must be boolean.');
    const { apiLifecycle } = await resources();
    return apiLifecycle.setEnabled(requiredString(input.connectionId, 'Connection id'), input.enabled);
  });

  ipcMain.handle('local-coder:connection-center-api-test', async (_event, connectionIdValue) => {
    const { apiLifecycle } = await resources();
    return await apiLifecycle.test(requiredString(connectionIdValue, 'Connection id'));
  });

  ipcMain.handle('local-coder:connection-center-api-remove', async (_event, connectionIdValue) => {
    const { apiLifecycle } = await resources();
    return apiLifecycle.remove(requiredString(connectionIdValue, 'Connection id'));
  });
}
