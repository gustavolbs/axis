import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentRuntime,
  negotiateEffectiveCapabilities,
  type AgentLifecycleEvent,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentSessionContext
} from '../src/agent-runtime/index.js';
import {
  MCP_CAPABILITY_IDS,
  MCP_PERMISSION_IDS,
  McpHost,
  McpHostError,
  McpServerCatalog,
  canonicalMcpToolError,
  type McpCallToolResult,
  type McpClient,
  type McpClientFactory,
  type McpClientFactoryOpenOptions,
  type McpOperationOptions,
  type McpResourceDescriptor,
  type McpServerConfig,
  type McpToolDescriptor
} from '../src/agent-tools/mcp/index.js';

class FakeClient implements McpClient {
  readonly calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];

  constructor(
    readonly tools: readonly McpToolDescriptor[],
    readonly resources: readonly McpResourceDescriptor[] = [],
    private readonly invoke: (
      name: string,
      args: Readonly<Record<string, unknown>>,
      options: McpOperationOptions
    ) => Promise<McpCallToolResult> = async () => ({ content: [{ type: 'text', text: 'ok' }] })
  ) {}

  async listTools(): Promise<readonly McpToolDescriptor[]> { return this.tools; }
  async listResources(): Promise<readonly McpResourceDescriptor[]> { return this.resources; }
  async callTool(name: string, args: Readonly<Record<string, unknown>>, options: McpOperationOptions): Promise<McpCallToolResult> {
    this.calls.push({ name, args });
    return await this.invoke(name, args, options);
  }
  async close(): Promise<void> {}
}

class FakeFactory implements McpClientFactory {
  readonly opened: Array<{ serverId: string; inferenceConnectionId: string; sourceConnectionId?: string }> = [];
  constructor(private readonly clients: Readonly<Record<string, McpClient>>) {}
  async open(server: McpServerConfig, options: McpClientFactoryOpenOptions): Promise<McpClient> {
    this.opened.push({
      serverId: server.id,
      inferenceConnectionId: options.session.connection.id,
      sourceConnectionId: server.source.connectionId
    });
    const client = this.clients[server.id];
    if (!client) throw new Error(`No fake MCP client for ${server.id}`);
    return client;
  }
}

function server(input: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'calendar',
    name: 'Calendar',
    companyId: 'acme',
    projectId: 'project-acme',
    source: {
      id: 'claude-source',
      kind: 'claude-account',
      companyId: 'acme',
      connectionId: 'connection-claude-source',
      providerFamily: 'anthropic'
    },
    transport: { kind: 'streamable-http', url: 'https://mcp.example.test/mcp' },
    enabled: true,
    timeoutMs: 500,
    ...input
  };
}

function session(input: {
  companyId?: string;
  connectionId?: string;
  providerFamily?: string;
  capabilities?: boolean;
  serverId?: string;
  permissions?: Record<string, 'granted' | 'denied' | 'ask'>;
} = {}): AgentSessionContext {
  const companyId = input.companyId ?? 'acme';
  const projectId = `project-${companyId}`;
  const serverId = input.serverId ?? 'calendar';
  return {
    sessionId: `session-${companyId}-${input.connectionId ?? 'inference'}`,
    companyId,
    project: { id: projectId, companyId },
    connection: {
      id: input.connectionId ?? 'connection-openai-inference',
      providerFamily: input.providerFamily ?? 'openai',
      authKind: 'api-key',
      companyId
    },
    modelId: 'model-test',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{ id: 'workspace', path: `/workspace/${companyId}`, access: 'write', companyId, projectId }],
    permissions: {
      default: 'denied',
      entries: input.permissions ?? {
        [MCP_PERMISSION_IDS.read]: 'granted',
        [MCP_PERMISSION_IDS.mutate]: 'granted'
      }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'axis-mcp-host', ids: input.capabilities === false ? [] : [MCP_CAPABILITY_IDS.invoke] }]
    }),
    resources: [{ kind: 'mcp', id: serverId, scope: 'project', companyId, projectId }]
  };
}

class ToolCallingAdapter implements AgentProviderAdapter {
  readonly capabilities = { streaming: true, toolProtocol: 'native' } as const;
  private calls = 0;

  constructor(
    readonly connectionId: string,
    readonly providerFamily: string,
    readonly modelId: string,
    private readonly toolName: string,
    private readonly args: Readonly<Record<string, unknown>> = {}
  ) {}

  async invoke(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        toolCalls: [{ id: 'mcp-call-1', name: this.toolName, arguments: this.args }],
        stopReason: 'tool_calls'
      };
    }
    assert.ok(request.messages.some((message) => message.role === 'tool'));
    return { text: 'done', toolCalls: [], stopReason: 'complete' };
  }
}

