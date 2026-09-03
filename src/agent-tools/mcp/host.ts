import { createHash } from 'node:crypto';

import type {
  AgentSessionContext,
  AxisTool,
  MutationStatus,
  ToolExecutionContext,
  ToolMutationRisk
} from '../../agent-runtime/index.js';
import { assertMcpServerAuthorized, McpServerCatalog } from './catalog.js';
import { NativeMcpClientFactory } from './client.js';
import type {
  McpCallToolResult,
  McpClient,
  McpClientFactory,
  McpProgressUpdate,
  McpResourceDescriptor,
  McpSecretResolver,
  McpServerConfig,
  McpToolDescriptor
} from './types.js';
import { MCP_CAPABILITY_IDS, MCP_PERMISSION_IDS, McpHostError } from './types.js';

export interface McpDiscoveredServer {
  readonly server: McpServerConfig;
  readonly tools: readonly McpToolDescriptor[];
  readonly resources: readonly McpResourceDescriptor[];
}

export interface McpHostOptions {
  readonly catalog: McpServerCatalog;
  readonly clients?: McpClientFactory;
  readonly secrets?: McpSecretResolver;
  readonly defaultTimeoutMs?: number;
}

interface ClientEntry {
  readonly client: McpClient;
  readonly cacheKey: string;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new McpHostError('configuration', 'mcp_invalid_timeout', 'MCP timeout must be a positive number.');
  }
  return timeout;
}

function linkedTimeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`MCP operation timed out after ${timeoutMs} ms.`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    }
  };
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
  return slug || 'tool';
}

export function canonicalMcpAxisToolName(serverId: string, toolName: string): string {
  const hash = createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 10);
  return `axis_mcp_${safeSlug(serverId)}_${safeSlug(toolName)}_${hash}`;
}

function mutationRisk(tool: McpToolDescriptor): ToolMutationRisk {
  if (tool.annotations?.readOnlyHint === true) return 'none';
  if (tool.annotations?.readOnlyHint === false) return 'definite';
  return 'possible';
}

function successfulMutationStatus(
  tool: McpToolDescriptor,
  result: McpCallToolResult
): MutationStatus {
  const risk = mutationRisk(tool);
  if (risk === 'none') return 'not-applicable';
  if (result.mutationStatus) return result.mutationStatus;
  if (tool.annotations?.readOnlyHint === false) return 'committed';
  return 'unknown';
}

function retryPolicy(tool: McpToolDescriptor): 'safe' | 'after-confirmation' {
  return mutationRisk(tool) === 'none' ? 'safe' : 'after-confirmation';
}

function resultPayload(result: McpCallToolResult): unknown {
  if (result.structuredContent !== undefined) {
    return result.content === undefined
      ? result.structuredContent
      : { structuredContent: result.structuredContent, content: result.content };
  }
  return result.content;
}

function remoteErrorText(result: McpCallToolResult): string {
  const content = result.content;
  if (typeof content === 'string') return content.slice(0, 1_000);
  if (Array.isArray(content)) {
    const text = content
      .flatMap((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).text === 'string'
        ? [(item as Record<string, unknown>).text as string]
        : [])
      .join('\n')
      .trim();
    if (text) return text.slice(0, 1_000);
  }
  return 'MCP server reported a tool execution error.';
}

function clientCacheKey(server: McpServerConfig, session: AgentSessionContext): string {
  return [server.id, session.companyId, server.projectId ?? session.project?.id ?? '-', server.source.id].join('\0');
}

function reportMcpProgress(context: ToolExecutionContext, progress: McpProgressUpdate): void {
  context.reportProgress({
    message: progress.message?.trim() || 'MCP operation in progress',
    completed: progress.progress,
    total: progress.total,
    metadata: progress.metadata
  });
}

export class McpHost {
  readonly catalog: McpServerCatalog;
  private readonly clients: McpClientFactory;
  private readonly secrets?: McpSecretResolver;
  private readonly defaultTimeoutMs: number;
  private readonly clientCache = new Map<string, Promise<ClientEntry>>();

  constructor(options: McpHostOptions) {
    this.catalog = options.catalog;
    this.clients = options.clients ?? new NativeMcpClientFactory();
    this.secrets = options.secrets;
    this.defaultTimeoutMs = positiveTimeout(options.defaultTimeoutMs, 120_000);
  }

  /** Discover only MCP servers explicitly present in the immutable session resource set. */
  async discover(session: AgentSessionContext, signal: AbortSignal): Promise<readonly McpDiscoveredServer[]> {
    const discovered: McpDiscoveredServer[] = [];
    for (const server of this.catalog.listForSession(session)) {
      const [tools, resources] = await Promise.all([
        this.listToolsOnServer(server, session, signal),
        this.listResourcesOnServer(server, session, signal)
      ]);
      discovered.push({ server, tools, resources });
    }
    return discovered;
  }

