import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { OperationCancelledError } from '../src/cancellation.js';
import {
  AgentRuntime,
  ToolRegistry,
  negotiateEffectiveCapabilities,
  type AgentLifecycleEvent,
  type AgentProviderAdapter,
  type AgentProviderRequest,
  type AgentProviderResponse,
  type AgentSessionContext,
  type ToolCall,
  type ToolExecutionContext
} from '../src/agent-runtime/index.js';
import {
  AXIS_BROWSER_CAPABILITY_IDS,
  AXIS_BROWSER_PERMISSION_IDS,
  AXIS_BROWSER_TOOL_NAMES,
  BrowserSessionManager,
  FetchBrowserBackend,
  createBrowserToolset,
  type BrowserBackend,
  type BrowserBackendSession,
  type BrowserInteractRequest,
  type BrowserNavigationResult,
  type BrowserOperationContext,
  type BrowserReadResult,
  type BrowserSessionScope
} from '../src/agent-tools/browser/index.js';

const allBrowserCapabilities = Object.values(AXIS_BROWSER_CAPABILITY_IDS);
const allBrowserPermissions = Object.fromEntries(
  Object.values(AXIS_BROWSER_PERMISSION_IDS).map((permission) => [permission, 'granted' as const])
);

function session(input: {
  companyId?: string;
  sessionId?: string;
  providerFamily?: string;
  connectionId?: string;
  capabilities?: string[];
  permissions?: Record<string, 'granted' | 'denied' | 'ask'>;
} = {}): AgentSessionContext {
  const companyId = input.companyId ?? 'company-a';
  return {
    sessionId: input.sessionId ?? `session-${companyId}`,
    companyId,
    project: { id: `project-${companyId}`, companyId },
    connection: {
      id: input.connectionId ?? `connection-${companyId}`,
      providerFamily: input.providerFamily ?? 'openai',
      authKind: 'api-key',
      companyId
    },
    modelId: 'model-test',
    executionTarget: { id: 'desktop', kind: 'desktop', mode: 'workspace' },
    roots: [],
    permissions: {
      default: 'denied',
      entries: input.permissions ?? allBrowserPermissions
    },
    capabilities: negotiateEffectiveCapabilities({
      offers: [{ source: 'browser-test', ids: input.capabilities ?? allBrowserCapabilities }]
    }),
    resources: []
  };
}

interface ScriptedCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

class SequenceAdapter implements AgentProviderAdapter {
  readonly capabilities = { streaming: false, toolProtocol: 'native' } as const;

  constructor(
    readonly connectionId: string,
    readonly providerFamily: string,
    readonly modelId: string,
    private readonly calls: readonly ScriptedCall[]
  ) {}

  async invoke(request: AgentProviderRequest): Promise<AgentProviderResponse> {
    const completedCalls = request.messages.filter((message) => message.role === 'tool').length;
    const next = this.calls[completedCalls];
    if (next) {
      return {
        toolCalls: [{
          id: `browser-call-${completedCalls + 1}`,
          name: next.name,
          arguments: next.arguments
        }],
        stopReason: 'tool_calls'
      };
    }
    return { text: 'done', toolCalls: [], stopReason: 'complete' };
  }
}

function adapterFor(axisSession: AgentSessionContext, calls: readonly ScriptedCall[]): SequenceAdapter {
  return new SequenceAdapter(
    axisSession.connection.id,
    axisSession.connection.providerFamily,
    axisSession.modelId,
    calls
  );
}

async function waitForAbort(signal: AbortSignal, message: string): Promise<never> {
  if (signal.aborted) throw new OperationCancelledError(message);
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new OperationCancelledError(message)),
      { once: true }
    );
  });
}

class MockBrowserBackend implements BrowserBackend {
  readonly id = 'mock-browser';
  readonly openedScopes: BrowserSessionScope[] = [];
  navigateCalls = 0;
  readCalls = 0;
  interactCalls = 0;
  navigationError?: Error;
  waitOnNavigate = false;
  waitOnRead = false;
  readonly readStarted: Promise<void>;
  private resolveReadStarted!: () => void;

  constructor(readonly interactive = true) {
    this.readStarted = new Promise<void>((resolve) => {
      this.resolveReadStarted = resolve;
    });
  }

