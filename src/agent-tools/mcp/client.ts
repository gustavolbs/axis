import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AgentSessionContext } from '../../agent-runtime/index.js';
import type {
  McpCallToolResult,
  McpClient,
  McpClientFactory,
  McpClientFactoryOpenOptions,
  McpConfigValue,
  McpOperationOptions,
  McpProgressUpdate,
  McpResourceDescriptor,
  McpSecretResolver,
  McpServerConfig,
  McpToolDescriptor
} from './types.js';
import { McpHostError } from './types.js';

interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

type NotificationHandler = (notification: JsonRpcNotification) => void;

interface McpRpcTransport {
  setNotificationHandler(handler: NotificationHandler): void;
  start(signal: AbortSignal): Promise<void>;
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const MAX_PAGES = 100;
const MAX_STDERR = 16_384;
const BASE_ENV_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy',
  'http_proxy', 'no_proxy'
]);

function abortError(message = 'MCP operation was cancelled.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpHostError('protocol', 'mcp_invalid_response', `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).jsonrpc === '2.0' && 'id' in (value as Record<string, unknown>));
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (value as Record<string, unknown>).method === 'string' &&
    !('id' in (value as Record<string, unknown>)));
}

function unwrapResponse(response: JsonRpcResponse): unknown {
  if (response.error) {
    throw new McpHostError(
      'protocol',
      'mcp_rpc_error',
      `MCP JSON-RPC error ${response.error.code}: ${response.error.message}`,
      response.error.code === -32001 ? 'safe' : 'never',
      { rpcCode: response.error.code }
    );
  }
  return response.result;
}

