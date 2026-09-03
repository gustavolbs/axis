import type {
  AgentSessionContext,
  MutationStatus,
  RetryEligibility,
  ToolError,
  ToolMutationRisk
} from '../../agent-runtime/index.js';

export const MCP_CAPABILITY_IDS = Object.freeze({
  invoke: 'axis.mcp.invoke'
} as const);

export const MCP_PERMISSION_IDS = Object.freeze({
  read: 'mcp.invoke.read',
  mutate: 'mcp.invoke.mutate'
} as const);

export type McpSourceKind =
  | 'axis'
  | 'connection'
  | 'claude-account'
  | 'codex-account'
  | (string & {});

export interface McpSourceIdentity {
  readonly id: string;
  readonly kind: McpSourceKind;
  readonly companyId: string;
  /** Canonical source/auth Connection. This is not the inference connection. */
  readonly connectionId?: string;
  /** Provenance only. The host never dispatches on this value. */
  readonly providerFamily?: string;
}

export type McpConfigValue =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'secret-ref'; readonly ref: string };

export interface McpStdioTransportConfig {
  readonly kind: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  /** Root id from AgentSessionContext. Arbitrary persisted cwd paths are not accepted. */
  readonly cwdRootId?: string;
  readonly env?: Readonly<Record<string, McpConfigValue>>;
}

export interface McpHttpTransportConfig {
  readonly kind: 'streamable-http' | 'sse';
  readonly url: string;
  readonly headers?: Readonly<Record<string, McpConfigValue>>;
}

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly companyId: string;
  readonly projectId?: string;
  readonly source: McpSourceIdentity;
  readonly transport: McpTransportConfig;
  readonly enabled: boolean;
  readonly timeoutMs?: number;
}

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: McpToolAnnotations;
}

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export interface McpProgressUpdate {
  readonly message?: string;
  readonly progress?: number;
  readonly total?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface McpCallToolResult {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Optional trusted bridge hint. Native MCP does not define Axis mutation status. */
  readonly mutationStatus?: Extract<MutationStatus, 'committed' | 'rolled-back' | 'unknown'>;
}

export interface McpOperationOptions {
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: McpProgressUpdate) => void;
}

export interface McpClient {
  listTools(options: McpOperationOptions): Promise<readonly McpToolDescriptor[]>;
  listResources(options: McpOperationOptions): Promise<readonly McpResourceDescriptor[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: McpOperationOptions
  ): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export interface McpSecretResolverContext {
  readonly serverId: string;
  readonly companyId: string;
  readonly sourceConnectionId?: string;
}

export interface McpSecretResolver {
  resolve(ref: string, context: McpSecretResolverContext): Promise<string> | string;
}

export interface McpClientFactoryOpenOptions {
  readonly session: AgentSessionContext;
  readonly signal: AbortSignal;
  readonly secretResolver?: McpSecretResolver;
}

export interface McpClientFactory {
  open(server: McpServerConfig, options: McpClientFactoryOpenOptions): Promise<McpClient>;
}

export interface McpConnectionOwnershipResolver {
  /** undefined means the connection is unknown; null means intentionally shared/local. */
  companyIdFor(connectionId: string): string | null | undefined;
}

export type McpHostErrorKind =
  | 'configuration'
  | 'scope'
  | 'transport'
  | 'protocol'
  | 'remote';

export class McpHostError extends Error {
  constructor(
    readonly kind: McpHostErrorKind,
    readonly code: string,
    message: string,
    readonly retry: RetryEligibility = 'never',
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'McpHostError';
  }
}

export function canonicalMcpToolError(
  error: unknown,
  mutationRisk: ToolMutationRisk = 'none'
): ToolError {
  if (error instanceof McpHostError) {
    return {
      kind: error.kind === 'protocol' ? 'protocol' : error.kind === 'transport' ? 'execution' : 'tool',
      code: error.code,
      message: error.message,
      retry: mutationRisk === 'none' ? error.retry : 'after-confirmation',
      details: error.details
    };
  }
  return {
    kind: 'tool',
    code: 'mcp_error',
    message: error instanceof Error ? error.message : String(error),
    retry: mutationRisk === 'none' ? 'safe' : 'after-confirmation'
  };
}