  async openSession(
    scope: BrowserSessionScope,
    _context: BrowserOperationContext
  ): Promise<BrowserBackendSession> {
    this.openedScopes.push(scope);
    let currentUrl = 'https://example.test/initial';
    const backend = this;
    const interaction = this.interactive
      ? {
          async interact(request: BrowserInteractRequest) {
            backend.interactCalls += 1;
            return {
              action: request.action,
              url: currentUrl,
              detail: request.selector,
              mutationStatus: 'unknown' as const
            };
          }
        }
      : {};
    return {
      id: `browser-${scope.sessionId}`,
      scope,
      async navigate(request, context): Promise<BrowserNavigationResult> {
        backend.navigateCalls += 1;
        if (backend.navigationError) throw backend.navigationError;
        if (backend.waitOnNavigate) {
          return await waitForAbort(context.signal, 'mock navigation cancelled');
        }
        currentUrl = request.url;
        return {
          requestedUrl: request.url,
          url: request.url,
          status: 200,
          title: 'Example',
          contentType: 'text/html'
        };
      },
      async read(request, context): Promise<BrowserReadResult> {
        backend.readCalls += 1;
        backend.resolveReadStarted();
        if (backend.waitOnRead) {
          return await waitForAbort(context.signal, 'mock read cancelled');
        }
        return {
          url: currentUrl,
          title: 'Example',
          status: 200,
          contentType: 'text/html',
          format: request.format,
          ...(request.format === 'links'
            ? { links: [{ text: 'Docs', href: 'https://example.test/docs' }] }
            : request.format === 'extract'
              ? { matches: ['matching excerpt'] }
              : { content: 'Example page body' }),
          truncated: false
        };
      },
      ...interaction
    };
  }
}

function toolExecutionContext(
  axisSession: AgentSessionContext,
  call: ToolCall,
  signal = new AbortController().signal
): ToolExecutionContext {
  return {
    session: axisSession,
    call,
    signal,
    reportProgress: () => undefined,
    reportActivity: () => undefined
  };
}

test('browser tools register in ToolRegistry without runtime or provider changes and read a navigated page', async () => {
  const backend = new MockBrowserBackend();
  const toolset = createBrowserToolset({ backend });
  const registry = new ToolRegistry(toolset.tools);
  assert.deepEqual(
    registry.list().map((tool) => tool.definition.name),
    [AXIS_BROWSER_TOOL_NAMES.interact, AXIS_BROWSER_TOOL_NAMES.navigate, AXIS_BROWSER_TOOL_NAMES.read]
  );

  const events: AgentLifecycleEvent[] = [];
  const runtime = new AgentRuntime({
    tools: toolset.tools,
    lifecycle: [(event) => events.push(event)]
  });
  const axisSession = session();
  const result = await runtime.run({
    context: axisSession,
    provider: adapterFor(axisSession, [
      { name: AXIS_BROWSER_TOOL_NAMES.navigate, arguments: { url: 'https://example.test/docs' } },
      { name: AXIS_BROWSER_TOOL_NAMES.read, arguments: { format: 'text' } }
    ]),
    userInput: 'Read the docs page.'
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.toolResults.length, 2);
  assert.equal(result.toolResults[0]?.status, 'success');
  assert.equal(result.toolResults[1]?.status, 'success');
  assert.equal((result.toolResults[1]?.output as BrowserReadResult).content, 'Example page body');
  assert.equal(backend.openedScopes.length, 1, 'navigate/read must share one Axis-session browser');
  assert.ok(events.some((event) => event.type === 'read' && event.toolName === AXIS_BROWSER_TOOL_NAMES.read));
});

test('fetch backend performs explicit navigation, text/link extraction, and bounded search without Computer Use', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/missing') {
      response.statusCode = 503;
      response.end('unavailable');
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
      <html><head><title>Docs &amp; Guide</title><style>.hidden{display:none}</style></head>
      <body><h1>Axis Browser</h1><p>Needle alpha content.</p>
      <a href="/next">Next page</a><script>doNotExpose()</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const operation: BrowserOperationContext = {
    signal: new AbortController().signal,
    reportProgress: () => undefined
  };
  const manager = new BrowserSessionManager(new FetchBrowserBackend({ maxResponseBytes: 20_000 }));
  const browser = await manager.getOrCreate(session({ sessionId: 'fetch-session' }), operation);

  const navigation = await browser.navigate({ url: `${origin}/page` }, operation);
  assert.equal(navigation.status, 200);
  assert.equal(navigation.title, 'Docs & Guide');

  const text = await browser.read({ format: 'text', maxChars: 1_000, maxMatches: 10 }, operation);
  assert.match(text.content ?? '', /Axis Browser/);
  assert.match(text.content ?? '', /Needle alpha content/);
  assert.doesNotMatch(text.content ?? '', /doNotExpose/);

  const links = await browser.read({ format: 'links', maxChars: 1_000, maxMatches: 10 }, operation);
  assert.deepEqual(links.links, [{ text: 'Next page', href: `${origin}/next` }]);

  const extracted = await browser.read({
    format: 'extract',
    query: 'needle alpha',
    maxChars: 500,
    maxMatches: 5
  }, operation);
  assert.equal(extracted.matches?.length, 1);
  assert.match(extracted.matches?.[0] ?? '', /Needle alpha content/);

  await assert.rejects(
    () => browser.navigate({ url: `${origin}/missing` }, operation),
    /failed with HTTP 503/
  );
  await assert.rejects(
    () => browser.navigate({ url: 'file:///tmp/secret' }, operation),
    /only supports http\/https URLs/
  );

  const emptyBrowser = await manager.getOrCreate(
    session({ sessionId: 'fetch-empty-session' }),
    operation
  );
  await assert.rejects(
    () => emptyBrowser.read({ format: 'text', maxChars: 100, maxMatches: 5 }, operation),
    /Navigate explicitly before reading/
  );
  await manager.closeAll();
});

