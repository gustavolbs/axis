import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OperationCancelledError } from '../src/cancellation.js';
import {
  AgentRuntime,
  InferenceProviderAgentAdapter,
  LocalAgentExecutionTarget,
  negotiateEffectiveCapabilities,
  type AgentLifecycleEvent,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentRunInput,
  type AgentSessionContext,
  type AxisTool
} from '../src/agent-runtime/index.js';
import type {
  InferenceProvider,
  ProviderCapabilities
} from '../src/providers/types.js';

const providerCapabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: false,
  toolUse: true
};

function context(input: {
  companyId?: string;
  connectionId?: string;
  connectionCompanyId?: string | null;
  providerFamily?: string;
  authKind?: AgentSessionContext['connection']['authKind'];
  capabilities?: string[];
  permissions?: Record<string, 'granted' | 'denied' | 'ask'>;
  targetId?: string;
} = {}): AgentSessionContext {
  const companyId = input.companyId ?? 'acme';
  return {
    sessionId: `session-${companyId}-${input.connectionId ?? 'primary'}`,
    companyId,
    project: { id: `project-${companyId}`, companyId },
    connection: {
      id: input.connectionId ?? 'connection-primary',
      providerFamily: input.providerFamily ?? 'openai',
      authKind: input.authKind ?? 'api-key',
      companyId: input.connectionCompanyId === undefined ? companyId : input.connectionCompanyId
    },
    modelId: 'model-test',
    executionTarget: { id: input.targetId ?? 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [{
      id: 'workspace',
      path: `/workspace/${companyId}`,
      access: 'write',
      companyId,
      projectId: `project-${companyId}`
    }],
    permissions: {
      default: 'denied',
      entries: input.permissions ?? { 'workspace.read': 'granted', 'workspace.write': 'granted' }
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'axis-test', ids: input.capabilities ?? ['axis.test.read'] }]
    }),
    resources: []
  };
}

const probeTool: AxisTool = {
  definition: {
    name: 'probe_context',
    description: 'Return the exact immutable session scope received by the tool.',
    inputSchema: { type: 'object', additionalProperties: true },
    requiredCapabilities: ['axis.test.read'],
    requiredPermissions: ['workspace.read'],
    effect: 'read',
    mutationRisk: 'none',
    retryOnFailure: 'safe'
  },
  async execute(execution) {
    return {
      output: {
        companyId: execution.session.companyId,
        projectId: execution.session.project?.id,
        connectionId: execution.session.connection.id,
        authKind: execution.session.connection.authKind,
        arguments: execution.call.arguments
      }
    };
  }
};

abstract class ScriptedAdapterBase implements AgentProviderAdapter {
  readonly capabilities;
  readonly requests: AgentProviderRequest[] = [];

  constructor(
    readonly connectionId: string,
    readonly providerFamily: string,
    readonly modelId: string,
    toolProtocol: 'native' | 'structured-fallback'
  ) {
    this.capabilities = { streaming: true, toolProtocol } as const;
  }

  async invoke(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    this.requests.push(request);
    const toolResult = request.messages.findLast((message) => message.role === 'tool');
    if (!toolResult) {
      return {
        toolCalls: [{ id: `${this.providerFamily}-probe`, name: 'probe_context', arguments: { provider: this.providerFamily } }],
        stopReason: 'tool_calls'
      };
    }
    return {
      text: `${this.providerFamily}:done`,
      toolCalls: [],
      stopReason: 'complete'
    };
  }
}

class NativeScriptedAdapter extends ScriptedAdapterBase {
  constructor(connectionId: string, providerFamily: string, modelId: string) {
    super(connectionId, providerFamily, modelId, 'native');
  }
}

class StructuredScriptedAdapter extends ScriptedAdapterBase {
  constructor(connectionId: string, providerFamily: string, modelId: string) {
    super(connectionId, providerFamily, modelId, 'structured-fallback');
  }
}

function runInput(
  session: AgentSessionContext,
  provider: AgentProviderAdapter,
  extra: Partial<AgentRunInput> = {}
): AgentRunInput {
  return {
    context: session,
    provider,
    userInput: 'Inspect the current project context.',
    systemPrompt: 'Follow the Axis runtime protocol.',
    ...extra
  };
}

