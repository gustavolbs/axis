import type { MutationStatus, ToolProgress } from '../../agent-runtime/index.js';

export const AXIS_BROWSER_CAPABILITY_IDS = Object.freeze({
  navigate: 'axis.browser.navigate',
  read: 'axis.browser.read',
  state: 'axis.browser.state',
  inspect: 'axis.browser.inspect',
  developer: 'axis.browser.developer',
  screenshot: 'axis.browser.screenshot',
  interact: 'axis.browser.interact'
} as const);

export const AXIS_BROWSER_PERMISSION_IDS = Object.freeze({
  navigate: 'browser.navigate',
  external: 'browser.external',
  read: 'browser.read',
  inspect: 'browser.inspect',
  developer: 'browser.developer',
  screenshot: 'browser.screenshot',
  interact: 'browser.interact',
  mutate: 'browser.mutate'
} as const);

export type AxisBrowserCapabilityId =
  typeof AXIS_BROWSER_CAPABILITY_IDS[keyof typeof AXIS_BROWSER_CAPABILITY_IDS];

export type AxisBrowserPermissionId =
  typeof AXIS_BROWSER_PERMISSION_IDS[keyof typeof AXIS_BROWSER_PERMISSION_IDS];

export type BrowserStorageMode = 'ephemeral-session' | 'persistent-profile';

/**
 * Browser ownership is intentionally independent from provider/account identity.
 * A browser session belongs to one immutable Axis agent session inside one
 * Company/Project/execution-target context. `storagePartitionKey` is stable at
 * Company + Project + target granularity so a future persistent profile can be
 * isolated without leaking cookies/localStorage across Companies.
 */
export interface BrowserSessionScope {
  readonly sessionId: string;
  readonly companyId: string;
  readonly projectId?: string;
  readonly executionTargetId: string;
  readonly storagePartitionKey: string;
  readonly contextKey: string;
}

export interface BrowserOperationContext {
  readonly signal: AbortSignal;
  readonly reportProgress: (progress: ToolProgress) => void;
}

export type BrowserNavigationReason = 'explicit' | 'redirect' | 'interaction';
export type BrowserNavigationClassification =
  | 'public'
  | 'loopback'
  | 'private-network'
  | 'link-local'
  | 'reserved-network'
  | 'metadata-service'
  | 'invalid';

export interface BrowserNavigationPolicyRequest {
  readonly url: string;
  readonly reason: BrowserNavigationReason;
  readonly scope: BrowserSessionScope;
}

export interface BrowserNavigationPolicyDecision {
  readonly allowed: boolean;
  readonly normalizedUrl: string;
  readonly host: string;
  readonly classification: BrowserNavigationClassification;
  readonly reason?: string;
}

export interface BrowserNavigationPolicy {
  authorize(
    request: BrowserNavigationPolicyRequest
  ): BrowserNavigationPolicyDecision | Promise<BrowserNavigationPolicyDecision>;
}

/** Context visible only to the trusted Axis browser backend implementation. */
export interface BrowserBackendOperationContext extends BrowserOperationContext {
  /**
   * Backends MUST invoke this before redirect- or interaction-triggered
   * navigation. The session manager already invokes it for explicit navigate.
   */
  readonly authorizeNavigation: (
    url: string,
    reason: BrowserNavigationReason
  ) => Promise<BrowserNavigationPolicyDecision>;
}

export interface BrowserNavigateRequest {
  readonly url: string;
}

export interface BrowserContentSecurity {
  readonly trust: 'untrusted-external';
  readonly instructionPolicy: 'treat-as-data';
  readonly suspectedPromptInjection: boolean;
  readonly signals: readonly string[];
}

export interface BrowserNavigationResult {
  readonly requestedUrl: string;
  readonly url: string;
  readonly status: number;
  readonly title?: string;
  readonly contentType?: string;
  readonly security?: BrowserContentSecurity;
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
  readonly security?: BrowserContentSecurity;
}

export type BrowserInspectionKind = 'dom' | 'forms';

export interface BrowserInspectRequest {
  readonly kind: BrowserInspectionKind;
  readonly selector?: string;
  readonly maxChars: number;
  readonly maxEntries: number;
}

export interface BrowserFormControl {
  readonly tag: 'input' | 'textarea' | 'select' | 'button';
  readonly name?: string;
  readonly type?: string;
  readonly required: boolean;
  readonly disabled: boolean;
  /** Values are intentionally not surfaced by the generic form inventory. */
  readonly hasValue: boolean;
}

export interface BrowserFormDescriptor {
  readonly action?: string;
  readonly method: string;
  readonly controls: readonly BrowserFormControl[];
}