test('navigation failure is explicit and does not switch browser backend', async () => {
  const backend = new MockBrowserBackend();
  backend.navigationError = new Error('navigation failed: DNS lookup');
  const toolset = createBrowserToolset({ backend });
  const runtime = new AgentRuntime({ tools: toolset.tools });
  const axisSession = session();
  const result = await runtime.run({
    context: axisSession,
    provider: adapterFor(axisSession, [
      { name: AXIS_BROWSER_TOOL_NAMES.navigate, arguments: { url: 'https://unreachable.test' } }
    ]),
    userInput: 'Open the page.'
  });

  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'tool');
  assert.match(result.toolResults[0]?.error?.message ?? '', /navigation failed: DNS lookup/);
  assert.equal(backend.openedScopes.length, 1);
  assert.equal(toolset.sessions.backend.id, 'mock-browser');
});

test('external navigation permission is checked before a browser session or request starts', async () => {
  const backend = new MockBrowserBackend();
  const toolset = createBrowserToolset({ backend });
  const runtime = new AgentRuntime({ tools: toolset.tools });
  const axisSession = session({
    permissions: {
      ...allBrowserPermissions,
      [AXIS_BROWSER_PERMISSION_IDS.external]: 'denied'
    }
  });
  const result = await runtime.run({
    context: axisSession,
    provider: adapterFor(axisSession, [
      { name: AXIS_BROWSER_TOOL_NAMES.navigate, arguments: { url: 'https://example.test' } }
    ]),
    userInput: 'Open the external page.'
  });

  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'permission');
  assert.equal(backend.openedScopes.length, 0);
  assert.equal(backend.navigateCalls, 0);
});

test('browser navigation timeout aborts the active backend operation canonically', async () => {
  const backend = new MockBrowserBackend();
  backend.waitOnNavigate = true;
  const toolset = createBrowserToolset({ backend, navigateTimeoutMs: 5 });
  const runtime = new AgentRuntime({ tools: toolset.tools });
  const axisSession = session();
  const result = await runtime.run({
    context: axisSession,
    provider: adapterFor(axisSession, [
      { name: AXIS_BROWSER_TOOL_NAMES.navigate, arguments: { url: 'https://slow.test' } }
    ]),
    userInput: 'Open the slow page.'
  });

  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'timeout');
  assert.equal(result.toolResults[0]?.error?.code, 'tool_timeout');
  assert.equal(result.toolResults[0]?.mutationStatus, 'not-applicable');
});