test('different provider adapters use the same canonical runtime and tool contract', async () => {
  const runtime = new AgentRuntime({ tools: [probeTool] });
  const openaiContext = context({ connectionId: 'openai-account', providerFamily: 'openai', authKind: 'chatgpt-account' });
  const anthropicContext = context({ connectionId: 'claude-api', providerFamily: 'anthropic', authKind: 'api-key' });
  const openai = new NativeScriptedAdapter('openai-account', 'openai', 'model-test');
  const anthropic = new StructuredScriptedAdapter('claude-api', 'anthropic', 'model-test');

  const first = await runtime.run(runInput(openaiContext, openai, { requireToolUse: true }));
  const second = await runtime.run(runInput(anthropicContext, anthropic, { requireToolUse: true }));

  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(first.toolResults[0]?.toolName, 'probe_context');
  assert.equal(second.toolResults[0]?.toolName, 'probe_context');
  assert.equal((first.toolResults[0]?.output as { authKind: string }).authKind, 'chatgpt-account');
  assert.equal((second.toolResults[0]?.output as { authKind: string }).authKind, 'api-key');
  assert.equal(openai.requests[0]?.tools[0]?.name, 'probe_context');
  assert.equal(anthropic.requests[0]?.tools[0]?.name, 'probe_context');
});

test('Account and API key auth kinds use the same InferenceProvider adapter architecture', async () => {
  function fakeProvider(): InferenceProvider {
    return {
      id: 'openai',
      kind: 'cloud',
      capabilities: providerCapabilities,
      async listModels() { return [{ providerId: 'openai', id: 'model-test', displayName: 'Test' }]; },
      async health() { return { providerId: 'openai', ok: true, checkedAt: new Date(0).toISOString(), latencyMs: 0 }; },
      async invoke(request) {
        const hasToolResult = request.userPrompt.includes('"role":"tool"');
        return {
          providerId: 'openai',
          model: request.model,
          content: hasToolResult
            ? JSON.stringify({ complete: true, text: 'done', toolCalls: [] })
            : JSON.stringify({ complete: false, toolCalls: [{ name: 'probe_context', arguments: {} }] }),
          latencyMs: 0,
          usage: {}
        };
      }
    };
  }

  const runtime = new AgentRuntime({ tools: [probeTool] });
  for (const authKind of ['chatgpt-account', 'api-key'] as const) {
    const connectionId = `openai-${authKind}`;
    const session = context({ connectionId, providerFamily: 'openai', authKind });
    const adapter = new InferenceProviderAgentAdapter(fakeProvider(), {
      connectionId,
      providerFamily: 'openai',
      modelId: 'model-test'
    });
    const result = await runtime.run(runInput(session, adapter, { requireToolUse: true }));
    assert.equal(result.status, 'completed');
    assert.equal((result.toolResults[0]?.output as { authKind: string }).authKind, authKind);
  }
});

test('session context rejects cross-Company Project, connection, roots and resources before execution', async () => {
  const runtime = new AgentRuntime({ tools: [probeTool] });
  const companyA = context({ companyId: 'company-a', connectionId: 'connection-a' });
  const companyB = context({ companyId: 'company-b', connectionId: 'connection-b' });
  const adapterA = new NativeScriptedAdapter('connection-a', 'openai', 'model-test');
  const adapterB = new NativeScriptedAdapter('connection-b', 'openai', 'model-test');

  const resultA = await runtime.run(runInput(companyA, adapterA));
  const resultB = await runtime.run(runInput(companyB, adapterB));
  assert.equal((resultA.toolResults[0]?.output as { companyId: string }).companyId, 'company-a');
  assert.equal((resultB.toolResults[0]?.output as { companyId: string }).companyId, 'company-b');

  const mixed = context({
    companyId: 'company-a',
    connectionId: 'connection-b',
    connectionCompanyId: 'company-b'
  });
  await assert.rejects(
    () => runtime.run(runInput(mixed, new NativeScriptedAdapter('connection-b', 'openai', 'model-test'))),
    /belongs to Company company-b, not session Company company-a/
  );
});

test('capability negotiation hides unavailable tools and rejects hallucinated calls explicitly', async () => {
  const events: AgentLifecycleEvent[] = [];
  const runtime = new AgentRuntime({ tools: [probeTool], lifecycle: [(event) => events.push(event)] });
  const session = context({ capabilities: [] });
  const adapter = new NativeScriptedAdapter('connection-primary', 'openai', 'model-test');

  const result = await runtime.run(runInput(session, adapter));
  assert.equal(result.status, 'completed');
  assert.equal(adapter.requests[0]?.tools.length, 0);
  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'capability');
  assert.equal(result.toolResults[0]?.error?.code, 'capability_unavailable');
  assert.ok(events.some((event) => event.type === 'tool.result'));

  const required = await runtime.run(runInput(session, new NativeScriptedAdapter('connection-primary', 'openai', 'model-test'), {
    requiredCapabilities: ['axis.test.read']
  }));
  assert.equal(required.status, 'failed');
  assert.equal(required.error?.kind, 'capability');
  assert.equal(required.error?.code, 'capability_unavailable');
});

