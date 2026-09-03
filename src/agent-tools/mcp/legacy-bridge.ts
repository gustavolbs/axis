import type { McpConnector } from '../../mcp-connectors.js';
import type { McpServerConfig, McpSourceIdentity } from './types.js';
import { McpHostError } from './types.js';

export interface LegacyMcpBridgeInput {
  readonly connector: McpConnector;
  readonly id: string;
  readonly companyId: string;
  readonly projectId?: string;
  readonly source: McpSourceIdentity;
  readonly enabled?: boolean;
}

/**
 * Reuses existing Claude/Codex MCP discovery as provenance/config input only.
 * Execution still goes through Axis MCP host and never back through a provider loop.
 */
export function legacyConnectorToServerConfig(input: LegacyMcpBridgeInput): McpServerConfig {
  const target = input.connector.target?.trim();
  if (!target) {
    throw new McpHostError('configuration', 'mcp_legacy_target_missing', `Discovered MCP connector ${input.connector.name} has no executable target.`);
  }
  if (input.connector.transport === 'http' || input.connector.transport === 'sse') {
    return {
      id: input.id,
      name: input.connector.name,
      companyId: input.companyId,
      projectId: input.projectId,
      source: input.source,
      transport: {
        kind: input.connector.transport === 'sse' ? 'sse' : 'streamable-http',
        url: target
      },
      enabled: input.enabled ?? input.connector.status !== 'disabled'
    };
  }
  if (input.connector.transport === 'stdio') {
    return {
      id: input.id,
      name: input.connector.name,
      companyId: input.companyId,
      projectId: input.projectId,
      source: input.source,
      transport: { kind: 'stdio', command: target },
      enabled: input.enabled ?? input.connector.status !== 'disabled'
    };
  }
  throw new McpHostError(
    'configuration',
    'mcp_legacy_transport_unsupported',
    `Discovered MCP connector ${input.connector.name} uses unsupported transport ${input.connector.transport}.`
  );
}