  async toolsForSession(session: AgentSessionContext, signal: AbortSignal): Promise<readonly AxisTool[]> {
    const tools: AxisTool[] = [];
    for (const server of this.catalog.listForSession(session)) {
      const descriptors = await this.listToolsOnServer(server, session, signal);
      tools.push(...descriptors.map((descriptor) => this.axisTool(server, descriptor)));
    }
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.definition.name)) {
        throw new McpHostError('protocol', 'mcp_tool_name_collision', `Canonical MCP tool name collision: ${tool.definition.name}.`);
      }
      names.add(tool.definition.name);
    }
    return tools.sort((left, right) => left.definition.name.localeCompare(right.definition.name));
  }

  async listResources(
    session: AgentSessionContext,
    signal: AbortSignal,
    serverId?: string
  ): Promise<readonly McpResourceDescriptor[]> {
    const servers = serverId
      ? [this.catalog.require(serverId)]
      : this.catalog.listForSession(session);
    const resources: McpResourceDescriptor[] = [];
    for (const server of servers) {
      assertMcpServerAuthorized(server, session);
      resources.push(...await this.listResourcesOnServer(server, session, signal));
    }
    return resources;
  }

  async close(): Promise<void> {
    const entries = [...this.clientCache.values()];
    this.clientCache.clear();
    await Promise.allSettled(entries.map(async (entry) => (await entry).client.close()));
  }

  private axisTool(server: McpServerConfig, descriptor: McpToolDescriptor): AxisTool {
    const risk = mutationRisk(descriptor);
    const readOnly = risk === 'none';
    const canonicalName = canonicalMcpAxisToolName(server.id, descriptor.name);
    return {
      definition: {
        name: canonicalName,
        description: descriptor.description?.trim() || `Invoke MCP tool ${descriptor.name} from ${server.name}.`,
        inputSchema: descriptor.inputSchema ?? { type: 'object', additionalProperties: true },
        requiredCapabilities: [MCP_CAPABILITY_IDS.invoke],
        requiredPermissions: [readOnly ? MCP_PERMISSION_IDS.read : MCP_PERMISSION_IDS.mutate],
        effect: 'external',
        mutationRisk: risk,
        retryOnFailure: retryPolicy(descriptor),
        timeoutMs: server.timeoutMs ?? this.defaultTimeoutMs
      },
      execute: async (context) => {
        assertMcpServerAuthorized(server, context.session);
        context.reportActivity({
          kind: readOnly ? 'read' : 'mutation',
          detail: `MCP ${server.id}/${descriptor.name}`,
          metadata: {
            serverId: server.id,
            mcpToolName: descriptor.name,
            sourceId: server.source.id,
            sourceConnectionId: server.source.connectionId,
            sourceProviderFamily: server.source.providerFamily
          }
        });
        const result = await this.invoke(server, descriptor, context);
        if (result.isError) {
          throw new McpHostError(
            'remote',
            'mcp_tool_error',
            remoteErrorText(result),
            readOnly ? 'safe' : 'after-confirmation',
            { serverId: server.id, mcpToolName: descriptor.name }
          );
        }
        return {
          output: resultPayload(result),
          mutationStatus: successfulMutationStatus(descriptor, result),
          retry: retryPolicy(descriptor),
          metadata: {
            serverId: server.id,
            mcpToolName: descriptor.name,
            sourceId: server.source.id,
            sourceConnectionId: server.source.connectionId,
            sourceProviderFamily: server.source.providerFamily,
            sourceAuthIndependentFromInference: server.source.connectionId !== context.session.connection.id,
            ...(result.metadata ? { mcp: result.metadata } : {})
          }
        };
      }
    };
  }

  private async invoke(
    server: McpServerConfig,
    descriptor: McpToolDescriptor,
    context: ToolExecutionContext
  ): Promise<McpCallToolResult> {
    try {
      // AxisTool execution already receives the AgentRuntime-owned cancellation/timeout
      // signal. Do not create a competing timer here or a timeout race could be
      // misclassified by the canonical runtime as a generic tool failure.
      const client = await this.clientFor(server, context.session, context.signal);
      return await client.callTool(descriptor.name, context.call.arguments, {
        signal: context.signal,
        onProgress: (progress) => reportMcpProgress(context, progress)
      });
    } catch (error) {
      if (!context.signal.aborted) this.evict(server, context.session);
      throw error;
    }
  }

  private async listToolsOnServer(
    server: McpServerConfig,
    session: AgentSessionContext,
    signal: AbortSignal
  ): Promise<readonly McpToolDescriptor[]> {
    assertMcpServerAuthorized(server, session);
    return await this.runReadOperation(server, session, signal, async (client, operationSignal) =>
      await client.listTools({ signal: operationSignal })
    );
  }

  private async listResourcesOnServer(
    server: McpServerConfig,
    session: AgentSessionContext,
    signal: AbortSignal
  ): Promise<readonly McpResourceDescriptor[]> {
    assertMcpServerAuthorized(server, session);
    return await this.runReadOperation(server, session, signal, async (client, operationSignal) =>
      await client.listResources({ signal: operationSignal })
    );
  }

  private async runReadOperation<T>(
    server: McpServerConfig,
    session: AgentSessionContext,
    signal: AbortSignal,
    operation: (client: McpClient, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const linked = linkedTimeoutSignal(signal, positiveTimeout(server.timeoutMs, this.defaultTimeoutMs));
    try {
      const client = await this.clientFor(server, session, linked.signal);
      return await operation(client, linked.signal);
    } catch (error) {
      if (!linked.signal.aborted) this.evict(server, session);
      throw error;
    } finally {
      linked.dispose();
    }
  }

  private async clientFor(
    server: McpServerConfig,
    session: AgentSessionContext,
    signal: AbortSignal
  ): Promise<McpClient> {
    assertMcpServerAuthorized(server, session);
    const cacheKey = clientCacheKey(server, session);
    let pending = this.clientCache.get(cacheKey);
    if (!pending) {
      pending = this.clients.open(server, {
        session,
        signal,
        secretResolver: this.secrets
      }).then((client) => ({ client, cacheKey })).catch((error) => {
        this.clientCache.delete(cacheKey);
        throw error;
      });
      this.clientCache.set(cacheKey, pending);
    }
    return (await pending).client;
  }

  private evict(server: McpServerConfig, session: AgentSessionContext): void {
    const key = clientCacheKey(server, session);
    const pending = this.clientCache.get(key);
    this.clientCache.delete(key);
    if (pending) void pending.then((entry) => entry.client.close()).catch(() => undefined);
  }
}