test('runtime lifecycle is provider-independent and exposes Project Memory observation points', async () => {
  async function eventTypes(provider: AgentProviderAdapter, session: AgentSessionContext): Promise<string[]> {
    const events: AgentLifecycleEvent[] = [];
    const runtime = new AgentRuntime({ tools: [probeTool], lifecycle: [(event) => events.push(event)] });
    const result = await runtime.run(runInput(session, provider));
    assert.equal(result.status, 'completed');
    return events.map((event) => event.type);
  }

  const nativeTypes = await eventTypes(
    new NativeScriptedAdapter('native-connection', 'openai', 'model-test'),
    context({ connectionId: 'native-connection', providerFamily: 'openai' })
  );
  const structuredTypes = await eventTypes(
    new StructuredScriptedAdapter('structured-connection', 'anthropic', 'model-test'),
    context({ connectionId: 'structured-connection', providerFamily: 'anthropic' })
  );
  const required = [
    'session.started', 'turn.started', 'user.input', 'provider.started', 'provider.completed',
    'tool.call', 'permission.requested', 'permission.resolved', 'tool.result', 'read',
    'turn.completed', 'session.completed'
  ];
  for (const type of required) {
    assert.ok(nativeTypes.includes(type), `native adapter missing lifecycle event ${type}`);
    assert.ok(structuredTypes.includes(type), `structured adapter missing lifecycle event ${type}`);
  }
});

test('cancellation is canonical across provider/tool execution', async () => {
  const controller = new AbortController();
  const cancellingTool: AxisTool = {
    definition: {
      name: 'probe_context',
      description: 'Cancel while a canonical tool call is active.',
      inputSchema: { type: 'object' },
      requiredCapabilities: ['axis.test.read'],
      requiredPermissions: ['workspace.read'],
      effect: 'command',
      mutationRisk: 'possible',
      retryOnFailure: 'after-confirmation'
    },
    async execute(execution) {
      controller.abort();
      if (execution.signal.aborted) throw new OperationCancelledError('cancelled by test');
      return {};
    }
  };
  const events: AgentLifecycleEvent[] = [];
  const runtime = new AgentRuntime({ tools: [cancellingTool], lifecycle: [(event) => events.push(event)] });
  const session = context();
  const result = await runtime.run(runInput(
    session,
    new NativeScriptedAdapter('connection-primary', 'openai', 'model-test'),
    { signal: controller.signal }
  ));

  assert.equal(result.status, 'cancelled');
  assert.equal(result.toolResults[0]?.status, 'cancelled');
  assert.equal(result.toolResults[0]?.mutationStatus, 'unknown');
  assert.ok(events.some((event) => event.type === 'cancelled' && event.source === 'tool'));
  assert.ok(events.some((event) => event.type === 'session.completed' && event.status === 'cancelled'));
});

test('tool timeout and mutation failure keep retry safety explicit', async () => {
  const unsafeTool: AxisTool = {
    definition: {
      name: 'probe_context',
      description: 'A potentially mutating operation that waits for cancellation.',
      inputSchema: { type: 'object' },
      requiredCapabilities: ['axis.test.read'],
      requiredPermissions: ['workspace.write'],
      effect: 'mutation',
      mutationRisk: 'definite',
      retryOnFailure: 'after-confirmation',
      timeoutMs: 5
    },
    async execute(execution) {
      await new Promise<never>((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(new OperationCancelledError('timed out')), { once: true });
      });
    }
  };
  const runtime = new AgentRuntime({
    tools: [unsafeTool],
    executionTargets: [new LocalAgentExecutionTarget('desktop')]
  });
  const result = await runtime.run(runInput(
    context(),
    new NativeScriptedAdapter('connection-primary', 'openai', 'model-test')
  ));

  assert.equal(result.status, 'completed');
  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'timeout');
  assert.equal(result.toolResults[0]?.error?.retry, 'after-confirmation');
  assert.equal(result.toolResults[0]?.mutationStatus, 'unknown');
});

test('runtime never falls back to a different provider, model or execution target', async () => {
  const runtime = new AgentRuntime({ tools: [probeTool] });
  const wrongProvider = await runtime.run(runInput(
    context({ connectionId: 'selected' }),
    new NativeScriptedAdapter('other', 'openai', 'model-test')
  ));
  assert.equal(wrongProvider.status, 'failed');
  assert.equal(wrongProvider.error?.code, 'provider_selection_mismatch');

  const missingTarget = await runtime.run(runInput(
    context({ targetId: 'worker-not-registered' }),
    new NativeScriptedAdapter('connection-primary', 'openai', 'model-test')
  ));
  assert.equal(missingTarget.status, 'failed');
  assert.equal(missingTarget.error?.code, 'execution_target_unavailable');
  assert.match(missingTarget.error?.message ?? '', /will not silently fall back/);
});
