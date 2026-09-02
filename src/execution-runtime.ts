import type { LocalCoderConfig } from './config.js';
import {
  executeAgenticCodeTask,
  type AgenticCodeTask,
  type AgenticExecutionResult
} from './executor.js';
import type {
  LocalEngineerEscalation,
  LocalEngineerResult
} from './local-engineer.js';
import { createLocalInferenceProvider } from './local-inference-provider.js';
import type { OllamaChatOptions, OllamaClient, OllamaGeneration, OllamaThinkingLevel } from './ollama.js';
import type { OllamaStreamProgress } from './ollama-stream.js';
import {
  executeLocalCodePlan,
  type LocalExecutionPlan,
  type LocalExecutionPlanResult
} from './orchestrator.js';
import { PersonalUsageRecorder } from './personal-usage.js';
import { executePremiumLocalAgent } from './premium-agent.js';
import {
  ProjectAwareEngineerBackend,
  type ProjectEngineerInput,
  type ProjectEscalationChoice,
  type ProjectEscalationGuidance,
  type ProjectEscalationPlan
} from './project-engineer-backend.js';
import { ProjectProviderRuntime } from './project-provider-runtime.js';
import type {
  InferenceOutputFormat,
  InferenceProvider,
  ModelDefinition,
  ReasoningEffort
} from './providers/types.js';
import { RemoteWorkerClient, RemoteWorkerError } from './remote-worker-client.js';

export interface ChatClient {
  chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime?: OllamaChatOptions
  ): Promise<OllamaGeneration>;
}

export interface ExecutionBackend {
  executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult>;
  executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult>;
  executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult>;
  prepareEscalation?(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation
  ): Promise<ProjectEscalationPlan>;
  consultEscalation?(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation,
    choice: ProjectEscalationChoice
  ): Promise<ProjectEscalationGuidance>;
}

export interface ExecutionRuntime {
  mode: LocalCoderConfig['executionMode'];
  chat: ChatClient;
  execution: ExecutionBackend;
  health(): Promise<Record<string, unknown>>;
}

function outputFormat(format: 'json' | Record<string, unknown> | undefined): InferenceOutputFormat {
  if (!format || format === 'json') return { type: 'text' };
  return { type: 'json_schema', schema: format, name: 'local_coder_personal_chat', strict: true };
}

function reasoningEffort(think: OllamaThinkingLevel | undefined): ReasoningEffort | undefined {
  if (think === undefined) return undefined;
  if (think === false) return 'none';
  if (think === true) return 'high';
  return think;
}

function streamProgress(
  startedAt: number,
  state: 'waiting-response' | 'reasoning' | 'generating',
  timestamp: string,
  eventCount: number,
  outputChars: number,
  providerId?: string,
  model?: string
): OllamaStreamProgress {
  return {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    chunkCount: eventCount,
    thinkingChars: 0,
    outputChars,
    providerId,
    model,
    state: state === 'waiting-response' ? 'waiting' : state === 'generating' ? 'generating' : 'thinking',
    lastActivityAt: timestamp
  };
}

