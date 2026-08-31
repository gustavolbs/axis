import type { LocalCoderConfig } from './config.js';
import { classifyInferenceStage } from './inference-status.js';
import type {
  LocalEngineerExecution,
  LocalEngineerInput,
  LocalEngineerResult
} from './local-engineer.js';
import type {
  OllamaChatOptions,
  OllamaClient,
  OllamaGeneration,
  OllamaThinkingLevel
} from './ollama.js';
import type { OllamaStreamProgress } from './ollama-stream.js';
import { executePremiumLocalAgent } from './premium-agent.js';
import {
  ProjectProviderRuntime,
  type ProjectProviderRuntimeOptions
} from './project-provider-runtime.js';
import {
  ProjectRoutedChatClient,
  type LegacyAgentChatClient,
  type ProjectRouteEvent
} from './project-routed-chat.js';
import {
  ProjectStore,
  projectIsolationKey,
  type ProjectDefinition
} from './project-store.js';
import { AutoLocalInferenceProvider } from './providers/auto-local-provider.js';
import { OllamaInferenceProvider } from './providers/ollama-provider.js';
import { RemoteWorkerInferenceProvider } from './providers/remote-worker-provider.js';
import type {
  InferenceOutputFormat,
  InferenceProvider,
  ReasoningEffort
} from './providers/types.js';
import { RemoteWorkerClient } from './remote-worker-client.js';
import type { RemoteWorkerHealth } from './remote-protocol.js';
import { resolveWorkspace } from './workspace.js';

export type ProjectEngineerInput = LocalEngineerInput & { projectId?: string };

export interface LegacyEngineerExecutor {
  executeEngineer(input: LocalEngineerInput): Promise<LocalEngineerResult>;
}

export interface ProjectRoutingTraceEntry {
  stage: ProjectRouteEvent['stage'];
  requestedPolicy: ProjectRouteEvent['routing']['requestedPolicy'];
  effectivePolicy: ProjectRouteEvent['routing']['effectivePolicy'];
  providerId: string;
  modelId: string;
  providerKind: 'local' | 'cloud';
  fallbackUsed: boolean;
  attempts: ProjectRouteEvent['attempts'];
  reasons: string[];
}

export interface ProjectExecutionMetadata {
  projectId: string;
  organizationId: string;
  agentHost: 'control-plane';
  localInference: 'mac-ollama' | 'windows-worker' | 'windows-worker-with-mac-fallback';
  repoMemoryScopeKey: string;
  routingTrace: ProjectRoutingTraceEntry[];
}

export type ProjectEngineerResult = LocalEngineerResult & {
  projectExecution?: ProjectExecutionMetadata;
};

type RemoteChatClient = {
  health(): Promise<RemoteWorkerHealth>;
  chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>
  ): Promise<OllamaGeneration>;
};

type AgentExecutor = (
  model: LegacyAgentChatClient,
  config: LocalCoderConfig,
  input: LocalEngineerInput & { repoMemoryScopeKey?: string }
) => Promise<LocalEngineerExecution>;

export interface ProjectEngineerBackendOptions {
  projects?: ProjectStore;
  providerRuntime?: Omit<ProjectProviderRuntimeOptions, 'localProvider'>;
  remoteClient?: RemoteChatClient;
  agentExecutor?: AgentExecutor;
}

function reasoningEffort(think: OllamaThinkingLevel | undefined): ReasoningEffort | undefined {
  if (think === undefined) return undefined;
  if (think === false) return 'none';
  if (think === true) return 'high';
  return think;
}

function outputFormat(format: 'json' | Record<string, unknown> | undefined): InferenceOutputFormat {
  if (!format || format === 'json') return { type: 'text' };
  return { type: 'json_schema', schema: format, name: 'local_coder_project_agent', strict: true };
}

function streamProgress(
  startedAt: number,
  state: 'waiting-response' | 'reasoning' | 'generating',
  timestamp: string,
  eventCount: number,
  outputChars: number
): OllamaStreamProgress {
  return {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    chunkCount: eventCount,
    thinkingChars: 0,
    outputChars,
    state: state === 'generating' ? 'generating' : 'thinking',
    lastActivityAt: timestamp
  };
}