test('MCP discovery exposes canonical Axis tools/resources and invokes through source-owned auth independent from inference', async () => {
  const client = new FakeClient(
    [{
      name: 'events.list',
      description: 'List calendar events',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      annotations: { readOnlyHint: true }
    }],
    [{ uri: 'calendar://primary', name: 'Primary calendar' }],
    async (_name, _args, options) => {
      options.onProgress?.({ message: 'Fetching calendar', progress: 1, total: 1 });
      return { structuredContent: { events: [{ id: 'evt-1' }] } };
    }
  );
  const factory = new FakeFactory({ calendar: client });
  const catalog = new McpServerCatalog([server()], {
    companyIdFor(connectionId) {
      return connectionId === 'connection-claude-source' ? 'acme' : undefined;
    }
  });
  const host = new McpHost({ catalog, clients: factory });
  const scope = session({ connectionId: 'connection-openai-inference', providerFamily: 'openai' });
  const discovered = await host.discover(scope, new AbortController().signal);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.tools[0]?.name, 'events.list');
  assert.equal(discovered[0]?.resources[0]?.uri, 'calendar://primary');

  const [tool] = await host.toolsForSession(scope, new AbortController().signal);
  assert.ok(tool);
  assert.deepEqual(tool.definition.requiredCapabilities, [MCP_CAPABILITY_IDS.invoke]);
  assert.deepEqual(tool.definition.requiredPermissions, [MCP_PERMISSION_IDS.read]);
  assert.equal(tool.definition.effect, 'external');
  assert.equal(tool.definition.mutationRisk, 'none');

  const progress: string[] = [];
  const activities: string[] = [];
  const output = await tool.execute({
    session: scope,
    call: { id: 'call-1', name: tool.definition.name, arguments: { limit: 5 } },
    signal: new AbortController().signal,
    reportProgress(update) { progress.push(update.message); },
    reportActivity(activity) { activities.push(activity.kind); }
  });
  assert.deepEqual(output.output, { events: [{ id: 'evt-1' }] });
  assert.equal(output.mutationStatus, 'not-applicable');
  assert.equal(output.metadata?.sourceConnectionId, 'connection-claude-source');
  assert.equal(output.metadata?.sourceAuthIndependentFromInference, true);
  assert.deepEqual(progress, ['Fetching calendar']);
  assert.deepEqual(activities, ['read']);
  assert.deepEqual(factory.opened, [{
    serverId: 'calendar',
    inferenceConnectionId: 'connection-openai-inference',
    sourceConnectionId: 'connection-claude-source'
  }]);
});

test('MCP catalog fails closed on Company and source Connection ownership boundaries', () => {
  assert.throws(() => new McpServerCatalog([server({
    source: {
      id: 'foreign-source',
      kind: 'connection',
      companyId: 'other-company',
      connectionId: 'foreign-connection'
    }
  })]), /belongs to Company/i);

  assert.throws(() => new McpServerCatalog([server()], {
    companyIdFor() { return 'other-company'; }
  }), /not owned by Company acme/i);

  const catalog = new McpServerCatalog([server()]);
  assert.deepEqual(catalog.listForSession(session({ companyId: 'other', serverId: 'calendar' })), []);
});

test('sensitive MCP config is reference-only while benign literals remain allowed', () => {
  assert.throws(() => new McpServerCatalog([server({
    transport: {
      kind: 'streamable-http',
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: { kind: 'literal', value: 'Bearer do-not-store-me' } }
    }
  })]), /secret reference/i);

  const catalog = new McpServerCatalog([server({
    transport: {
      kind: 'streamable-http',
      url: 'https://mcp.example.test/mcp',
      headers: {
        Authorization: { kind: 'secret-ref', ref: 'vault://connections/calendar/token' },
        'x-client-name': { kind: 'literal', value: 'Axis' }
      }
    }
  })]);
  assert.equal(catalog.require('calendar').transport.kind, 'streamable-http');
});

test('runtime refuses an MCP AxisTool when axis.mcp.invoke is unavailable', async () => {
  const client = new FakeClient([{ name: 'events.list', annotations: { readOnlyHint: true } }]);
  const host = new McpHost({ catalog: new McpServerCatalog([server()]), clients: new FakeFactory({ calendar: client }) });
  const unauthorized = session({ capabilities: false });
  const [tool] = await host.toolsForSession(unauthorized, new AbortController().signal);
  assert.ok(tool);
  const provider = new ToolCallingAdapter(
    unauthorized.connection.id,
    unauthorized.connection.providerFamily,
    unauthorized.modelId,
    tool.definition.name
  );
  const result = await new AgentRuntime({ tools: [tool] }).run({
    context: unauthorized,
    provider,
    userInput: 'List events.'
  });
  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'capability');
  assert.equal(result.toolResults[0]?.error?.code, 'capability_unavailable');
  assert.equal(client.calls.length, 0);
});

