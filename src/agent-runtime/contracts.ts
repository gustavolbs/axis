export type AgentAuthKind =
  | 'local'
  | 'api-key'
  | 'claude-account'
  | 'chatgpt-account'
  | (string & {});

export type AgentExecutionTargetKind = 'desktop' | 'worker' | (string & {});
export type AgentExecutionTargetMode = 'inference-only' | 'workspace';
export type AgentRootAccess = 'read' | 'write';
export type AgentResourceKind =
  | 'skill'
  | 'mcp'
  | 'agent'
  | 'hook'
  | 'pattern'
  | 'template'
  | 'memory'
  | (string & {});
export type AgentResourceScope = 'personal' | 'company' | 'project';

export interface AgentConnectionContext {
  readonly id: string;
  readonly providerFamily: string;
  readonly authKind: AgentAuthKind;
  /** Null only for intentionally shared local execution/inference capabilities. */
  readonly companyId: string | null;
}

export interface AgentProjectContext {
  readonly id: string;
  readonly companyId: string;
}

export interface AgentExecutionTargetContext {
  readonly id: string;
  readonly kind: AgentExecutionTargetKind;
  readonly mode: AgentExecutionTargetMode;
}

export interface AgentRoot {
  readonly id: string;
  readonly path: string;
  readonly access: AgentRootAccess;
  readonly companyId: string;
  readonly projectId?: string;
}

export interface AgentResourceBinding {
  readonly kind: AgentResourceKind;
  readonly id: string;
  readonly scope: AgentResourceScope;
  readonly companyId: string;
  readonly projectId?: string;
}

export type AgentPermissionStatus = 'granted' | 'denied' | 'ask';

export interface AgentPermissionSet {
  readonly default: Exclude<AgentPermissionStatus, 'granted'>;
  readonly entries: Readonly<Record<string, AgentPermissionStatus>>;
}

export interface EffectiveCapability {
  readonly id: string;
  readonly available: boolean;
  readonly offeredBy: readonly string[];
  readonly blockedBy: readonly string[];
}

export interface EffectiveCapabilitySet {
  readonly entries: Readonly<Record<string, EffectiveCapability>>;
}

/**
 * Immutable authority for one Axis agent session. All fields that can broaden
 * authority are resolved before the first provider call and never discovered
 * implicitly while the turn is running.
 */
export interface AgentSessionContext {
  readonly sessionId: string;
  readonly companyId: string;
  readonly project?: AgentProjectContext;
  readonly connection: AgentConnectionContext;
  readonly modelId: string;
  readonly executionTarget: AgentExecutionTargetContext;
  readonly roots: readonly AgentRoot[];
  readonly permissions: AgentPermissionSet;
  readonly capabilities: EffectiveCapabilitySet;
  readonly resources: readonly AgentResourceBinding[];
}

