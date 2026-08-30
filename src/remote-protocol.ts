import type { AgenticCodeTask, AgenticExecutionResult } from './executor.js';
import type { OllamaGeneration } from './ollama.js';
import type { LocalExecutionPlan, LocalExecutionPlanResult } from './orchestrator.js';

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
  ollama: unknown;
}

export interface RemoteChatRequest {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  systemPrompt: string;
  userPrompt: string;
  format?: 'json' | Record<string, unknown>;
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

export interface RemoteErrorResponse {
  protocolVersion: typeof REMOTE_WORKER_PROTOCOL_VERSION;
  error: string;
}

export function assertProtocolVersion(value: unknown): void {
  if (value !== REMOTE_WORKER_PROTOCOL_VERSION) {
    throw new Error(
      `Remote worker protocol mismatch. Expected ${REMOTE_WORKER_PROTOCOL_VERSION}, received ${String(value)}.`
    );
  }
}
