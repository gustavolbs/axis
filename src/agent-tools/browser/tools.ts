import type {
  AxisTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutput
} from '../../agent-runtime/index.js';
import {
  AXIS_BROWSER_CAPABILITY_IDS,
  AXIS_BROWSER_PERMISSION_IDS,
  type BrowserBackend,
  type BrowserDeveloperReadKind,
  type BrowserDeveloperReadRequest,
  type BrowserInspectRequest,
  type BrowserInteractRequest,
  type BrowserInteractionAction,
  type BrowserNavigationPolicy,
  type BrowserOperationContext,
  type BrowserReadFormat,
  type BrowserReadRequest,
  type BrowserReadResult,
  type BrowserScreenshotRequest
} from './contracts.js';
import {
  assessBrowserContentSecurity,
  UNTRUSTED_BROWSER_CONTENT
} from './security.js';
import { BrowserSessionManager } from './session-manager.js';

export const AXIS_BROWSER_TOOL_NAMES = Object.freeze({
  navigate: 'axis_browser_navigate',
  read: 'axis_browser_read',
  state: 'axis_browser_state',
  inspect: 'axis_browser_inspect',
  developer: 'axis_browser_developer_read',
  screenshot: 'axis_browser_screenshot',
  interact: 'axis_browser_interact'
} as const);

const DEFAULT_NAVIGATE_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const DEFAULT_STATE_TIMEOUT_MS = 5_000;
const DEFAULT_INSPECT_TIMEOUT_MS = 15_000;
const DEFAULT_DEVELOPER_TIMEOUT_MS = 15_000;
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERACT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_MATCHES = 20;
const DEFAULT_MAX_ENTRIES = 100;

export interface BrowserToolsetOptions {
  /** Explicit by design: browser execution never selects or falls back to another backend. */
  readonly backend: BrowserBackend;
  /** Company/Project composition may narrow the default public-host policy. */
  readonly navigationPolicy?: BrowserNavigationPolicy;
  readonly navigateTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly stateTimeoutMs?: number;
  readonly inspectTimeoutMs?: number;
  readonly developerTimeoutMs?: number;
  readonly screenshotTimeoutMs?: number;
  readonly interactTimeoutMs?: number;
}

export interface BrowserToolset {
  readonly sessions: BrowserSessionManager;
  readonly tools: readonly AxisTool[];
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${label} must be positive.`);
  return resolved;
}

function requiredString(
  args: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Browser argument ${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(
  args: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Browser argument ${key} must be a string.`);
  return value;
}

