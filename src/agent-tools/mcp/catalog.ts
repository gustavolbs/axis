import type { AgentResourceBinding, AgentSessionContext } from '../../agent-runtime/index.js';
import { validateMcpName, validateRemoteMcpInput } from '../../mcp-connectors.js';
import type {
  McpConfigValue,
  McpConnectionOwnershipResolver,
  McpServerConfig
} from './types.js';
import { McpHostError } from './types.js';

const SAFE_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL = /[\0\r\n]/;
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passwd|api[-_]?key|private[-_]?key)/i;

function requiredId(value: string, label: string): string {
  const clean = value.trim();
  if (!SAFE_SERVER_ID.test(clean) || clean === '.' || clean === '..') {
    throw new McpHostError('configuration', 'mcp_invalid_id', `${label} must be a safe non-empty id.`);
  }
  return clean;
}

function requiredText(value: string, label: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 512 || CONTROL.test(clean)) {
    throw new McpHostError('configuration', 'mcp_invalid_config', `${label} is invalid.`);
  }
  return clean;
}

function validateConfigValue(key: string, value: McpConfigValue): void {
  if (value.kind === 'secret-ref') {
    requiredText(value.ref, `Secret reference for ${key}`);
    return;
  }
  if (CONTROL.test(value.value)) {
    throw new McpHostError('configuration', 'mcp_invalid_config', `Literal configuration for ${key} contains control characters.`);
  }
  if (SENSITIVE_KEY.test(key)) {
    throw new McpHostError(
      'configuration',
      'mcp_inline_secret_rejected',
      `Sensitive MCP configuration ${key} must use a secret reference.`
    );
  }
}

function cloneValue(value: McpConfigValue): McpConfigValue {
  return value.kind === 'secret-ref'
    ? Object.freeze({ kind: 'secret-ref', ref: value.ref.trim() })
    : Object.freeze({ kind: 'literal', value: value.value });
}

function normalizeServer(input: McpServerConfig): McpServerConfig {
  const id = requiredId(input.id, 'MCP server id');
  const companyId = requiredId(input.companyId, 'MCP Company id');
  const projectId = input.projectId === undefined ? undefined : requiredId(input.projectId, 'MCP Project id');
  const sourceId = requiredId(input.source.id, 'MCP source id');
  const sourceCompanyId = requiredId(input.source.companyId, 'MCP source Company id');
  if (sourceCompanyId !== companyId) {
    throw new McpHostError(
      'scope',
      'mcp_source_company_mismatch',
      `MCP source ${sourceId} belongs to Company ${sourceCompanyId}, not server Company ${companyId}.`
    );
  }
  const sourceConnectionId = input.source.connectionId === undefined
    ? undefined
    : requiredId(input.source.connectionId, 'MCP source Connection id');
  if (input.source.kind !== 'axis' && !sourceConnectionId) {
    throw new McpHostError(
      'configuration',
      'mcp_source_connection_required',
      `MCP source ${sourceId} must identify its canonical Connection.`
    );
  }

  let transport: McpServerConfig['transport'];
  if (input.transport.kind === 'stdio') {
    const command = requiredText(input.transport.command, 'MCP stdio command');
    const args = Object.freeze((input.transport.args ?? []).map((arg) => {
      if (CONTROL.test(arg)) throw new McpHostError('configuration', 'mcp_invalid_config', 'MCP stdio argument contains control characters.');
      return arg;
    }));
    const envEntries = Object.entries(input.transport.env ?? {}).map(([key, value]) => {
      const cleanKey = requiredText(key, 'MCP environment key');
      validateConfigValue(cleanKey, value);
      return [cleanKey, cloneValue(value)] as const;
    });
    transport = Object.freeze({
      kind: 'stdio' as const,
      command,
      args,
      cwdRootId: input.transport.cwdRootId === undefined
        ? undefined
        : requiredId(input.transport.cwdRootId, 'MCP cwd root id'),
      env: Object.freeze(Object.fromEntries(envEntries))
    });
  } else {
    const remote = validateRemoteMcpInput(id, input.transport.url);
    const headerEntries = Object.entries(input.transport.headers ?? {}).map(([key, value]) => {
      const cleanKey = requiredText(key, 'MCP header name');
      validateConfigValue(cleanKey, value);
      return [cleanKey, cloneValue(value)] as const;
    });
    transport = Object.freeze({
      kind: input.transport.kind,
      url: remote.url,
      headers: Object.freeze(Object.fromEntries(headerEntries))
    });
  }

  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60_000)) {
    throw new McpHostError('configuration', 'mcp_invalid_timeout', 'MCP timeout must be between 1 ms and 30 minutes.');
  }

  return Object.freeze({
    id,
    name: validateMcpName(input.name),
    companyId,
    projectId,
    source: Object.freeze({
      id: sourceId,
      kind: input.source.kind,
      companyId: sourceCompanyId,
      connectionId: sourceConnectionId,
      providerFamily: input.source.providerFamily?.trim() || undefined
    }),
    transport,
    enabled: Boolean(input.enabled),
    timeoutMs
  });
}