test('caller cancellation interrupts an active browser read', async () => {
  const backend = new MockBrowserBackend();
  backend.waitOnRead = true;
  const toolset = createBrowserToolset({ backend });
  const runtime = new AgentRuntime({ tools: toolset.tools });
  const axisSession = session();
  const controller = new AbortController();
  const running = runtime.run({
    context: axisSession,
    provider: adapterFor(axisSession, [
      { name: AXIS_BROWSER_TOOL_NAMES.read, arguments: { format: 'text' } }
    ]),
    userInput: 'Read the current page.',
    signal: controller.signal
  });

  await backend.readStarted;
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.toolResults[0]?.status, 'cancelled');
  assert.equal(result.toolResults[0]?.error?.code, 'tool_cancelled');
});

test('browser interaction is blocked by canonical mutation permissions before backend invocation', async () => {
  const backend = new MockBrowserBackend();
  const toolset = createBrowserToolset({ backend });
  const runtime = new AgentRuntime({ tools: toolset.tools });
  const permissions = {
    ...allBrowserPermissions,
    [AXIS_BROWSER_PERMISSION_IDS.mutate]: 'denied' as const
  };
  const axisSession = session({ permissions });
  const result = await runtime.run({
    context: axisSession,
    provider: adapterFor(axisSession, [
      {
        name: AXIS_BROWSER_TOOL_NAMES.interact,
        arguments: { action: 'click', selector: '#submit' }
      }
    ]),
    userInput: 'Click submit.'
  });

  assert.equal(result.toolResults[0]?.status, 'error');
  assert.equal(result.toolResults[0]?.error?.kind, 'permission');
  assert.equal(backend.interactCalls, 0);
  assert.equal(result.toolResults[0]?.mutationStatus, 'unknown');
});

test('same browser tools are provider-independent and browser scope excludes provider identity', async () => {
  const backend = new MockBrowserBackend();
  const toolset = createBrowserToolset({ backend });
  const read = toolset.tools.find((tool) => tool.definition.name === AXIS_BROWSER_TOOL_NAMES.read);
  assert.ok(read);

  for (const [providerFamily, companyId] of [['openai', 'company-a'], ['anthropic', 'company-b']] as const) {
    const axisSession = session({
      companyId,
      sessionId: `session-${providerFamily}`,
      providerFamily,
      connectionId: `connection-${providerFamily}`
    });
    const output = await read.execute(toolExecutionContext(axisSession, {
      id: `read-${providerFamily}`,
      name: AXIS_BROWSER_TOOL_NAMES.read,
      arguments: { format: 'text' }
    }));
    assert.equal((output.output as BrowserReadResult).content, 'Example page body');
  }

  assert.equal(backend.openedScopes.length, 2);
  for (const scope of backend.openedScopes) {
    assert.equal('providerFamily' in scope, false);
    assert.equal('connectionId' in scope, false);
  }
});

test('browser session manager refuses cross-Company reuse for a colliding session id', async () => {
  const backend = new MockBrowserBackend();
  const manager = new BrowserSessionManager(backend);
  const operation: BrowserOperationContext = {
    signal: new AbortController().signal,
    reportProgress: () => undefined
  };
  await manager.getOrCreate(session({ companyId: 'company-a', sessionId: 'same-session' }), operation);
  await assert.rejects(
    () => manager.getOrCreate(session({ companyId: 'company-b', sessionId: 'same-session' }), operation),
    /different Company\/Project\/target context/
  );
  assert.equal(backend.openedScopes.length, 1);
});

test('read-only backend fails interaction explicitly instead of falling back to another tool or Computer Use', async () => {
  const backend = new MockBrowserBackend(false);
  const toolset = createBrowserToolset({ backend });
  const interact = toolset.tools.find((tool) => tool.definition.name === AXIS_BROWSER_TOOL_NAMES.interact);
  assert.ok(interact);
  const axisSession = session();

  await assert.rejects(
    () => interact.execute(toolExecutionContext(axisSession, {
      id: 'interact-no-backend',
      name: AXIS_BROWSER_TOOL_NAMES.interact,
      arguments: { action: 'click', selector: '#button' }
    })),
    /will not fall back to another browser backend or Computer Use/
  );
  assert.equal(backend.interactCalls, 0);
});
