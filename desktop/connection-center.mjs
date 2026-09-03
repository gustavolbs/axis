import { ipcMain } from 'electron';

const OVERRIDDEN_CHANNELS = [
  'local-coder:connections',
  'local-coder:claude-account-create',
  'local-coder:codex-account-create',
  'local-coder:api-connection-create'
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

async function resources() {
  if (!resourcesPromise) {
    resourcesPromise = Promise.all([
      import('../dist/claude-account-profiles.js'),
      import('../dist/codex-account-profiles.js'),
      import('../dist/provider-connections.js'),
      import('../dist/credential-store.js'),
      import('../dist/company-context.js'),
      import('../dist/company-connection-ownership.js')
    ]).then(([claude, codex, connectionsModule, credentialModule, companyModule, ownershipModule]) => {
      const claudeProfiles = new claude.ClaudeAccountProfileStore();
      const codexProfiles = new codex.CodexAccountProfileStore();
      const credentials = new credentialModule.CredentialManager();
      const companies = new companyModule.CompanyContextStore();
      const ownership = new ownershipModule.CompanyConnectionOwnership(companies);
      const connections = new connectionsModule.ProviderConnectionRuntime({
        credentials,
        claudeProfiles,
        codexProfiles
      });
      return {
        claudeProfiles,
        codexProfiles,
        credentials,
        companies,
        ownership,
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
  for (const channel of OVERRIDDEN_CHANNELS) ipcMain.removeHandler(channel);

  ipcMain.handle('local-coder:connections', async () => {
    const { connections, companies } = await resources();
    return canonicalConnectionViews(companies, connections);
  });

  ipcMain.handle('local-coder:claude-account-create', async (_event, raw) => {
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

  ipcMain.handle('local-coder:codex-account-create', async (_event, raw) => {
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

  ipcMain.handle('local-coder:api-connection-create', async (_event, raw) => {
    const input = object(raw, 'API connection input');
    const { credentials, ownership, connections, connectionIds, personalCompanyId } = await resources();
    const providerFamily = requiredString(input.providerFamily, 'Provider');
    if (providerFamily !== 'openai' && providerFamily !== 'anthropic') {
      throw new Error('Provider must be openai or anthropic for an API Key connection.');
    }
    const id = requiredString(input.id, 'Credential id');
    const name = requiredString(input.name, 'Connection name');
    const secret = requiredString(input.secret, 'API key');
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

    const connection = connections.view(connectionId);
    if (!connection) throw new Error(`Connection ${connectionId} was not created.`);
    return ownership.canonicalize([connection])[0];
  });
}
