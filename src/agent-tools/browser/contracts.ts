import type { MutationStatus, ToolProgress } from '../../agent-runtime/index.js';

export const AXIS_BROWSER_CAPABILITY_IDS = Object.freeze({
  navigate: 'axis.browser.navigate',
  read: 'axis.browser.read',
  interact: 'axis.browser.interact'
} as const);

export const AXIS_BROWSER_PERMISSION_IDS = Object.freeze({
  navigate: 'browser.navigate',
  external: 'browser.external',
  read: 'browser.read',
  interact: 'browser.interact',
  mutate: 'browser.mutate'
} as const);

export type AxisBrowserCapabilityId =
  typeof AXIS_BROWSER_CAPABILITY_IDS[keyof typeof AXIS_BROWSER_CAPABILITY_IDS];

export type AxisBrowserPermissionId =
  typeof AXIS_BROWSER_PERMISSION_IDS[keyof typeof AXIS_BROWSER_PERMISSION_IDS];

/**
 * Browser ownership is intentionally independent from provider/account identity.
 * A browser session belongs to one immutable Axis agent session inside one
 * Company/Project/execution-target context.
 */
export interface BrowserSessionScope {
  readonly sessionId: string;
  readonly companyId: string;
  readonly projectId?: string;
  readonly executionTargetId: string;
  readonly contextKey: string;
}

export interface BrowserOperationContext {
  readonly signal: AbortSignal;
  readonly reportProgress: (progress: ToolProgress) => void;
}

export interface BrowserNavigateRequest {
  readonly url: string;
}

export interface BrowserNavigationResult {
  readonly requestedUrl: string;
  readonly url: string;
  readonly status: number;
  readonly title?: string;
  readonly contentType?: string;
}

export interface BrowserLink {
  readonly text: string;
  readonly href: string;
}

export type BrowserReadFormat = 'text' | 'html' | 'links' | 'extract';

export interface BrowserReadRequest {
  readonly format: BrowserReadFormat;
  readonly maxChars: number;
  readonly query?: string;
  readonly maxMatches: number;
}

export interface BrowserReadResult {
  readonly url: string;
  readonly title?: string;
  readonly status: number;
  readonly contentType?: string;
  readonly format: BrowserReadFormat;
  readonly content?: string;
  readonly links?: readonly BrowserLink[];
  readonly matches?: readonly string[];
  readonly truncated: boolean;
}

export type BrowserInteractionAction = 'click' | 'type' | 'select' | 'submit';

export interface BrowserInteractRequest {
  readonly action: BrowserInteractionAction;
  readonly selector: string;
  readonly text?: string;
  readonly value?: string;
}

export interface BrowserInteractionResult {
  readonly action: BrowserInteractionAction;
  readonly url: string;
  readonly detail?: string;
  /**
   * DOM interaction can trigger remote side effects that a browser driver may
   * be unable to prove. Backends must remain conservative when uncertain.
   */
  readonly mutationStatus: Extract<MutationStatus, 'committed' | 'rolled-back' | 'unknown'>;
}

export interface BrowserBackendSession {
  readonly id: string;
  readonly scope: BrowserSessionScope;
  navigate(
    request: BrowserNavigateRequest,
    context: BrowserOperationContext
  ): Promise<BrowserNavigationResult>;
  read(
    request: BrowserReadRequest,
    context: BrowserOperationContext
  ): Promise<BrowserReadResult>;
  /** Optional because a read-only backend must fail explicitly, never emulate interaction. */
  interact?(
    request: BrowserInteractRequest,
    context: BrowserOperationContext
  ): Promise<BrowserInteractionResult>;
  close?(): Promise<void>;
}

export interface BrowserBackend {
  readonly id: string;
  openSession(
    scope: BrowserSessionScope,
    context: BrowserOperationContext
  ): Promise<BrowserBackendSession>;
}