export interface BrowserDomInspectResult {
  readonly kind: 'dom';
  readonly url: string;
  readonly source: 'response-html' | 'live-dom';
  readonly selector?: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly security?: BrowserContentSecurity;
}

export interface BrowserFormsInspectResult {
  readonly kind: 'forms';
  readonly url: string;
  readonly source: 'response-html' | 'live-dom';
  readonly forms: readonly BrowserFormDescriptor[];
  readonly truncated: boolean;
  readonly security?: BrowserContentSecurity;
}

export type BrowserInspectResult = BrowserDomInspectResult | BrowserFormsInspectResult;

export type BrowserDeveloperReadKind = 'console' | 'network';

export interface BrowserDeveloperReadRequest {
  readonly kind: BrowserDeveloperReadKind;
  readonly maxEntries: number;
}

export interface BrowserConsoleEntry {
  readonly kind: 'console';
  readonly level: 'debug' | 'info' | 'warn' | 'error' | (string & {});
  readonly text: string;
  readonly timestamp?: string;
}

export interface BrowserNetworkEntry {
  readonly kind: 'network';
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly resourceType?: string;
  readonly timestamp?: string;
}

export type BrowserDeveloperEntry = BrowserConsoleEntry | BrowserNetworkEntry;

export interface BrowserDeveloperReadResult {
  readonly kind: BrowserDeveloperReadKind;
  readonly url?: string;
  readonly entries: readonly BrowserDeveloperEntry[];
  readonly truncated: boolean;
}

export interface BrowserScreenshotRequest {
  readonly fullPage: boolean;
  readonly selector?: string;
}

/** Screenshot bytes stay behind an opaque backend-owned ref. */
export interface BrowserScreenshotResult {
  readonly url: string;
  readonly ref: string;
  readonly mediaType: 'image/png' | 'image/jpeg';
  readonly width?: number;
  readonly height?: number;
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

export interface BrowserSessionFeatures {
  readonly interact: boolean;
  readonly inspect: readonly BrowserInspectionKind[];
  readonly developerRead: readonly BrowserDeveloperReadKind[];
  readonly screenshot: boolean;
}

export interface BrowserSessionState {
  readonly url?: string;
  readonly title?: string;
  readonly history: readonly string[];
  readonly storageMode: BrowserStorageMode;
  readonly features: BrowserSessionFeatures;
}

/** Session facade returned to Axis tools after scope/policy wrapping. */
export interface BrowserSession {
  readonly id: string;
  readonly scope: BrowserSessionScope;
  navigate(request: BrowserNavigateRequest, context: BrowserOperationContext): Promise<BrowserNavigationResult>;
  read(request: BrowserReadRequest, context: BrowserOperationContext): Promise<BrowserReadResult>;
  state(context: BrowserOperationContext): Promise<BrowserSessionState>;
  inspect?(request: BrowserInspectRequest, context: BrowserOperationContext): Promise<BrowserInspectResult>;
  developerRead?(
    request: BrowserDeveloperReadRequest,
    context: BrowserOperationContext
  ): Promise<BrowserDeveloperReadResult>;
  screenshot?(
    request: BrowserScreenshotRequest,
    context: BrowserOperationContext
  ): Promise<BrowserScreenshotResult>;
  interact?(
    request: BrowserInteractRequest,
    context: BrowserOperationContext
  ): Promise<BrowserInteractionResult>;
  close?(): Promise<void>;
}

/** Raw trusted backend session. BrowserSessionManager injects policy into every call. */
export interface BrowserBackendSession {
  readonly id: string;
  readonly scope: BrowserSessionScope;
  navigate(
    request: BrowserNavigateRequest,
    context: BrowserBackendOperationContext
  ): Promise<BrowserNavigationResult>;
  read(
    request: BrowserReadRequest,
    context: BrowserBackendOperationContext
  ): Promise<BrowserReadResult>;
  state(context: BrowserBackendOperationContext): Promise<BrowserSessionState>;
  inspect?(
    request: BrowserInspectRequest,
    context: BrowserBackendOperationContext
  ): Promise<BrowserInspectResult>;
  developerRead?(
    request: BrowserDeveloperReadRequest,
    context: BrowserBackendOperationContext
  ): Promise<BrowserDeveloperReadResult>;
  screenshot?(
    request: BrowserScreenshotRequest,
    context: BrowserBackendOperationContext
  ): Promise<BrowserScreenshotResult>;
  interact?(
    request: BrowserInteractRequest,
    context: BrowserBackendOperationContext
  ): Promise<BrowserInteractionResult>;
  close?(): Promise<void>;
}

export interface BrowserBackend {
  readonly id: string;
  openSession(
    scope: BrowserSessionScope,
    context: BrowserBackendOperationContext
  ): Promise<BrowserBackendSession>;
}