function mcpBinding(session: AgentSessionContext, serverId: string): AgentResourceBinding | undefined {
  return session.resources.find((resource) => resource.kind === 'mcp' && resource.id === serverId);
}

export function assertMcpServerAuthorized(server: McpServerConfig, session: AgentSessionContext): void {
  if (!server.enabled) {
    throw new McpHostError('scope', 'mcp_server_disabled', `MCP server ${server.id} is disabled.`);
  }
  if (server.companyId !== session.companyId) {
    throw new McpHostError(
      'scope',
      'mcp_company_mismatch',
      `MCP server ${server.id} belongs to Company ${server.companyId}, not session Company ${session.companyId}.`
    );
  }
  if (server.projectId !== undefined && server.projectId !== session.project?.id) {
    throw new McpHostError(
      'scope',
      'mcp_project_mismatch',
      `MCP server ${server.id} belongs to Project ${server.projectId}, not session Project ${session.project?.id ?? '(none)'}.`
    );
  }
  if (server.source.companyId !== session.companyId) {
    throw new McpHostError('scope', 'mcp_source_company_mismatch', `MCP source ${server.source.id} is outside the session Company.`);
  }
  const binding = mcpBinding(session, server.id);
  if (!binding) {
    throw new McpHostError(
      'scope',
      'mcp_resource_not_bound',
      `MCP server ${server.id} is not bound to this session as an MCP resource.`
    );
  }
  if (binding.companyId !== session.companyId) {
    throw new McpHostError('scope', 'mcp_resource_company_mismatch', `MCP resource ${server.id} is bound to another Company.`);
  }
  if (binding.projectId !== undefined && binding.projectId !== session.project?.id) {
    throw new McpHostError('scope', 'mcp_resource_project_mismatch', `MCP resource ${server.id} is bound to another Project.`);
  }
}

export class McpServerCatalog {
  private readonly servers = new Map<string, McpServerConfig>();

  constructor(
    servers: readonly McpServerConfig[] = [],
    private readonly connectionOwnership?: McpConnectionOwnershipResolver
  ) {
    for (const server of servers) this.register(server);
  }

  register(input: McpServerConfig): McpServerConfig {
    const server = normalizeServer(input);
    if (this.servers.has(server.id)) {
      throw new McpHostError('configuration', 'mcp_server_duplicate', `MCP server ${server.id} is already registered.`);
    }
    this.assertSourceOwnership(server);
    this.servers.set(server.id, server);
    return server;
  }

  replace(input: McpServerConfig): McpServerConfig {
    const server = normalizeServer(input);
    if (!this.servers.has(server.id)) {
      throw new McpHostError('configuration', 'mcp_server_unknown', `Unknown MCP server ${server.id}.`);
    }
    this.assertSourceOwnership(server);
    this.servers.set(server.id, server);
    return server;
  }

  remove(id: string): boolean {
    return this.servers.delete(requiredId(id, 'MCP server id'));
  }

  get(id: string): McpServerConfig | undefined {
    return this.servers.get(id.trim());
  }

  require(id: string): McpServerConfig {
    const server = this.get(id);
    if (!server) throw new McpHostError('configuration', 'mcp_server_unknown', `Unknown MCP server ${id}.`);
    return server;
  }

  listForSession(session: AgentSessionContext): McpServerConfig[] {
    return [...this.servers.values()]
      .filter((server) => {
        try {
          assertMcpServerAuthorized(server, session);
          return true;
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  listConfigured(): McpServerConfig[] {
    return [...this.servers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private assertSourceOwnership(server: McpServerConfig): void {
    const connectionId = server.source.connectionId;
    if (!connectionId || !this.connectionOwnership) return;
    const owner = this.connectionOwnership.companyIdFor(connectionId);
    if (owner === undefined) {
      throw new McpHostError(
        'scope',
        'mcp_source_connection_unknown',
        `MCP source Connection ${connectionId} is not present in canonical connection ownership.`
      );
    }
    if (owner === null || owner !== server.companyId) {
      throw new McpHostError(
        'scope',
        'mcp_source_connection_company_mismatch',
        `MCP source Connection ${connectionId} is not owned by Company ${server.companyId}.`
      );
    }
  }
}