function parseJsonMessage(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new McpHostError(
      'protocol',
      'mcp_invalid_json',
      `MCP returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  for (const block of text.replace(/\r/g, '').split('\n\n')) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return events;
}

async function consumeSseStream(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: { event?: string; data: string }) => void
): Promise<void> {
  if (!response.body) throw new McpHostError('transport', 'mcp_empty_sse_body', 'MCP SSE response had no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const event of parseSseEvents(`${block}\n\n`)) onEvent(event);
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

async function resolveConfigValue(
  value: McpConfigValue,
  server: McpServerConfig,
  resolver?: McpSecretResolver
): Promise<string> {
  if (value.kind === 'literal') return value.value;
  if (!resolver) {
    throw new McpHostError(
      'configuration',
      'mcp_secret_resolver_unavailable',
      `MCP server ${server.id} requires a secret resolver.`
    );
  }
  const resolved = await resolver.resolve(value.ref, {
    serverId: server.id,
    companyId: server.companyId,
    sourceConnectionId: server.source.connectionId
  });
  if (!resolved) {
    throw new McpHostError('configuration', 'mcp_secret_empty', `Secret reference for MCP server ${server.id} resolved to an empty value.`);
  }
  return resolved;
}

async function resolvedHeaders(server: McpServerConfig, resolver?: McpSecretResolver): Promise<Record<string, string>> {
  if (server.transport.kind === 'stdio') return {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.transport.headers ?? {})) {
    headers[name] = await resolveConfigValue(value, server, resolver);
  }
  return headers;
}

function requestBody(id: string | number, method: string, params: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

function notificationBody(method: string, params: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', method, params };
}

class StreamableHttpTransport implements McpRpcTransport {
  private notificationHandler: NotificationHandler = () => undefined;
  private nextId = 0;
  private sessionId?: string;

  constructor(
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>
  ) {}

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  async start(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const id = ++this.nextId;
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
      },
      body: JSON.stringify(requestBody(id, method, params)),
      signal
    });
    if (!response.ok) {
      throw new McpHostError('transport', 'mcp_http_error', `MCP server returned HTTP ${response.status}.`, response.status >= 500 ? 'safe' : 'never', { status: response.status });
    }
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    const contentType = response.headers.get('content-type') ?? '';
    const messages = contentType.includes('text/event-stream')
      ? parseSseEvents(await response.text()).map((event) => parseJsonMessage(event.data))
      : [parseJsonMessage(await response.text())];
    let match: JsonRpcResponse | undefined;
    for (const message of messages) {
      if (isJsonRpcNotification(message)) this.notificationHandler(message);
      if (isJsonRpcResponse(message) && message.id === id) match = message;
    }
    if (!match) throw new McpHostError('protocol', 'mcp_missing_response', `MCP server did not return a JSON-RPC response for ${method}.`);
    return unwrapResponse(match);
  }

  async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
      },
      body: JSON.stringify(notificationBody(method, params)),
      signal
    });
    if (!response.ok && response.status !== 202) {
      throw new McpHostError('transport', 'mcp_http_error', `MCP notification returned HTTP ${response.status}.`);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: { ...this.headers, 'mcp-session-id': this.sessionId }
      });
    } catch {
      // Closing is best-effort. The server may not implement session deletion.
    }
  }
}

interface PendingRpc {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

class StdioTransport implements McpRpcTransport {
  private notificationHandler: NotificationHandler = () => undefined;
  private nextId = 0;
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRpc>();
  private stdoutBuffer = '';
  private stderr = '';

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly cwd: string | undefined,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  async start(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.process) return;
    const child = spawn(this.command, [...this.args], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      if (this.stderr.length < MAX_STDERR) this.stderr = `${this.stderr}${chunk}`.slice(0, MAX_STDERR);
    });
    child.once('error', (error) => this.rejectAll(new McpHostError('transport', 'mcp_stdio_spawn_error', `Could not start MCP server ${this.command}: ${error.message}`)));
    child.once('exit', (code, processSignal) => {
      const detail = this.stderr.trim();
      this.rejectAll(new McpHostError(
        'transport',
        'mcp_stdio_exited',
        `MCP stdio server exited (${code ?? processSignal ?? 'unknown'})${detail ? `: ${detail.slice(0, 500)}` : ''}.`
      ));
      this.process = undefined;
    });
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    if (!this.process) throw new McpHostError('transport', 'mcp_stdio_not_started', 'MCP stdio transport is not started.');
    const id = ++this.nextId;
    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        void this.notify('notifications/cancelled', { requestId: id, reason: 'Axis operation cancelled' }).catch(() => undefined);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      this.pending.set(id, { resolve, reject, cleanup });
      this.write(requestBody(id, method, params)).catch((error) => {
        this.pending.delete(id);
        cleanup();
        reject(error);
      });
    });
  }

  async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    await this.write(notificationBody(method, params));
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    this.rejectAll(new McpHostError('transport', 'mcp_transport_closed', 'MCP stdio transport was closed.'));
    if (!child.killed) child.kill('SIGTERM');
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    const child = this.process;
    if (!child || child.stdin.destroyed) throw new McpHostError('transport', 'mcp_stdio_closed', 'MCP stdio input is closed.');
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => error ? reject(error) : resolve());
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.rejectAll(new McpHostError('protocol', 'mcp_invalid_json', 'MCP stdio server emitted invalid JSON.'));
        continue;
      }
      if (isJsonRpcNotification(message)) {
        this.notificationHandler(message);
        continue;
      }
      if (!isJsonRpcResponse(message) || typeof message.id !== 'number') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      pending.cleanup();
      try {
        pending.resolve(unwrapResponse(message));
      } catch (error) {
        pending.reject(error);
      }
    }
  }

  private rejectAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }
}

class LegacySseTransport implements McpRpcTransport {
  private notificationHandler: NotificationHandler = () => undefined;
  private nextId = 0;
  private endpoint?: string;
  private readonly pending = new Map<number, PendingRpc>();
  private streamAbort?: AbortController;
  private streamTask?: Promise<void>;

  constructor(
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>>
  ) {}

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.streamTask) return;
    throwIfAborted(signal);
    const controller = new AbortController();
    this.streamAbort = controller;
    const onCallerAbort = () => controller.abort();
    signal.addEventListener('abort', onCallerAbort, { once: true });
    const response = await fetch(this.url, {
      method: 'GET',
      headers: { ...this.headers, accept: 'text/event-stream' },
      signal: controller.signal
    });
    signal.removeEventListener('abort', onCallerAbort);
    if (!response.ok) throw new McpHostError('transport', 'mcp_sse_connect_error', `MCP SSE connection returned HTTP ${response.status}.`);

    let endpointResolved: (() => void) | undefined;
    let endpointRejected: ((error: unknown) => void) | undefined;
    const endpointReady = new Promise<void>((resolve, reject) => {
      endpointResolved = resolve;
      endpointRejected = reject;
    });
    this.streamTask = consumeSseStream(response, controller.signal, (event) => {
      if (event.event === 'endpoint') {
        try {
          this.endpoint = new URL(event.data, this.url).toString();
          endpointResolved?.();
        } catch (error) {
          endpointRejected?.(error);
        }
        return;
      }
      if (event.event && event.event !== 'message') return;
      const message = parseJsonMessage(event.data);
      if (isJsonRpcNotification(message)) {
        this.notificationHandler(message);
        return;
      }
      if (!isJsonRpcResponse(message) || typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      try { pending.resolve(unwrapResponse(message)); } catch (error) { pending.reject(error); }
    }).catch((error) => {
      endpointRejected?.(error);
      this.rejectAll(error);
    });

    await Promise.race([
      endpointReady,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(abortError());
        else signal.addEventListener('abort', () => reject(abortError()), { once: true });
      })
    ]);
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const endpoint = this.endpoint;
    if (!endpoint) throw new McpHostError('transport', 'mcp_sse_endpoint_missing', 'MCP SSE server did not provide a message endpoint.');
    const id = ++this.nextId;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        void this.notify('notifications/cancelled', { requestId: id, reason: 'Axis operation cancelled' }).catch(() => undefined);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      this.pending.set(id, { resolve, reject, cleanup });
    });
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...this.headers, 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(id, method, params)),
        signal
      });
      if (!response.ok && response.status !== 202) {
        throw new McpHostError('transport', 'mcp_sse_post_error', `MCP SSE request returned HTTP ${response.status}.`);
      }
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.cleanup();
        pending.reject(error);
      }
    }
    return await responsePromise;
  }

  async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfAborted(signal);
    const endpoint = this.endpoint;
    if (!endpoint) throw new McpHostError('transport', 'mcp_sse_endpoint_missing', 'MCP SSE server did not provide a message endpoint.');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify(notificationBody(method, params)),
      signal
    });
    if (!response.ok && response.status !== 202) {
      throw new McpHostError('transport', 'mcp_sse_post_error', `MCP SSE notification returned HTTP ${response.status}.`);
    }
  }

  async close(): Promise<void> {
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    this.rejectAll(new McpHostError('transport', 'mcp_transport_closed', 'MCP SSE transport was closed.'));
    try { await this.streamTask; } catch { /* already surfaced to pending calls */ }
    this.streamTask = undefined;
  }

  private rejectAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }
}

function toolDescriptor(raw: unknown): McpToolDescriptor {
  const value = jsonRecord(raw, 'MCP tool');
  const name = stringField(value, 'name');
  if (!name) throw new McpHostError('protocol', 'mcp_invalid_tool', 'MCP tool is missing a name.');
  const annotations = value.annotations && typeof value.annotations === 'object' && !Array.isArray(value.annotations)
    ? value.annotations as Record<string, unknown>
    : undefined;
  return {
    name,
    title: stringField(value, 'title'),
    description: stringField(value, 'description'),
    inputSchema: value.inputSchema && typeof value.inputSchema === 'object' && !Array.isArray(value.inputSchema)
      ? value.inputSchema as Readonly<Record<string, unknown>>
      : { type: 'object', additionalProperties: true },
    annotations: annotations ? {
      title: stringField(annotations, 'title'),
      readOnlyHint: typeof annotations.readOnlyHint === 'boolean' ? annotations.readOnlyHint : undefined,
      destructiveHint: typeof annotations.destructiveHint === 'boolean' ? annotations.destructiveHint : undefined,
      idempotentHint: typeof annotations.idempotentHint === 'boolean' ? annotations.idempotentHint : undefined,
      openWorldHint: typeof annotations.openWorldHint === 'boolean' ? annotations.openWorldHint : undefined
    } : undefined
  };
}

function resourceDescriptor(raw: unknown): McpResourceDescriptor {
  const value = jsonRecord(raw, 'MCP resource');
  const uri = stringField(value, 'uri');
  if (!uri) throw new McpHostError('protocol', 'mcp_invalid_resource', 'MCP resource is missing a URI.');
  return {
    uri,
    name: stringField(value, 'name'),
    title: stringField(value, 'title'),
    description: stringField(value, 'description'),
    mimeType: stringField(value, 'mimeType'),
    size: numberField(value, 'size')
  };
}

function progressFromNotification(notification: JsonRpcNotification): { token: string | number; progress: McpProgressUpdate } | undefined {
  if (notification.method !== 'notifications/progress') return undefined;
  const params = notification.params && typeof notification.params === 'object' && !Array.isArray(notification.params)
    ? notification.params as Record<string, unknown>
    : undefined;
  if (!params || (typeof params.progressToken !== 'string' && typeof params.progressToken !== 'number')) return undefined;
  const metadata = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)
    ? params._meta as Readonly<Record<string, unknown>>
    : undefined;
  return {
    token: params.progressToken,
    progress: {
      message: typeof params.message === 'string' ? params.message : undefined,
      progress: typeof params.progress === 'number' ? params.progress : undefined,
      total: typeof params.total === 'number' ? params.total : undefined,
      metadata
    }
  };
}

class ProtocolMcpClient implements McpClient {
  private initialized = false;
  private initializePromise?: Promise<void>;
  private readonly progressHandlers = new Map<string | number, (progress: McpProgressUpdate) => void>();

  constructor(private readonly transport: McpRpcTransport) {
    transport.setNotificationHandler((notification) => {
      const progress = progressFromNotification(notification);
      if (progress) this.progressHandlers.get(progress.token)?.(progress.progress);
    });
  }

  async listTools(options: McpOperationOptions): Promise<readonly McpToolDescriptor[]> {
    await this.initialize(options.signal);
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = jsonRecord(await this.transport.request('tools/list', cursor ? { cursor } : {}, options.signal), 'MCP tools/list result');
      const rawTools = result.tools;
      if (!Array.isArray(rawTools)) throw new McpHostError('protocol', 'mcp_invalid_tools_list', 'MCP tools/list result is missing tools.');
      tools.push(...rawTools.map(toolDescriptor));
      cursor = stringField(result, 'nextCursor');
      if (!cursor) return tools;
    }
    throw new McpHostError('protocol', 'mcp_pagination_limit', 'MCP tools/list exceeded the pagination safety limit.');
  }

  async listResources(options: McpOperationOptions): Promise<readonly McpResourceDescriptor[]> {
    await this.initialize(options.signal);
    const resources: McpResourceDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = jsonRecord(await this.transport.request('resources/list', cursor ? { cursor } : {}, options.signal), 'MCP resources/list result');
      const rawResources = result.resources;
      if (!Array.isArray(rawResources)) throw new McpHostError('protocol', 'mcp_invalid_resources_list', 'MCP resources/list result is missing resources.');
      resources.push(...rawResources.map(resourceDescriptor));
      cursor = stringField(result, 'nextCursor');
      if (!cursor) return resources;
    }
    throw new McpHostError('protocol', 'mcp_pagination_limit', 'MCP resources/list exceeded the pagination safety limit.');
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: McpOperationOptions
  ): Promise<McpCallToolResult> {
    await this.initialize(options.signal);
    const token = randomUUID();
    if (options.onProgress) this.progressHandlers.set(token, options.onProgress);
    try {
      const result = jsonRecord(await this.transport.request('tools/call', {
        name,
        arguments: args,
        _meta: { progressToken: token }
      }, options.signal), 'MCP tools/call result');
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError === true,
        metadata: result._meta && typeof result._meta === 'object' && !Array.isArray(result._meta)
          ? result._meta as Readonly<Record<string, unknown>>
          : undefined
      };
    } finally {
      this.progressHandlers.delete(token);
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    if (this.initialized) return;
    if (this.initializePromise) return await this.initializePromise;
    this.initializePromise = (async () => {
      await this.transport.start(signal);
      const result = jsonRecord(await this.transport.request('initialize', {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'axis', version: 'runtime-mcp-host' }
      }, signal), 'MCP initialize result');
      if (!stringField(result, 'protocolVersion')) {
        throw new McpHostError('protocol', 'mcp_initialize_invalid', 'MCP initialize result did not include a protocol version.');
      }
      await this.transport.notify('notifications/initialized', {}, signal);
      this.initialized = true;
    })();
    try {
      await this.initializePromise;
    } finally {
      if (!this.initialized) this.initializePromise = undefined;
    }
  }
}

function safeBaseEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function cwdForServer(server: McpServerConfig, session: AgentSessionContext): string | undefined {
  const transport = server.transport;
  if (transport.kind !== 'stdio' || !transport.cwdRootId) return undefined;
  const root = session.roots.find((candidate) => candidate.id === transport.cwdRootId);
  if (!root) {
    throw new McpHostError('scope', 'mcp_cwd_root_unavailable', `MCP cwd root ${transport.cwdRootId} is not available in this session.`);
  }
  if (root.companyId !== session.companyId || (root.projectId !== undefined && root.projectId !== session.project?.id)) {
    throw new McpHostError('scope', 'mcp_cwd_root_mismatch', `MCP cwd root ${root.id} is outside the active Company/Project.`);
  }
  return root.path;
}

async function stdioEnv(
  server: McpServerConfig,
  resolver: McpSecretResolver | undefined,
  source: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  if (server.transport.kind !== 'stdio') return safeBaseEnv(source);
  const env = safeBaseEnv(source);
  for (const [key, value] of Object.entries(server.transport.env ?? {})) {
    env[key] = await resolveConfigValue(value, server, resolver);
  }
  return env;
}

export interface NativeMcpClientFactoryOptions {
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/** Native Axis MCP client factory. Authentication is resolved from source-owned secret refs, never from the inference provider. */
export class NativeMcpClientFactory implements McpClientFactory {
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(options: NativeMcpClientFactoryOptions = {}) {
    this.baseEnv = options.baseEnv ?? process.env;
  }

  async open(server: McpServerConfig, options: McpClientFactoryOpenOptions): Promise<McpClient> {
    throwIfAborted(options.signal);
    let transport: McpRpcTransport;
    if (server.transport.kind === 'stdio') {
      transport = new StdioTransport(
        server.transport.command,
        server.transport.args ?? [],
        cwdForServer(server, options.session),
        await stdioEnv(server, options.secretResolver, this.baseEnv)
      );
    } else {
      const headers = await resolvedHeaders(server, options.secretResolver);
      transport = server.transport.kind === 'sse'
        ? new LegacySseTransport(server.transport.url, headers)
        : new StreamableHttpTransport(server.transport.url, headers);
    }
    const client = new ProtocolMcpClient(transport);
    await transport.start(options.signal);
    return client;
  }
}