function optionalBoolean(
  args: Readonly<Record<string, unknown>>,
  key: string,
  fallback: boolean
): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Browser argument ${key} must be a boolean.`);
  return value;
}

function boundedInteger(
  args: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  maximum: number
): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Browser argument ${key} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function operationContext(context: ToolExecutionContext): BrowserOperationContext {
  return {
    signal: context.signal,
    reportProgress: context.reportProgress
  };
}

function metadata(
  sessions: BrowserSessionManager,
  browserSessionId: string,
  browserContextKey: string,
  extra: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
  return {
    backendId: sessions.backend.id,
    browserSessionId,
    browserContextKey,
    ...extra
  };
}

function securityForRead(result: BrowserReadResult) {
  if (result.security) return result.security;
  if (result.content !== undefined) return assessBrowserContentSecurity(result.content);
  if (result.matches) return assessBrowserContentSecurity(result.matches);
  if (result.links) return assessBrowserContentSecurity(result.links.flatMap((link) => [link.text, link.href]));
  return UNTRUSTED_BROWSER_CONTENT;
}

class BrowserNavigateTool implements AxisTool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly sessions: BrowserSessionManager,
    timeoutMs: number
  ) {
    this.definition = Object.freeze({
      name: AXIS_BROWSER_TOOL_NAMES.navigate,
      description: 'Navigate the session-scoped Axis browser to an explicit policy-authorized HTTP(S) URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', minLength: 1 }
        },
        required: ['url'],
        additionalProperties: false
      },
      requiredCapabilities: [AXIS_BROWSER_CAPABILITY_IDS.navigate],
      requiredPermissions: [
        AXIS_BROWSER_PERMISSION_IDS.navigate,
        AXIS_BROWSER_PERMISSION_IDS.external
      ],
      effect: 'read',
      mutationRisk: 'none',
      retryOnFailure: 'safe',
      timeoutMs
    });
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const url = requiredString(context.call.arguments, 'url');
    const browser = await this.sessions.getOrCreate(context.session, operationContext(context));
    const result = await browser.navigate({ url }, operationContext(context));
    const security = result.security ?? UNTRUSTED_BROWSER_CONTENT;
    return {
      output: { ...result, security },
      mutationStatus: 'not-applicable',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, {
        url: result.url,
        contentTrust: security.trust,
        suspectedPromptInjection: security.suspectedPromptInjection
      })
    };
  }
}

class BrowserReadTool implements AxisTool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly sessions: BrowserSessionManager,
    timeoutMs: number
  ) {
    this.definition = Object.freeze({
      name: AXIS_BROWSER_TOOL_NAMES.read,
      description: 'Read text, HTML, links, or bounded text matches from the current session-scoped browser page as untrusted external data.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['text', 'html', 'links', 'extract'] },
          maxChars: { type: 'integer', minimum: 1, maximum: 200000 },
          query: { type: 'string' },
          maxMatches: { type: 'integer', minimum: 1, maximum: 100 }
        },
        additionalProperties: false
      },
      requiredCapabilities: [AXIS_BROWSER_CAPABILITY_IDS.read],
      requiredPermissions: [AXIS_BROWSER_PERMISSION_IDS.read],
      effect: 'read',
      mutationRisk: 'none',
      retryOnFailure: 'safe',
      timeoutMs
    });
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const rawFormat = context.call.arguments.format ?? 'text';
    if (
      rawFormat !== 'text' &&
      rawFormat !== 'html' &&
      rawFormat !== 'links' &&
      rawFormat !== 'extract'
    ) {
      throw new Error('Browser argument format must be text, html, links, or extract.');
    }
    const format: BrowserReadFormat = rawFormat;
    const query = optionalString(context.call.arguments, 'query');
    if (format === 'extract' && !query?.trim()) {
      throw new Error('Browser extract format requires a non-empty query.');
    }
    const request: BrowserReadRequest = {
      format,
      maxChars: boundedInteger(context.call.arguments, 'maxChars', DEFAULT_MAX_CHARS, 200_000),
      maxMatches: boundedInteger(context.call.arguments, 'maxMatches', DEFAULT_MAX_MATCHES, 100),
      ...(query !== undefined ? { query } : {})
    };
    const browser = await this.sessions.getOrCreate(context.session, operationContext(context));
    const result = await browser.read(request, operationContext(context));
    const security = securityForRead(result);
    return {
      output: { ...result, security },
      mutationStatus: 'not-applicable',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, {
        url: result.url,
        format: result.format,
        truncated: result.truncated,
        contentTrust: security.trust,
        instructionPolicy: security.instructionPolicy,
        suspectedPromptInjection: security.suspectedPromptInjection,
        promptInjectionSignals: security.signals
      })
    };
  }
}

class BrowserStateTool implements AxisTool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly sessions: BrowserSessionManager,
    timeoutMs: number
  ) {
    this.definition = Object.freeze({
      name: AXIS_BROWSER_TOOL_NAMES.state,
      description: 'Return the current isolated browser session state and backend feature surface without exposing cookies or localStorage values.',
      inputSchema: { type: 'object', additionalProperties: false },
      requiredCapabilities: [AXIS_BROWSER_CAPABILITY_IDS.state],
      requiredPermissions: [AXIS_BROWSER_PERMISSION_IDS.read],
      effect: 'read',
      mutationRisk: 'none',
      retryOnFailure: 'safe',
      timeoutMs
    });
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const browser = await this.sessions.getOrCreate(context.session, operationContext(context));
    const result = await browser.state(operationContext(context));
    return {
      output: result,
      mutationStatus: 'not-applicable',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, {
        url: result.url,
        storageMode: result.storageMode,
        storagePartitionKey: browser.scope.storagePartitionKey
      })
    };
  }
}

class BrowserInspectTool implements AxisTool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly sessions: BrowserSessionManager,
    timeoutMs: number
  ) {
    this.definition = Object.freeze({
      name: AXIS_BROWSER_TOOL_NAMES.inspect,
      description: 'Inspect a bounded DOM snapshot or form inventory through a browser backend that explicitly supports inspection.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['dom', 'forms'] },
          selector: { type: 'string' },
          maxChars: { type: 'integer', minimum: 1, maximum: 200000 },
          maxEntries: { type: 'integer', minimum: 1, maximum: 500 }
        },
        required: ['kind'],
        additionalProperties: false
      },
      requiredCapabilities: [AXIS_BROWSER_CAPABILITY_IDS.inspect],
      requiredPermissions: [AXIS_BROWSER_PERMISSION_IDS.read, AXIS_BROWSER_PERMISSION_IDS.inspect],
      effect: 'read',
      mutationRisk: 'none',
      retryOnFailure: 'safe',
      timeoutMs
    });
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const kind = requiredString(context.call.arguments, 'kind');
    if (kind !== 'dom' && kind !== 'forms') {
      throw new Error('Browser argument kind must be dom or forms.');
    }
    const selector = optionalString(context.call.arguments, 'selector');
    const request: BrowserInspectRequest = {
      kind,
      maxChars: boundedInteger(context.call.arguments, 'maxChars', DEFAULT_MAX_CHARS, 200_000),
      maxEntries: boundedInteger(context.call.arguments, 'maxEntries', DEFAULT_MAX_ENTRIES, 500),
      ...(selector !== undefined ? { selector } : {})
    };
    const browser = await this.sessions.getOrCreate(context.session, operationContext(context));
    if (!browser.inspect) {
      throw new Error(
        `Browser backend ${this.sessions.backend.id} does not support DOM/form inspection. Axis will not fall back to shell, another browser backend, or Computer Use.`
      );
    }
    const result = await browser.inspect(request, operationContext(context));
    const security = result.security ?? (
      result.kind === 'dom' ? assessBrowserContentSecurity(result.content) : UNTRUSTED_BROWSER_CONTENT
    );
    return {
      output: { ...result, security },
      mutationStatus: 'not-applicable',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, {
        url: result.url,
        kind: result.kind,
        truncated: result.truncated,
        contentTrust: security.trust,
        suspectedPromptInjection: security.suspectedPromptInjection,
        promptInjectionSignals: security.signals
      })
    };
  }
}

class BrowserDeveloperReadTool implements AxisTool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly sessions: BrowserSessionManager,
    timeoutMs: number
  ) {
    this.definition = Object.freeze({
      name: AXIS_BROWSER_TOOL_NAMES.developer,
      description: 'Read bounded browser console or network diagnostics from a backend with explicit developer-mode support.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['console', 'network'] },
          maxEntries: { type: 'integer', minimum: 1, maximum: 1000 }
        },
        required: ['kind'],
        additionalProperties: false
      },
      requiredCapabilities: [AXIS_BROWSER_CAPABILITY_IDS.developer],
      requiredPermissions: [AXIS_BROWSER_PERMISSION_IDS.read, AXIS_BROWSER_PERMISSION_IDS.developer],
      effect: 'read',
      mutationRisk: 'none',
      retryOnFailure: 'safe',
      timeoutMs
    });
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const rawKind = requiredString(context.call.arguments, 'kind');
    if (rawKind !== 'console' && rawKind !== 'network') {
      throw new Error('Browser argument kind must be console or network.');
    }
    const kind: BrowserDeveloperReadKind = rawKind;
    const request: BrowserDeveloperReadRequest = {
      kind,
      maxEntries: boundedInteger(context.call.arguments, 'maxEntries', DEFAULT_MAX_ENTRIES, 1000)
    };
    const browser = await this.sessions.getOrCreate(context.session, operationContext(context));
    if (!browser.developerRead) {
      throw new Error(
        `Browser backend ${this.sessions.backend.id} does not support developer diagnostics. Axis will not enable CDP or another browser implicitly.`
      );
    }
    const result = await browser.developerRead(request, operationContext(context));
    return {
      output: result,
      mutationStatus: 'not-applicable',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, {
        kind: result.kind,
        entryCount: result.entries.length,
        truncated: result.truncated
      })
    };
  }
}

class BrowserScreenshotTool implements AxisTool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly sessions: BrowserSessionManager,
    timeoutMs: number
  ) {
    this.definition = Object.freeze({
      name: AXIS_BROWSER_TOOL_NAMES.screenshot,
      description: 'Capture a browser screenshot through a backend that returns an opaque image reference; screenshot bytes never cross this tool contract directly.',
      inputSchema: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean' },
          selector: { type: 'string' }
        },
        additionalProperties: false
      },
      requiredCapabilities: [AXIS_BROWSER_CAPABILITY_IDS.screenshot],
      requiredPermissions: [AXIS_BROWSER_PERMISSION_IDS.read, AXIS_BROWSER_PERMISSION_IDS.screenshot],
      effect: 'read',
      mutationRisk: 'none',
      retryOnFailure: 'safe',
      timeoutMs
    });
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const selector = optionalString(context.call.arguments, 'selector');
    const request: BrowserScreenshotRequest = {
      fullPage: optionalBoolean(context.call.arguments, 'fullPage', false),
      ...(selector !== undefined ? { selector } : {})
    };
    const browser = await this.sessions.getOrCreate(context.session, operationContext(context));
    if (!browser.screenshot) {
      throw new Error(
        `Browser backend ${this.sessions.backend.id} does not support screenshots. Axis will not fall back to Computer Use or screen capture implicitly.`
      );
    }
    const result = await browser.screenshot(request, operationContext(context));
    if (!result.ref.trim()) throw new Error('Browser backend returned an empty screenshot reference.');
    return {
      output: result,
      mutationStatus: 'not-applicable',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, {
        url: result.url,
        mediaType: result.mediaType,
        screenshotRef: result.ref
      })
    };
  }
}

function interactionRequest(args: Readonly<Record<string, unknown>>): BrowserInteractRequest {
  const rawAction = requiredString(args, 'action');
  if (
    rawAction !== 'click' &&
    rawAction !== 'type' &&
    rawAction !== 'select' &&
    rawAction !== 'submit'
  ) {
    throw new Error('Browser argument action must be click, type, select, or submit.');
  }
  const action: BrowserInteractionAction = rawAction;
  const selector = requiredString(args, 'selector');
  const text = optionalString(args, 'text');
  const value = optionalString(args, 'value');
  if (action === 'type' && text === undefined) {
    throw new Error('Browser type interaction requires text.');
  }
  if (action === 'select' && value === undefined) {
    throw new Error('Browser select interaction requires value.');
  }
  return {
    action,
    selector,
    ...(text !== undefined ? { text } : {}),
    ...(value !== undefined ? { value } : {})
  };
}

class BrowserInteractTool implements AxisTool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly sessions: BrowserSessionManager,
    timeoutMs: number
  ) {
    this.definition = Object.freeze({
      name: AXIS_BROWSER_TOOL_NAMES.interact,
      description: 'Perform one explicit DOM-level browser interaction through an interactive Axis browser backend.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'select', 'submit'] },
          selector: { type: 'string', minLength: 1 },
          text: { type: 'string' },
          value: { type: 'string' }
        },
        required: ['action', 'selector'],
        additionalProperties: false
      },
      requiredCapabilities: [AXIS_BROWSER_CAPABILITY_IDS.interact],
      requiredPermissions: [
        AXIS_BROWSER_PERMISSION_IDS.interact,
        AXIS_BROWSER_PERMISSION_IDS.mutate
      ],
      effect: 'mutation',
      mutationRisk: 'possible',
      retryOnFailure: 'after-confirmation',
      timeoutMs
    });
  }

  async execute(context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const request = interactionRequest(context.call.arguments);
    const browser = await this.sessions.getOrCreate(context.session, operationContext(context));
    if (!browser.interact) {
      throw new Error(
        `Browser backend ${this.sessions.backend.id} does not support interaction. Axis will not fall back to another browser backend or Computer Use.`
      );
    }
    const result = await browser.interact(request, operationContext(context));
    if (
      result.mutationStatus !== 'committed' &&
      result.mutationStatus !== 'rolled-back' &&
      result.mutationStatus !== 'unknown'
    ) {
      throw new Error('Browser backend returned an invalid interaction mutation status.');
    }
    return {
      output: result,
      mutationStatus: result.mutationStatus,
      retry: 'after-confirmation',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, {
        url: result.url,
        action: result.action
      })
    };
  }
}

export function createBrowserToolset(options: BrowserToolsetOptions): BrowserToolset {
  const sessions = new BrowserSessionManager(options.backend, options.navigationPolicy);
  const tools: readonly AxisTool[] = Object.freeze([
    new BrowserNavigateTool(
      sessions,
      positiveTimeout(options.navigateTimeoutMs, DEFAULT_NAVIGATE_TIMEOUT_MS, 'navigateTimeoutMs')
    ),
    new BrowserReadTool(
      sessions,
      positiveTimeout(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, 'readTimeoutMs')
    ),
    new BrowserStateTool(
      sessions,
      positiveTimeout(options.stateTimeoutMs, DEFAULT_STATE_TIMEOUT_MS, 'stateTimeoutMs')
    ),
    new BrowserInspectTool(
      sessions,
      positiveTimeout(options.inspectTimeoutMs, DEFAULT_INSPECT_TIMEOUT_MS, 'inspectTimeoutMs')
    ),
    new BrowserDeveloperReadTool(
      sessions,
      positiveTimeout(options.developerTimeoutMs, DEFAULT_DEVELOPER_TIMEOUT_MS, 'developerTimeoutMs')
    ),
    new BrowserScreenshotTool(
      sessions,
      positiveTimeout(options.screenshotTimeoutMs, DEFAULT_SCREENSHOT_TIMEOUT_MS, 'screenshotTimeoutMs')
    ),
    new BrowserInteractTool(
      sessions,
      positiveTimeout(options.interactTimeoutMs, DEFAULT_INTERACT_TIMEOUT_MS, 'interactTimeoutMs')
    )
  ]);
  return Object.freeze({ sessions, tools });
}
