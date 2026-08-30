import type { LocalCoderConfig } from './config.js';
import type { AgenticCodeTask, AgenticExecutionResult } from './executor.js';
import type { LocalEngineerInput, LocalEngineerResult } from './local-engineer.js';
import type { OllamaGeneration } from './ollama.js';
import type { LocalExecutionPlan, LocalExecutionPlanResult } from './orchestrator.js';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  assertProtocolVersion,
  type RemoteChatResponse,
  type RemoteEngineerResponse,
  type RemotePlanResponse,
  type RemoteTaskResponse,
  type RemoteWorkerHealth
} from './remote-protocol.js';
import { applyRemoteChanges, prepareRemoteWorkspace } from './remote-workspace.js';

export class RemoteWorkerError extends Error {
  constructor(
    message: string,
    readonly unavailable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'RemoteWorkerError';
  }
}

export class RemoteWorkerClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(private readonly config: LocalCoderConfig) {
    if (!config.remoteWorkerUrl) {
      throw new Error('LOCAL_CODER_REMOTE_WORKER_URL is required for remote execution.');
    }
    if (!config.remoteWorkerToken) {
      throw new Error('LOCAL_CODER_REMOTE_WORKER_TOKEN is required for remote execution.');
    }
    this.baseUrl = config.remoteWorkerUrl.replace(/\/$/, '');
    this.token = config.remoteWorkerToken;
  }

  async health(): Promise<RemoteWorkerHealth> {
    return await this.request<RemoteWorkerHealth>('/v1/health', undefined, 'GET');
  }

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>
  ): Promise<OllamaGeneration> {
    const response = await this.request<RemoteChatResponse>('/v1/chat', {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      systemPrompt,
      userPrompt,
      ...(format ? { format } : {})
    });
    assertProtocolVersion(response.protocolVersion);
    return response.generation;
  }

  async executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult> {
    const snapshot = await prepareRemoteWorkspace(
      input.workspace,
      input.editableFiles,
      this.config
    );
    const { workspace: _workspace, ...remoteInput } = input;
    const response = await this.request<RemoteTaskResponse>('/v1/execute-task', {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workspace: snapshot,
      input: remoteInput
    });
    assertProtocolVersion(response.protocolVersion);

    if (response.result.rolledBack && response.changes.length > 0) {
      throw new Error('Remote worker returned file changes for a rolled-back task.');
    }

    await applyRemoteChanges(input.workspace, response.changes, this.config);
    response.result.workspace = input.workspace;
    return response.result;
  }

  async executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult> {
    const editableFiles = [
      ...new Set(input.tasks.flatMap((task) => task.editableFiles))
    ];
    const snapshot = await prepareRemoteWorkspace(input.workspace, editableFiles, this.config);
    const { workspace: _workspace, ...remoteInput } = input;
    const response = await this.request<RemotePlanResponse>('/v1/execute-plan', {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workspace: snapshot,
      input: remoteInput
    });
    assertProtocolVersion(response.protocolVersion);

    if (response.result.rolledBack && response.changes.length > 0) {
      throw new Error('Remote worker returned file changes for a rolled-back plan.');
    }

    await applyRemoteChanges(input.workspace, response.changes, this.config);
    response.result.workspace = input.workspace;
    for (const task of response.result.taskResults) {
      task.execution.workspace = input.workspace;
    }
    return response.result;
  }

  async executeEngineer(input: LocalEngineerInput): Promise<LocalEngineerResult> {
    // The editable set is intentionally unknown at submission time. The remote local
    // engineer discovers it after evidence-backed investigation/planning and returns
    // dynamic before-hash guarded changes of its own.
    const snapshot = await prepareRemoteWorkspace(input.workspace, [], this.config);
    const { workspace: _workspace, ...remoteInput } = input;
    const response = await this.request<RemoteEngineerResponse>('/v1/engineer', {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workspace: snapshot,
      input: remoteInput
    });
    assertProtocolVersion(response.protocolVersion);

    if (response.result.status !== 'success' && response.changes.length > 0) {
      throw new Error('Remote local engineer returned changes for a non-success result.');
    }

    if (response.result.status === 'success') {
      await applyRemoteChanges(input.workspace, response.changes, this.config);
    }

    response.result.workspace = input.workspace;
    if (response.result.execution) {
      response.result.execution.workspace = input.workspace;
      for (const task of response.result.execution.taskResults) {
        task.execution.workspace = input.workspace;
      }
    }
    return response.result;
  }

  private async request<T>(
    pathname: string,
    body?: Record<string, unknown>,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.remoteWorkerTimeoutMs)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RemoteWorkerError(
        `Could not reach remote local-coder worker at ${this.baseUrl}. ${message}`,
        true
      );
    }

    const raw = await response.text();
    let payload: unknown;
    try {
      payload = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      throw new RemoteWorkerError(
        `Remote worker returned invalid JSON (HTTP ${response.status}).`,
        response.status >= 500,
        response.status
      );
    }

    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error?: unknown }).error)
          : response.statusText;
      throw new RemoteWorkerError(
        `Remote worker HTTP ${response.status}: ${message}`,
        response.status === 502 || response.status === 503 || response.status === 504,
        response.status
      );
    }

    return payload as T;
  }
}