test('mutating MCP calls emit common lifecycle activity and report committed/unknown mutation states safely', async () => {
  let fail = false;
  const client = new FakeClient(
    [{ name: 'ticket.update', annotations: { readOnlyHint: false, destructiveHint: true } }],
    [],
    async () => fail
      ? { isError: true, content: [{ type: 'text', text: 'remote mutation failed' }] }
      : { structuredContent: { updated: true } }
  );
  const scope = session();
  const host = new McpHost({ catalog: new McpServerCatalog([server()]), clients: new FakeFactory({ calendar: client }) });
  const [tool] = await host.toolsForSession(scope, new AbortController().signal);
  assert.ok(tool);
  assert.equal(tool.definition.mutationRisk, 'definite');
  assert.deepEqual(tool.definition.requiredPermissions, [MCP_PERMISSION_IDS.mutate]);

  const lifecycle: AgentLifecycleEvent[] = [];
  const successProvider = new ToolCallingAdapter(scope.connection.id, scope.connection.providerFamily, scope.modelId, tool.definition.name, { id: 'T-1' });
  const success = await new AgentRuntime({ tools: [tool], lifecycle: [(event) => lifecycle.push(event)] }).run({
    context: scope,
    provider: successProvider,
    userInput: 'Update ticket.'
  });
  assert.equal(success.toolResults[0]?.status, 'success');
  assert.equal(success.toolResults[0]?.mutationStatus, 'committed');
  assert.ok(lifecycle.some((event) => event.type === 'tool.call'));
  assert.ok(lifecycle.some((event) => event.type === 'mutation'));
  assert.ok(lifecycle.some((event) => event.type === 'tool.result'));

  fail = true;
  const failureProvider = new ToolCallingAdapter(scope.connection.id, scope.connection.providerFamily, scope.modelId, tool.definition.name, { id: 'T-2' });
  const failure = await new AgentRuntime({ tools: [tool] }).run({
    context: scope,
    provider: failureProvider,
    userInput: 'Update another ticket.'
  });
  assert.equal(failure.toolResults[0]?.status, 'error');
  assert.equal(failure.toolResults[0]?.mutationStatus, 'unknown');
  assert.match(failure.toolResults[0]?.error?.message ?? '', /remote mutation failed/i);
});

test('timeout and caller cancellation propagate without hidden retries', async () => {
  const hanging = new FakeClient(
    [{ name: 'slow.read', annotations: { readOnlyHint: true } }],
    [],
    async (_name, _args, options) => await new Promise<McpCallToolResult>((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error('cancelled by signal');
        error.name = 'AbortError';
        reject(error);
      };
      if (options.signal.aborted) rejectAbort();
      else options.signal.addEventListener('abort', rejectAbort, { once: true });
    })
  );
  const scope = session();
  const host = new McpHost({
    catalog: new McpServerCatalog([server({ timeoutMs: 20 })]),
    clients: new FakeFactory({ calendar: hanging })
  });
  const [tool] = await host.toolsForSession(scope, new AbortController().signal);
  assert.ok(tool);

  const timeoutProvider = new ToolCallingAdapter(scope.connection.id, scope.connection.providerFamily, scope.modelId, tool.definition.name);
  const timedOut = await new AgentRuntime({ tools: [tool] }).run({
    context: scope,
    provider: timeoutProvider,
    userInput: 'Read slowly.'
  });
  assert.equal(timedOut.toolResults[0]?.error?.kind, 'timeout');
  assert.equal(timedOut.toolResults[0]?.error?.code, 'tool_timeout');

  const controller = new AbortController();
  const cancelProvider = new ToolCallingAdapter(scope.connection.id, scope.connection.providerFamily, scope.modelId, tool.definition.name);
  const pending = new AgentRuntime({ tools: [tool] }).run({
    context: scope,
    provider: cancelProvider,
    userInput: 'Read slowly then cancel.',
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 5);
  const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.toolResults[0]?.status, 'cancelled');
});

test('MCP protocol errors map to canonical Axis tool errors with mutation-safe retry policy', () => {
  const mapped = canonicalMcpToolError(
    new McpHostError('protocol', 'mcp_rpc_error', 'Remote MCP rejected the request.', 'safe', { rpcCode: -32602 }),
    'possible'
  );
  assert.deepEqual(mapped, {
    kind: 'protocol',
    code: 'mcp_rpc_error',
    message: 'Remote MCP rejected the request.',
    retry: 'after-confirmation',
    details: { rpcCode: -32602 }
  });
});