function recordUsageSafely(run: () => void): void {
  try {
    run();
  } catch (error) {
    // The provider has already completed. Never turn a telemetry write failure into
    // a retry that could duplicate a billable cloud request.
    console.error(
      `Could not persist personal Chat usage: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** One exact provider/model for a projectless Chat conversation. */
class SelectedProviderChatClient implements ChatClient {
  constructor(
    private readonly provider: InferenceProvider,
    private readonly model: ModelDefinition,
    private readonly configuredEffort: ProjectEngineerInput['reasoningEffort'] | undefined,
    private readonly usage: PersonalUsageRecorder,
    private readonly jobId?: string
  ) {}

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime: OllamaChatOptions = {}
  ): Promise<OllamaGeneration> {
    const startedAt = Date.now();
    const configured = this.configuredEffort && this.configuredEffort !== 'auto'
      ? this.configuredEffort
      : undefined;
    const effort = configured ?? reasoningEffort(runtime.think);
    const result = await this.provider.invoke({
      model: this.model.id,
      systemPrompt,
      userPrompt,
      stage: 'other',
      output: outputFormat(format),
      reasoning: effort === undefined ? undefined : { effort },
      maxOutputTokens: runtime.maxTokens,
      timeoutMs: runtime.maxDurationMs,
      providerOptions: this.provider.kind === 'local'
        ? {
            ollama: {
              numCtx: runtime.numCtx,
              keepAlive: runtime.keepAlive,
              think: runtime.think
            }
          }
        : undefined,
      onProgress: runtime.onStreamProgress
        ? (progress) => runtime.onStreamProgress?.(
            streamProgress(
              startedAt,
              progress.state,
              progress.timestamp,
              progress.eventCount,
              progress.outputChars,
              progress.providerId,
              progress.model
            )
          )
        : undefined
    });
    recordUsageSafely(() => this.usage.recordInference({
      jobId: this.jobId,
      providerId: this.provider.id,
      providerKind: this.provider.kind,
      modelId: this.model.id,
      result
    }));
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

/** Adds projectless Ollama/worker Chat calls to the global usage ledger. */
class RecordedPersonalChatClient implements ChatClient {
  constructor(
    private readonly inner: ChatClient,
    private readonly usage: PersonalUsageRecorder,
    private readonly jobId?: string
  ) {}

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime?: OllamaChatOptions
  ): Promise<OllamaGeneration> {
    const generation = await this.inner.chat(systemPrompt, userPrompt, format, runtime);
    recordUsageSafely(() => this.usage.recordLocalGeneration({
      jobId: this.jobId,
      modelId: generation.model,
      promptTokens: generation.promptTokens,
      completionTokens: generation.completionTokens,
      totalDurationNs: generation.totalDurationNs
    }));
    return generation;
  }
}

class LocalExecutionBackend implements ExecutionBackend {
  constructor(
    private readonly ollama: OllamaClient,
    private readonly config: LocalCoderConfig
  ) {}

  async executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult> {
    return await executeAgenticCodeTask(this.ollama, this.config, input);
  }

  async executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult> {
    return await executeLocalCodePlan(this.ollama, this.config, input);
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    const { projectId: _projectId, ...legacyInput } = input;
    return (await executePremiumLocalAgent(this.ollama, this.config, legacyInput)).result;
  }
}

class AutoChatClient implements ChatClient {
  constructor(
    private readonly remote: RemoteWorkerClient,
    private readonly local: ChatClient
  ) {}

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime?: OllamaChatOptions
  ): Promise<OllamaGeneration> {
    try {
      return await this.remote.chat(systemPrompt, userPrompt, format, runtime);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.chat(systemPrompt, userPrompt, format, runtime);
    }
  }
}

class AutoExecutionBackend implements ExecutionBackend {
  constructor(
    private readonly remote: RemoteWorkerClient,
    private readonly local: ExecutionBackend
  ) {}

  async executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult> {
    try {
      return await this.remote.executeTask(input);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.executeTask(input);
    }
  }

  async executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult> {
    try {
      return await this.remote.executePlan(input);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.executePlan(input);
    }
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    const { projectId: _projectId, ...legacyInput } = input;
    try {
      return await this.remote.executeEngineer(legacyInput);
    } catch (error) {
      if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
      return await this.local.executeEngineer(legacyInput);
    }
  }
}

class ProjectAwareExecutionBackend implements ExecutionBackend {
  private readonly engineer: ProjectAwareEngineerBackend;
  private readonly personalProviders: ProjectProviderRuntime;
  private readonly personalUsage = new PersonalUsageRecorder();

  constructor(
    private readonly legacy: ExecutionBackend,
    private readonly config: LocalCoderConfig,
    ollama: OllamaClient,
    private readonly directChat: ChatClient,
    personalLocalProvider?: InferenceProvider,
    personalProviders?: ProjectProviderRuntime
  ) {
    this.engineer = new ProjectAwareEngineerBackend(config, ollama, legacy);
    this.personalProviders = personalProviders
      ?? new ProjectProviderRuntime({ localProvider: personalLocalProvider });
  }

  async executeTask(input: AgenticCodeTask): Promise<AgenticExecutionResult> {
    return await this.legacy.executeTask(input);
  }

  async executePlan(input: LocalExecutionPlan): Promise<LocalExecutionPlanResult> {
    return await this.legacy.executePlan(input);
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    if (input.interactionMode === 'chat' && !input.projectId) {
      if (input.routingPolicy !== undefined) {
        throw new Error('Routing-policy overrides require a configured Project.');
      }
      if (input.modelSelection?.mode === 'local-first') {
        throw new Error('Local-first requires a Project because cloud escalation is governed by Project privacy and credential bindings.');
      }

      const selection = input.modelSelection;
      if (selection?.mode === 'explicit') {
        const resolved = await this.personalProviders.personalModelDefinition(
          selection.providerId,
          selection.modelId
        );
        const jobId = input.budgetJobId;
        const {
          projectId: _projectId,
          budgetJobId: _budgetJobId,
          routingPolicy: _routingPolicy,
          modelSelection: _modelSelection,
          reasoningEffort: _reasoningEffort,
          chatModelLimits: _chatModelLimits,
          ...chatInput
        } = input;
        return (
          await executePremiumLocalAgent(
            new SelectedProviderChatClient(
              resolved.provider,
              resolved.model,
              input.reasoningEffort,
              this.personalUsage,
              jobId
            ),
            this.config,
            {
              ...chatInput,
              workspace: '',
              chatModelLimits: {
                providerId: resolved.provider.id,
                providerKind: resolved.provider.kind,
                modelId: resolved.model.id,
                contextWindow: resolved.model.contextWindow,
                maxOutputTokens: resolved.model.maxOutputTokens
              }
            }
          )
        ).result;
      }

      if (
        input.modelSelection !== undefined && input.modelSelection.mode !== 'auto'
      ) {
        throw new Error('Personal Chat requires an explicit available provider/model pair.');
      }
      if (input.reasoningEffort !== undefined && input.reasoningEffort !== 'auto') {
        throw new Error('Choose a model before overriding effort in personal Chat.');
      }
      const jobId = input.budgetJobId;
      const {
        projectId: _projectId,
        budgetJobId: _budgetJobId,
        routingPolicy: _routingPolicy,
        modelSelection: _modelSelection,
        reasoningEffort: _reasoningEffort,
        chatModelLimits: _chatModelLimits,
        ...chatInput
      } = input;
      return (
        await executePremiumLocalAgent(
          new RecordedPersonalChatClient(this.directChat, this.personalUsage, jobId),
          this.config,
          {
            ...chatInput,
            workspace: '',
            chatModelLimits: {
              providerId: 'ollama',
              providerKind: 'local',
              contextWindow: this.config.ollamaNumCtx ?? 16_384
            }
          }
        )
      ).result;
    }
    return await this.engineer.executeEngineer(input);
  }

  async prepareEscalation(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation
  ): Promise<ProjectEscalationPlan> {
    return await this.engineer.prepareEscalation(input, escalation);
  }

  async consultEscalation(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation,
    choice: ProjectEscalationChoice
  ): Promise<ProjectEscalationGuidance> {
    return await this.engineer.consultEscalation(input, escalation, choice);
  }
}

function projectAware(
  legacy: ExecutionBackend,
  config: LocalCoderConfig,
  ollama: OllamaClient,
  directChat: ChatClient,
  personalLocalProvider?: InferenceProvider,
  personalProviders?: ProjectProviderRuntime
): ExecutionBackend {
  return new ProjectAwareExecutionBackend(
    legacy,
    config,
    ollama,
    directChat,
    personalLocalProvider,
    personalProviders
  );
}

const WORKER_NOT_CONFIGURED = 'No worker URL is set. Add one in Settings → General → Windows worker.';

class UnconfiguredWorkerBackend implements ExecutionBackend, ChatClient {
  private fail(): never {
    throw new RemoteWorkerError(WORKER_NOT_CONFIGURED, true);
  }

  async chat(): Promise<OllamaGeneration> { return this.fail(); }
  async executeTask(): Promise<AgenticExecutionResult> { return this.fail(); }
  async executePlan(): Promise<LocalExecutionPlanResult> { return this.fail(); }
  async executeEngineer(): Promise<LocalEngineerResult> { return this.fail(); }
}

export function createExecutionRuntime(
  config: LocalCoderConfig,
  ollama: OllamaClient,
  personalProviders?: ProjectProviderRuntime
): ExecutionRuntime {
  const localExecution = new LocalExecutionBackend(ollama, config);

  if (config.executionMode !== 'local' && !config.remoteWorkerUrl) {
    const unconfigured = new UnconfiguredWorkerBackend();
    return {
      mode: config.executionMode,
      chat: unconfigured,
      execution: projectAware(unconfigured, config, ollama, unconfigured, undefined, personalProviders),
      health: async () => ({
        executionMode: config.executionMode,
        workerConfigured: false,
        error: WORKER_NOT_CONFIGURED
      })
    };
  }

  if (config.executionMode === 'local') {
    const localProvider = createLocalInferenceProvider(config, ollama);
    return {
      mode: 'local',
      chat: ollama,
      execution: projectAware(localExecution, config, ollama, ollama, localProvider, personalProviders),
      health: async () => ({
        executionMode: 'local',
        ollama: await ollama.health()
      })
    };
  }

  const remote = new RemoteWorkerClient(config);
  const remoteLocalProvider = createLocalInferenceProvider(config, ollama, remote);

  if (config.executionMode === 'remote') {
    return {
      mode: 'remote',
      chat: remote,
      execution: projectAware(remote, config, ollama, remote, remoteLocalProvider, personalProviders),
      health: async () => ({
        executionMode: 'remote',
        workerUrl: config.remoteWorkerUrl,
        worker: await remote.health(),
        localFallbackEnabled: false
      })
    };
  }

  const autoChat = new AutoChatClient(remote, ollama);
  const autoExecution = new AutoExecutionBackend(remote, localExecution);
  return {
    mode: 'auto',
    chat: autoChat,
    execution: projectAware(autoExecution, config, ollama, autoChat, remoteLocalProvider, personalProviders),
    health: async () => {
      try {
        return {
          executionMode: 'auto',
          preferred: 'remote',
          workerUrl: config.remoteWorkerUrl,
          worker: await remote.health(),
          localFallbackEnabled: true
        };
      } catch (error) {
        if (!(error instanceof RemoteWorkerError) || !error.unavailable) throw error;
        return {
          executionMode: 'auto',
          preferred: 'remote',
          remoteAvailable: false,
          remoteError: error.message,
          localFallbackEnabled: true,
          ollama: await ollama.health()
        };
      }
    }
  };
}
