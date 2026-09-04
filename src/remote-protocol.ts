import type { AgenticCodeTask, AgenticExecutionResult } from './executor.js';
import type {
  LocalEngineerInput,
  LocalEngineerResult,
  LocalEngineerFileChange
} from './local-engineer.js';
import type { OllamaGeneration, OllamaThinkingLevel } from './ollama.js';
import type { LocalExecutionPlan, LocalExecutionPlanResult } from './orchestrator.js';
import type {
  AgentSessionContext,
  ToolActivity,
  ToolCall,
  ToolDefinition,
  ToolExecutionOutput,
  ToolProgress
} from './agent-runtime/index.js';

export const REMOTE_WORKER_PROTOCOL_VERSION = 1 as const;

export interface RemoteUntrackedFile {
  path: string;
  contentBase64: string;
}

export interface RemoteExpectedFile {
  path: string;
  sha256: string | null;
}

export interface RemoteWorkspaceSnapshot {
  repositoryUrl: string;
  baseSha: string;
  workspaceRelativePath: string;
  dirtyPatchBase64: string;
  untrackedFiles: RemoteUntrackedFile[];
  expectedFiles: RemoteExpectedFile[];
  /** Opaque hash derived on the Mac from the concrete checkout/worktree path. */
  isolationKey?: string;
  /**
   * Opaque hash derived from the Mac Git common-dir. Worktrees from one clone share
   * repo intelligence, while separate clones/trust contexts remain isolated even
   * when they use the same origin URL.
   */
  memoryScopeKey?: string;
}

export interface RemoteFileChange {
  path: string;
  beforeSha256: string | null;
  contentBase64: string | null;
}

export interface RemoteWorkerHealth {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  workerVersion: string;
  ok: boolean;
  hostname: string;
  platform: NodeJS.Platform;
  model: string;
  bootstrap: string;
  scheduler?: unknown;
  ollama: unknown;
  /** Exact native AxisTool names accepted by /v1/axis-tool. */
  axisTools?: readonly string[];
}

export interface RemoteChatRuntime {
  model?: string;
  numCtx?: number;
  keepAlive?: string | number;
  think?: OllamaThinkingLevel;
  maxTokens?: number;
  maxDurationMs?: number;
}

export interface RemoteChatRequest {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  systemPrompt: string;
  userPrompt: string;
  format?: 'json' | Record<string, unknown>;
  /** Serializable Ollama hints only; progress callbacks stay on the worker. */
  runtime?: RemoteChatRuntime;
}

export interface RemoteChatResponse {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  generation: OllamaGeneration;
}

export interface RemoteTaskRequest {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  workspace: RemoteWorkspaceSnapshot;
  input: Omit<AgenticCodeTask, 'workspace'>;
}

export interface RemoteTaskResponse {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  result: AgenticExecutionResult;
  changes: RemoteFileChange[];
}

export interface RemotePlanRequest {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  workspace: RemoteWorkspaceSnapshot;
  input: Omit<LocalExecutionPlan, 'workspace'>;
}

export interface RemotePlanResponse {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  result: LocalExecutionPlanResult;
  changes: RemoteFileChange[];
}

export interface RemoteEngineerRequest {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  workspace: RemoteWorkspaceSnapshot;
  input: Omit<LocalEngineerInput, 'workspace'>;
}

export interface RemoteEngineerResponse {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  result: LocalEngineerResult;
  changes: LocalEngineerFileChange[];
}

export interface RemoteErrorResponse {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  error: string;
}

export type RemoteAxisToolLifecycleEvent =
  | { readonly type: 'started'; readonly at: string }
  | { readonly type: 'progress'; readonly progress: ToolProgress; readonly at: string }
  | { readonly type: 'activity'; readonly activity: ToolActivity; readonly at: string }
  | { readonly type: 'completed'; readonly at: string };

/**
 * One runtime-authorized native tool invocation. Provider credentials and
 * Connection secrets are intentionally absent: the Worker is an execution
 * destination, never a provider or Company authority source.
 */
export interface RemoteAxisToolRequest {
  readonly protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly executionId: string;
  readonly cancellationId: string;
  readonly deadlineAt: string;
  readonly attempt: number;
  readonly session: AgentSessionContext;
  readonly tool: ToolDefinition;
  readonly call: ToolCall;
  readonly workspace: RemoteWorkspaceSnapshot;
  readonly authorization: {
    readonly grantedByCanonicalRuntime: true;
    readonly permissions: readonly string[];
    readonly capabilities: readonly string[];
  };
}

export interface RemoteAxisToolResponse {
  readonly protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly executionId: string;
  readonly state: 'completed-no-mutation' | 'completed-mutated';
  readonly output: ToolExecutionOutput;
  readonly changes: readonly RemoteFileChange[];
  readonly lifecycle: readonly RemoteAxisToolLifecycleEvent[];
}

export function assertProtocolVersion(value: unknown): void {
  if (value !== REMOTE_WORKER_PROTOCOL_VERSION) {
    throw new Error(
      `Remote worker protocol mismatch. Expected ${REMOTE_WORKER_PROTOCOL_VERSION}, received ${String(value)}.`
    );
  }
}
