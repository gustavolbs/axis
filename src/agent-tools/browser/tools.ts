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
  type BrowserInteractRequest,
  type BrowserInteractionAction,
  type BrowserOperationContext,
  type BrowserReadFormat,
  type BrowserReadRequest
} from './contracts.js';
import { BrowserSessionManager } from './session-manager.js';

export const AXIS_BROWSER_TOOL_NAMES = Object.freeze({
  navigate: 'axis_browser_navigate',
  read: 'axis_browser_read',
  interact: 'axis_browser_interact'
} as const);

const DEFAULT_NAVIGATE_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const DEFAULT_INTERACT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_MATCHES = 20;

export interface BrowserToolsetOptions {
  /** Explicit by design: browser execution never selects or falls back to another backend. */
  readonly backend: BrowserBackend;
  readonly navigateTimeoutMs?: number;
  readonly readTimeoutMs?: number;
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

class BrowserNavigateTool implements AxisTool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly sessions: BrowserSessionManager,
    timeoutMs: number
  ) {
    this.definition = Object.freeze({
      name: AXIS_BROWSER_TOOL_NAMES.navigate,
      description: 'Navigate the session-scoped Axis browser to an explicit HTTP(S) URL.',
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
    return {
      output: result,
      mutationStatus: 'not-applicable',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, { url: result.url })
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
      description: 'Read text, HTML, links, or bounded text matches from the current session-scoped browser page.',
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
    return {
      output: result,
      mutationStatus: 'not-applicable',
      metadata: metadata(this.sessions, browser.id, browser.scope.contextKey, {
        url: result.url,
        format: result.format,
        truncated: result.truncated
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
  const sessions = new BrowserSessionManager(options.backend);
  const tools: readonly AxisTool[] = Object.freeze([
    new BrowserNavigateTool(
      sessions,
      positiveTimeout(options.navigateTimeoutMs, DEFAULT_NAVIGATE_TIMEOUT_MS, 'navigateTimeoutMs')
    ),
    new BrowserReadTool(
      sessions,
      positiveTimeout(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, 'readTimeoutMs')
    ),
    new BrowserInteractTool(
      sessions,
      positiveTimeout(options.interactTimeoutMs, DEFAULT_INTERACT_TIMEOUT_MS, 'interactTimeoutMs')
    )
  ]);
  return Object.freeze({ sessions, tools });
}
