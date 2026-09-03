import {
  OperationCancelledError,
  callerCancelled,
  requestAbortSignal,
  throwIfCancelled
} from './cancellation.js';
import type { LocalCoderConfig } from './config.js';
import type { AgenticCodeTask, AgenticExecutionResult } from './executor.js';
import type { LocalEngineerInput, LocalEngineerResult } from './local-engineer.js';
import type { OllamaChatOptions, OllamaGeneration } from './ollama.js';
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
import {
  classifyRuntimeNetworkHost,
  type RuntimeNetworkPolicy
} from './runtime-security/network-policy.js';
import { redactRuntimeUrlForDisplay } from './runtime-security/redaction.js';
import { runtimeSecureFetch } from './runtime-security/secure-fetch.js';

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
  private readonly token?: string;
  private readonly networkPolicy: RuntimeNetworkPolicy;

  constructor(private readonly config: LocalCoderConfig) {
    if (!config.remoteWorkerUrl) {
      throw new Error('LOCAL_CODER_REMOTE_WORKER_URL is required for remote execution.');
    }
    const configuredUrl = new URL(config.remoteWorkerUrl);
    this.baseUrl = configuredUrl.toString().replace(/\/$/, '');
    this.token = config.remoteWorkerToken;
    const classification = classifyRuntimeNetworkHost(configuredUrl.hostname);
    this.networkPolicy = Object.freeze({
      allowedHosts: Object.freeze([configuredUrl.hostname]),
      allowLoopback: classification === 'loopback',
      allowPrivateNetwork: classification === 'private-network' || classification === 'link-local' || classification === 'reserved-network',
      allowInsecureHttp: configuredUrl.protocol === 'http:'
    });
  }

  async health(): Promise<RemoteWorkerHealth> {
    return await this.request<RemoteWorkerHealth>('/v1/health', undefined, 'GET');
  }

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime: OllamaChatOptions = {}
  ): Promise<OllamaGeneration> {
    const response = await this.request<RemoteChatResponse>('/v1/chat', {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      systemPrompt,
      userPrompt,
      ...(format ? { format } : {}),
      runtime: {
        model: runtime.model,
        numCtx: runtime.numCtx,
        keepAlive: runtime.keepAlive,
        think: runtime.think,
        maxTokens: runtime.maxTokens,
        maxDurationMs: runtime.maxDurationMs
      }
    });
    assertProtocolVersion(response.protocolVersion);
    return response.generation;
  }

  async executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult> {
    throwIfCancelled();
    const snapshot = await prepareRemoteWorkspace(
      input.workspace,
      input.editableFiles,
      this.config
    );
    throwIfCancelled();
    const { workspace: _workspace, ...remoteInput } = input;
    const response = await this.request<RemoteTaskResponse>('/v1/execute-task', {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workspace: snapshot,
      input: remoteInput
    });
    assertProtocolVersion(response.protocolVersion);
    throwIfCancelled();

    if (response.result.rolledBack && response.changes.length > 0) {
      throw new Error('Remote worker returned file changes for a rolled-back task.');
    }

    await applyRemoteChanges(input.workspace, response.changes, this.config);
    response.result.workspace = input.workspace;
    return response.result;
  }

  async executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult> {
    throwIfCancelled();
    const editableFiles = [
      ...new Set(input.tasks.flatMap((task) => task.editableFiles))
    ];
    const snapshot = await prepareRemoteWorkspace(input.workspace, editableFiles, this.config);
    throwIfCancelled();
    const { workspace: _workspace, ...remoteInput } = input;
    const response = await this.request<RemotePlanResponse>('/v1/execute-plan', {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workspace: snapshot,
      input: remoteInput
    });
    assertProtocolVersion(response.protocolVersion);
    throwIfCancelled();

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
    throwIfCancelled();
    const snapshot = await prepareRemoteWorkspace(input.workspace, [], this.config);
    throwIfCancelled();
    const { workspace: _workspace, ...remoteInput } = input;
    const response = await this.request<RemoteEngineerResponse>('/v1/engineer', {
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workspace: snapshot,
      input: remoteInput
    });
    assertProtocolVersion(response.protocolVersion);
    throwIfCancelled();

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
    throwIfCancelled();
    const abort = requestAbortSignal(this.config.remoteWorkerTimeoutMs);
    let response: Response;

    try {
      response = await runtimeSecureFetch(fetch, `${this.baseUrl}${pathname}`, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: abort.signal
      }, {
        policy: this.networkPolicy
      });
    } catch (error) {
      if (callerCancelled(abort.callerSignals)) {
        throw new OperationCancelledError('Remote worker request cancelled.');
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new RemoteWorkerError(
        `Could not reach remote local-coder worker at ${redactRuntimeUrlForDisplay(this.baseUrl)}. ${message}`,
        true
      );
    }
    throwIfCancelled();

    const raw = await response.text();
    throwIfCancelled();
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