function requiredId(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty.`);
}

/** Fail closed if a caller attempts to construct a mixed-Company session. */
export function assertAgentSessionContext(context: AgentSessionContext): void {
  requiredId(context.sessionId, 'Session id');
  requiredId(context.companyId, 'Company id');
  requiredId(context.connection.id, 'Connection id');
  requiredId(context.connection.providerFamily, 'Provider family');
  requiredId(context.modelId, 'Model id');
  requiredId(context.executionTarget.id, 'Execution target id');

  if (context.project && context.project.companyId !== context.companyId) {
    throw new Error(
      `Project ${context.project.id} belongs to Company ${context.project.companyId}, not session Company ${context.companyId}.`
    );
  }
  if (context.connection.companyId !== null && context.connection.companyId !== context.companyId) {
    throw new Error(
      `Connection ${context.connection.id} belongs to Company ${context.connection.companyId}, not session Company ${context.companyId}.`
    );
  }
  for (const root of context.roots) {
    requiredId(root.id, 'Root id');
    requiredId(root.path, `Root ${root.id} path`);
    if (root.companyId !== context.companyId) {
      throw new Error(`Root ${root.id} belongs to Company ${root.companyId}, not session Company ${context.companyId}.`);
    }
    if (root.projectId !== undefined && root.projectId !== context.project?.id) {
      throw new Error(
        `Root ${root.id} belongs to Project ${root.projectId}, not session Project ${context.project?.id ?? '(none)'}.`
      );
    }
  }
  for (const resource of context.resources) {
    requiredId(resource.id, `${resource.kind} resource id`);
    if (resource.companyId !== context.companyId) {
      throw new Error(
        `${resource.kind} resource ${resource.id} belongs to Company ${resource.companyId}, not session Company ${context.companyId}.`
      );
    }
    if (resource.projectId !== undefined && resource.projectId !== context.project?.id) {
      throw new Error(
        `${resource.kind} resource ${resource.id} belongs to Project ${resource.projectId}, not session Project ${context.project?.id ?? '(none)'}.`
      );
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Snapshot external state so caller mutation cannot re-scope an active run. */
export function freezeAgentSessionContext(context: AgentSessionContext): AgentSessionContext {
  const snapshot = structuredClone(context) as AgentSessionContext;
  assertAgentSessionContext(snapshot);
  return deepFreeze(snapshot);
}

export type ToolEffect = 'read' | 'mutation' | 'command' | 'validation' | 'external';
export type ToolMutationRisk = 'none' | 'possible' | 'definite';
export type RetryEligibility = 'never' | 'safe' | 'provider' | 'after-confirmation';
export type MutationStatus =
  | 'not-applicable'
  | 'not-started'
  | 'started'
  | 'committed'
  | 'rolled-back'
  | 'unknown';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly requiredCapabilities: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly effect: ToolEffect;
  readonly mutationRisk: ToolMutationRisk;
  readonly retryOnFailure: RetryEligibility;
  readonly timeoutMs?: number;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ToolErrorKind =
  | 'capability'
  | 'permission'
  | 'tool'
  | 'execution'
  | 'timeout'
  | 'cancelled'
  | 'protocol';

export interface ToolError {
  readonly kind: ToolErrorKind;
  readonly code: string;
  readonly message: string;
  readonly retry: RetryEligibility;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly status: 'success' | 'error' | 'cancelled';
  readonly output?: unknown;
  readonly error?: ToolError;
  readonly mutationStatus: MutationStatus;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolProgress {
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolActivity {
  readonly kind: Extract<ToolEffect, 'read' | 'mutation' | 'command' | 'validation'>;
  readonly detail?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type AgentFailureKind =
  | 'capability'
  | 'permission'
  | 'provider'
  | 'tool'
  | 'execution'
  | 'timeout'
  | 'cancelled'
  | 'protocol'
  | 'limit';

export interface AgentRuntimeFailure {
  readonly kind: AgentFailureKind;
  readonly code: string;
  readonly message: string;
  readonly retry: RetryEligibility;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class AgentRuntimeError extends Error {
  constructor(readonly failure: AgentRuntimeFailure) {
    super(failure.message);
    this.name = 'AgentRuntimeError';
  }
}

/** Metadata only; binary payload transport/storage is intentionally outside P1.1. */
export interface AgentAttachment {
  readonly id: string;
  readonly kind: 'file' | 'image' | 'audio' | 'reference' | (string & {});
  readonly name?: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  /** Opaque reference resolved by the owning transport/resource layer. */
  readonly ref: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentDecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface AgentDecisionRequest {
  readonly id: string;
  readonly kind: 'permission' | 'clarification' | 'confirmation' | 'provider' | (string & {});
  readonly prompt: string;
  readonly options?: readonly AgentDecisionOption[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentDecisionResolution {
  readonly requestId: string;
  readonly optionId?: string;
  readonly text?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Canonical transcript message. Reasoning is intentionally summary-only; raw
 * provider chain-of-thought is never required by the Axis runtime contract.
 */
export interface AgentMessage {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly reasoningSummary?: string;
  readonly attachments?: readonly AgentAttachment[];
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly error?: AgentRuntimeFailure;
  readonly decisionRequest?: AgentDecisionRequest;
  readonly decisionResolution?: AgentDecisionResolution;
}

export interface AgentTurn {
  readonly id: string;
  readonly index: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: 'running' | 'completed' | 'paused' | 'failed' | 'cancelled';
  readonly toolCallCount: number;
  readonly finalText?: string;
  readonly decisionRequest?: AgentDecisionRequest;
}

export interface AgentProgress {
  readonly phase: 'provider' | 'tool';
  readonly state: string;
  readonly message?: string;
  readonly completed?: number;
  readonly total?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface LifecycleBase {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

export type AgentLifecycleEvent = LifecycleBase & (
  | { readonly type: 'session.started'; readonly context: AgentSessionContext }
  | { readonly type: 'turn.started'; readonly turn: AgentTurn }
  | { readonly type: 'user.input'; readonly message: AgentMessage }
  | { readonly type: 'provider.started'; readonly connectionId: string; readonly modelId: string }
  | { readonly type: 'provider.progress'; readonly progress: AgentProgress }
  | { readonly type: 'provider.completed'; readonly stopReason: string; readonly toolCallCount: number }
  | { readonly type: 'permission.requested'; readonly call: ToolCall; readonly permissions: readonly string[] }
  | { readonly type: 'permission.resolved'; readonly callId: string; readonly allowed: boolean; readonly reason?: string }
  | { readonly type: 'decision.requested'; readonly request: AgentDecisionRequest; readonly call?: ToolCall }
  | { readonly type: 'decision.resolved'; readonly resolution: AgentDecisionResolution }
  | { readonly type: 'tool.call'; readonly call: ToolCall; readonly definition?: ToolDefinition }
  | { readonly type: 'tool.progress'; readonly callId: string; readonly toolName: string; readonly progress: ToolProgress }
  | { readonly type: 'tool.result'; readonly result: ToolResult }
  | { readonly type: 'read'; readonly callId: string; readonly toolName: string; readonly status: ToolResult['status']; readonly detail?: string; readonly metadata?: Readonly<Record<string, unknown>> }
  | { readonly type: 'mutation'; readonly callId: string; readonly toolName: string; readonly status: ToolResult['status']; readonly mutationStatus: MutationStatus; readonly detail?: string; readonly metadata?: Readonly<Record<string, unknown>> }
  | { readonly type: 'command'; readonly callId: string; readonly toolName: string; readonly status: ToolResult['status']; readonly mutationStatus: MutationStatus; readonly detail?: string; readonly metadata?: Readonly<Record<string, unknown>> }
  | { readonly type: 'validation'; readonly callId: string; readonly toolName: string; readonly status: ToolResult['status']; readonly detail?: string; readonly metadata?: Readonly<Record<string, unknown>> }
  | { readonly type: 'error'; readonly error: AgentRuntimeFailure; readonly callId?: string; readonly toolName?: string }
  | { readonly type: 'cancelled'; readonly source: 'caller' | 'provider' | 'tool'; readonly callId?: string; readonly toolName?: string }
  | { readonly type: 'turn.completed'; readonly turn: AgentTurn }
  | { readonly type: 'session.completed'; readonly status: 'completed' | 'paused' | 'failed' | 'cancelled'; readonly error?: AgentRuntimeFailure }
);

export type AgentLifecycleSink = (event: AgentLifecycleEvent) => void;