/** Adapts one already-selected local provider back to the legacy agent chat contract. */
class InferenceProviderChatClient implements LegacyAgentChatClient {
  constructor(private readonly provider: InferenceProvider) {}

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime: OllamaChatOptions = {}
  ): Promise<OllamaGeneration> {
    const model = runtime.model ?? (await this.provider.listModels())[0]?.id;
    if (!model) throw new Error('Local inference provider has no model available.');
    const startedAt = Date.now();
    const result = await this.provider.invoke({
      model,
      systemPrompt,
      userPrompt,
      stage: classifyInferenceStage(systemPrompt),
      output: outputFormat(format),
      reasoning: runtime.think === undefined
        ? undefined
        : { effort: reasoningEffort(runtime.think) ?? 'none' },
      maxOutputTokens: runtime.maxTokens,
      timeoutMs: runtime.maxDurationMs,
      providerOptions: {
        ollama: {
          numCtx: runtime.numCtx,
          keepAlive: runtime.keepAlive,
          think: runtime.think
        }
      },
      onProgress: runtime.onStreamProgress
        ? (progress) => runtime.onStreamProgress?.(
            streamProgress(
              startedAt,
              progress.state,
              progress.timestamp,
              progress.eventCount,
              progress.outputChars
            )
          )
        : undefined
    });
    return {
      content: result.content,
      model: result.model,
      doneReason: result.stopReason,
      totalDurationNs: Math.max(0, result.latencyMs) * 1_000_000,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens
    };
  }
}

function trace(event: ProjectRouteEvent): ProjectRoutingTraceEntry {
  return {
    stage: event.stage,
    requestedPolicy: event.routing.requestedPolicy,
    effectivePolicy: event.routing.effectivePolicy,
    providerId: event.routing.selected.providerId,
    modelId: event.routing.selected.modelId,
    providerKind: event.routing.selected.providerKind,
    fallbackUsed: event.fallbackUsed,
    attempts: event.attempts,
    reasons: [...event.routing.reasons]
  };
}

/**
 * Project-aware engineer wrapper. Non-Project calls delegate byte-for-byte to the legacy
 * backend. Project calls keep orchestration/workspace mutation on the Mac control plane,
 * then route cognitive calls to cloud directly or to Qwen through the Windows worker.
 */
export class ProjectAwareEngineerBackend {
  private readonly projects: ProjectStore;
  private readonly agentExecutor: AgentExecutor;
  private remoteClient?: RemoteChatClient;

  constructor(
    private readonly config: LocalCoderConfig,
    private readonly ollama: OllamaClient,
    private readonly legacy: LegacyEngineerExecutor,
    private readonly options: ProjectEngineerBackendOptions = {}
  ) {
    this.projects = options.projects ?? new ProjectStore();
    this.agentExecutor = options.agentExecutor ?? executePremiumLocalAgent;
    this.remoteClient = options.remoteClient;
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    if (!input.projectId) return await this.legacy.executeEngineer(input);

    const project = this.projects.get(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const [workspace, projectWorkspace] = await Promise.all([
      resolveWorkspace(input.workspace),
      resolveWorkspace(project.workspace)
    ]);
    if (workspace !== projectWorkspace) {
      throw new Error(
        `Project ${project.id} is bound to ${projectWorkspace}; refusing workspace ${workspace}.`
      );
    }

    const localProvider = this.localProvider();
    const providerRuntime = new ProjectProviderRuntime({
      ...(this.options.providerRuntime ?? {}),
      localProvider
    });
    const localChat: LegacyAgentChatClient =
      this.config.executionMode === 'local'
        ? this.ollama
        : new InferenceProviderChatClient(localProvider);
    const routingTrace: ProjectRoutingTraceEntry[] = [];
    const routedChat = new ProjectRoutedChatClient(
      project,
      providerRuntime,
      localChat,
      { onRoute: (event) => routingTrace.push(trace(event)) }
    );

    const { projectId: _projectId, ...agentInput } = input;
    const memoryScopeKey = projectIsolationKey(project);
    const execution = await this.agentExecutor(routedChat, this.config, {
      ...agentInput,
      workspace: projectWorkspace,
      repoMemoryScopeKey: memoryScopeKey
    });
    const result = execution.result as ProjectEngineerResult;
    result.projectExecution = {
      projectId: project.id,
      organizationId: project.organizationId,
      agentHost: 'control-plane',
      localInference: this.localInferenceLabel(),
      repoMemoryScopeKey: memoryScopeKey,
      routingTrace
    };
    return result;
  }

  private localProvider(): InferenceProvider {
    const mac = new OllamaInferenceProvider(this.ollama);
    if (this.config.executionMode === 'local') return mac;
    const remote = new RemoteWorkerInferenceProvider(this.getRemoteClient());
    if (this.config.executionMode === 'remote') return remote;
    return new AutoLocalInferenceProvider(remote, mac);
  }

  private getRemoteClient(): RemoteChatClient {
    if (!this.remoteClient) this.remoteClient = new RemoteWorkerClient(this.config);
    return this.remoteClient;
  }

  private localInferenceLabel(): ProjectExecutionMetadata['localInference'] {
    if (this.config.executionMode === 'local') return 'mac-ollama';
    if (this.config.executionMode === 'remote') return 'windows-worker';
    return 'windows-worker-with-mac-fallback';
  }
}
