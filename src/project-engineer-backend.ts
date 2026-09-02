import type { LocalCoderConfig } from './config.js';
import {
  routeCognitiveStage,
  type RoutingCandidate
} from './cognitive-router.js';
import { classifyInferenceStage, type InferenceStage } from './inference-status.js';
import type {
  LocalEngineerEscalation,
  LocalEngineerExecution,
  LocalEngineerInput,
  LocalEngineerResult
} from './local-engineer.js';
import {
  createLocalInferenceProvider,
  localInferenceLabel
} from './local-inference-provider.js';
import type {
  OllamaChatOptions,
  OllamaClient,
  OllamaGeneration,
  OllamaThinkingLevel
} from './ollama.js';
import type { OllamaStreamProgress } from './ollama-stream.js';
import {
  ProjectBudgetSession,
  type ProjectBudgetSnapshot
} from './project-budget.js';
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
  projectRepoMemoryScopeKey,
  type ModelSelection,
  type ProjectDefinition,
  type RoutingPolicy
} from './project-store.js';
import type {
  InferenceOutputFormat,
  InferenceProvider,
  InferenceRequest,
  InferenceUsage,
  ProviderKind,
  ReasoningEffort
} from './providers/types.js';
import type { RemoteWorkerHealth } from './remote-protocol.js';
import {
  mergeRoutingMetricsSources,
  RoutingHistoryStore
} from './routing-history.js';
import { resolveWorkspace } from './workspace.js';

export interface ProjectChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProjectChatModelLimits {
  providerId: string;
  providerKind: ProviderKind;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type ProjectEngineerInput = LocalEngineerInput & {
  projectId?: string;
  interactionMode?: 'chat' | 'cowork';
  chatHistory?: ProjectChatHistoryTurn[];
  chatModelLimits?: ProjectChatModelLimits;
  budgetJobId?: string;
  routingPolicy?: RoutingPolicy;
  modelSelection?: ModelSelection;
  reasoningEffort?: 'auto' | ReasoningEffort;
};

export interface ProjectEscalationOption {
  providerId: string;
  modelId: string;
  supportsReasoning: boolean;
}

export interface ProjectEscalationPlan {
  stage: InferenceStage;
  recommended?: ProjectEscalationOption & { reasoningEffort: ReasoningEffort };
  options: ProjectEscalationOption[];
  reasons: string[];
}

export interface ProjectEscalationChoice {
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ProjectEscalationGuidance {
  providerId: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  content: string;
  latencyMs: number;
  usage: InferenceUsage;
}

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
  agentHost: 'desktop-app';
  localInference: 'mac-ollama' | 'windows-worker' | 'windows-worker-with-mac-fallback';
  repoMemoryScopeKey: string;
  routingTrace: ProjectRoutingTraceEntry[];
  budget: ProjectBudgetSnapshot;
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
  input: LocalEngineerInput & {
    repoMemoryScopeKey?: string;
    interactionMode?: 'chat' | 'cowork';
    chatHistory?: ProjectChatHistoryTurn[];
    chatModelLimits?: ProjectChatModelLimits;
  }
) => Promise<LocalEngineerExecution>;

export interface ProjectEngineerBackendOptions {
  projects?: ProjectStore;
  providerRuntime?: Omit<ProjectProviderRuntimeOptions, 'localProvider'>;
  remoteClient?: RemoteChatClient;
  agentExecutor?: AgentExecutor;
  budgetSessionFactory?: (project: ProjectDefinition, jobId?: string) => ProjectBudgetSession;
  routingHistory?: RoutingHistoryStore;
}

const ESCALATION_SYSTEM_PROMPT = `You are a bounded consulting model for a local software-engineering agent.
The local Ollama agent remains the owner of the task and implementation.
Resolve only the uncertainty described in the escalation capsule. Do not take over the whole task, do not invent repository facts, and do not propose unrelated changes.
Return concise, actionable guidance that can be injected back into the local agent as authoritative external guidance. If evidence is insufficient, say exactly what remains unknown.`;

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

function escalationStage(escalation: LocalEngineerEscalation): InferenceStage {
  if (escalation.kind === 'external-research') return 'investigation';
  if (escalation.kind === 'review-failure') return 'review';
  if (escalation.kind === 'execution-failure') return 'implementation';
  if (escalation.kind === 'decision' || escalation.kind === 'sensitive-decision') return 'deliberation';
  return 'other';
}

function withProjectInstructions(
  project: ProjectDefinition,
  input: ProjectEngineerInput
): ProjectEngineerInput {
  const instructions = project.instructions?.trim();
  if (!instructions) return input;
  const existing = input.context?.trim();
  return {
    ...input,
    context: [
      '# PROJECT INSTRUCTIONS',
      'These instructions apply to every conversation explicitly scoped to this Project.',
      instructions,
      existing ? `# TASK CONTEXT\n${existing}` : undefined
    ].filter((value): value is string => Boolean(value)).join('\n\n')
  };
}

function escalationPrompt(input: ProjectEngineerInput, escalation: LocalEngineerEscalation): string {
  return JSON.stringify({
    taskGoal: input.goal,
    taskContext: input.context ?? null,
    taskConstraints: input.constraints ?? [],
    escalation: {
      kind: escalation.kind,
      reason: escalation.reason,
      questions: escalation.questions,
      researchRequests: escalation.researchRequests,
      evidence: escalation.evidence
    },
    responseContract: {
      owner: 'local Ollama agent',
      purpose: 'bounded guidance only',
      implementationOwnership: 'do not take over implementation'
    }
  }, null, 2);
}

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

export class ProjectAwareEngineerBackend {
  private readonly projects: ProjectStore;
  private readonly agentExecutor: AgentExecutor;
  private readonly remoteClient?: RemoteChatClient;
  private readonly routingHistory: RoutingHistoryStore;

  constructor(
    private readonly config: LocalCoderConfig,
    private readonly ollama: OllamaClient,
    private readonly legacy: LegacyEngineerExecutor,
    private readonly options: ProjectEngineerBackendOptions = {}
  ) {
    this.projects = options.projects ?? new ProjectStore();
    this.agentExecutor = options.agentExecutor ?? executePremiumLocalAgent;
    this.remoteClient = options.remoteClient;
    this.routingHistory = options.routingHistory ?? new RoutingHistoryStore();
  }

  async executeEngineer(input: ProjectEngineerInput): Promise<LocalEngineerResult> {
    const resolved = await this.resolveProject(input);
    if (!resolved.project) {
      if (
        input.routingPolicy !== undefined ||
        input.modelSelection !== undefined ||
        (input.reasoningEffort !== undefined && input.reasoningEffort !== 'auto')
      ) {
        throw new Error('Per-task routing, model, and effort overrides require a configured Project.');
      }
      const {
        projectId: _projectId,
        budgetJobId: _budgetJobId,
        routingPolicy: _routingPolicy,
        modelSelection: _modelSelection,
        reasoningEffort: _reasoningEffort,
        chatModelLimits: _chatModelLimits,
        ...legacyInput
      } = input;
      return await this.legacy.executeEngineer(legacyInput);
    }
    const { project, workspace: projectWorkspace } = resolved;
    const scopedInput = withProjectInstructions(project, input);

    const budget = this.createBudgetSession(project, input.budgetJobId);
    const localProvider = createLocalInferenceProvider(this.config, this.ollama, this.remoteClient);
    const providerRuntime = this.createProviderRuntime(project, localProvider);
    const localChat: LegacyAgentChatClient =
      this.config.executionMode === 'local'
        ? this.ollama
        : new InferenceProviderChatClient(localProvider);
    const routingTrace: ProjectRoutingTraceEntry[] = [];
    const routedChat = new ProjectRoutedChatClient(
      project,
      providerRuntime,
      localChat,
      {
        policy: input.routingPolicy,
        modelSelection: input.modelSelection,
        reasoningEffort: input.reasoningEffort === 'auto' ? undefined : input.reasoningEffort,
        connectionScope: input.interactionMode === 'chat' ? 'chat' : 'cowork',
        budget,
        onRoute: (event) => routingTrace.push(trace(event)),
        onAttemptComplete: (observation) => {
          this.routingHistory.record(project, {
            stage: observation.stage,
            candidate: observation.candidate,
            outcome: observation.outcome,
            latencyMs: observation.latencyMs,
            fallback: observation.fallback,
            failureKind: observation.failureKind
          });
        }
      }
    );

    let chatModelLimits: ProjectChatModelLimits | undefined;
    if (input.interactionMode === 'chat') {
      const selection = input.modelSelection ?? project.defaultModel;
      const target = selection.mode === 'explicit'
        ? { providerId: selection.providerId, modelId: selection.modelId }
        : selection.mode === 'local-first'
          ? { providerId: 'ollama', modelId: selection.modelId }
          : undefined;
      if (target) {
        const definition = await providerRuntime.modelDefinition(project, target.providerId, target.modelId);
        if (definition) {
          chatModelLimits = {
            providerId: target.providerId,
            providerKind: definition.providerKind,
            contextWindow: definition.model.contextWindow,
            maxOutputTokens: definition.model.maxOutputTokens
          };
        }
      }
    }

    const {
      projectId: _projectId,
      budgetJobId: _budgetJobId,
      routingPolicy: _routingPolicy,
      modelSelection: _modelSelection,
      reasoningEffort: _reasoningEffort,
      chatModelLimits: _chatModelLimits,
      ...agentInput
    } = scopedInput;
    const memoryScopeKey = input.interactionMode === 'chat'
      ? projectIsolationKey(project)
      : projectRepoMemoryScopeKey(project, projectWorkspace);
    const execution = await this.agentExecutor(routedChat, this.config, {
      ...agentInput,
      workspace: projectWorkspace,
      repoMemoryScopeKey: memoryScopeKey,
      chatModelLimits
    });
    const result = execution.result as ProjectEngineerResult;
    result.projectExecution = {
      projectId: project.id,
      organizationId: project.organizationId,
      agentHost: 'desktop-app',
      localInference: localInferenceLabel(this.config.executionMode),
      repoMemoryScopeKey: memoryScopeKey,
      routingTrace,
      budget: budget.snapshot()
    };
    return result;
  }

  async prepareEscalation(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation
  ): Promise<ProjectEscalationPlan> {
    const resolved = await this.resolveProject(input);
    const project = resolved.project;
    if (!project) throw new Error('Cloud escalation requires a configured Project.');
    const selection = input.modelSelection ?? project.defaultModel;
    if (selection.mode !== 'local-first') {
      throw new Error('Cloud consultation is only available for Local-first jobs.');
    }

    const stage = escalationStage(escalation);
    if (!project.privacy.cloudAllowed) {
      return {
        stage,
        options: [],
        reasons: ['Project privacy policy does not allow cloud inference. Manual guidance is still available.']
      };
    }

    const localProvider = createLocalInferenceProvider(this.config, this.ollama, this.remoteClient);
    const providerRuntime = this.createProviderRuntime(project, localProvider);
    const { candidates } = await providerRuntime.routingCandidates(project, {
      stage,
      modelSelection: { mode: 'auto' },
      connectionScope: 'cowork'
    });
    const cloudCandidates = candidates.filter(
      (candidate) => candidate.providerKind === 'cloud' && candidate.available
    );
    if (cloudCandidates.length === 0) {
      return {
        stage,
        options: [],
        reasons: ['No configured cloud model is currently available for this Project. Manual guidance is still available.']
      };
    }

    const decision = routeCognitiveStage({
      project,
      stage,
      candidates: cloudCandidates,
      policy: 'deep',
      modelSelection: { mode: 'auto' }
    });
    const scores = new Map(
      decision.considered.map((candidate) => [
        `${candidate.providerId}\0${candidate.modelId}`,
        candidate.score ?? -Infinity
      ])
    );
    const ordered = [...cloudCandidates].sort(
      (a, b) =>
        (scores.get(`${b.providerId}\0${b.modelId}`) ?? -Infinity) -
        (scores.get(`${a.providerId}\0${a.modelId}`) ?? -Infinity)
    );
    const options: ProjectEscalationOption[] = ordered.map((candidate) => ({
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      supportsReasoning: candidate.capabilities?.reasoning === true
    }));
    const recommendedOption = options.find(
      (option) => option.providerId === decision.selected.providerId && option.modelId === decision.selected.modelId
    );

    return {
      stage,
      recommended: recommendedOption
        ? {
            ...recommendedOption,
            reasoningEffort: recommendedOption.supportsReasoning ? 'high' : 'none'
          }
        : undefined,
      options,
      reasons: decision.reasons
    };
  }

  async consultEscalation(
    input: ProjectEngineerInput,
    escalation: LocalEngineerEscalation,
    choice: ProjectEscalationChoice
  ): Promise<ProjectEscalationGuidance> {
    const resolved = await this.resolveProject(input);
    const project = resolved.project;
    if (!project) throw new Error('Cloud escalation requires a configured Project.');
    const plan = await this.prepareEscalation(input, escalation);
    const option = plan.options.find(
      (candidate) => candidate.providerId === choice.providerId && candidate.modelId === choice.modelId
    );
    if (!option) {
      throw new Error(`Escalation target ${choice.providerId}/${choice.modelId} is not available for this Project.`);
    }

    const effort = choice.reasoningEffort ?? (option.supportsReasoning ? 'high' : 'none');
    if (effort !== 'none' && !option.supportsReasoning) {
      throw new Error(`${choice.providerId}/${choice.modelId} does not advertise reasoning support.`);
    }

    const localProvider = createLocalInferenceProvider(this.config, this.ollama, this.remoteClient);
    const providerRuntime = this.createProviderRuntime(project, localProvider);
    const { registry, candidates } = await providerRuntime.routingCandidates(project, {
      stage: plan.stage,
      modelSelection: { mode: 'auto' },
      connectionScope: 'cowork'
    });
    const candidate = candidates.find(
      (item) =>
        item.providerKind === 'cloud' &&
        item.available &&
        item.providerId === option.providerId &&
        item.modelId === option.modelId
    );
    if (!candidate) {
      throw new Error(`Escalation target ${option.providerId}/${option.modelId} became unavailable.`);
    }
    const provider = registry.get(option.providerId);
    const scopedInput = withProjectInstructions(project, input);
    const inference: Omit<InferenceRequest, 'model'> = {
      systemPrompt: ESCALATION_SYSTEM_PROMPT,
      userPrompt: escalationPrompt(scopedInput, escalation),
      stage: plan.stage,
      output: { type: 'text' },
      reasoning: effort === 'none' ? undefined : { effort },
      maxOutputTokens: 4_096,
      timeoutMs: 300_000
    };
    const budget = this.createBudgetSession(project, input.budgetJobId);
    const admission = await budget.authorize(candidate, inference);
    const startedAt = Date.now();

    try {
      const result = await provider.invoke({ ...inference, model: option.modelId });
      if (result.providerId !== option.providerId) {
        throw new Error(
          `Escalation provider identity mismatch: expected ${option.providerId}, received ${result.providerId}.`
        );
      }
      budget.record(plan.stage, candidate, result, false, admission);
      this.routingHistory.record(project, {
        stage: plan.stage,
        candidate,
        outcome: 'success',
        latencyMs: result.latencyMs,
        fallback: false
      });
      return {
        providerId: result.providerId,
        modelId: result.model,
        reasoningEffort: effort,
        content: result.content,
        latencyMs: result.latencyMs,
        usage: result.usage
      };
    } catch (error) {
      budget.releaseAttempt(admission);
      this.routingHistory.record(project, {
        stage: plan.stage,
        candidate,
        outcome: 'error',
        latencyMs: Math.max(0, Date.now() - startedAt),
        fallback: false,
        failureKind: 'fatal'
      });
      throw error;
    }
  }

  private createBudgetSession(project: ProjectDefinition, jobId?: string): ProjectBudgetSession {
    return this.options.budgetSessionFactory?.(project, jobId) ??
      new ProjectBudgetSession(project, undefined, undefined, jobId ? { jobId } : {});
  }

  private createProviderRuntime(
    project: ProjectDefinition,
    localProvider: InferenceProvider
  ): ProjectProviderRuntime {
    const configuredRuntime = this.options.providerRuntime ?? {};
    return new ProjectProviderRuntime({
      ...configuredRuntime,
      metrics: mergeRoutingMetricsSources(
        configuredRuntime.metrics,
        this.routingHistory.forProject(project)
      ),
      localProvider
    });
  }

  private async resolveProject(
    input: ProjectEngineerInput
  ): Promise<{ project?: ProjectDefinition; workspace: string }> {
    if (!input.projectId) {
      if (input.interactionMode === 'chat') return { workspace: '' };
      return { workspace: await resolveWorkspace(input.workspace) };
    }

    const project = this.projects.get(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    if (input.interactionMode === 'chat') return { project, workspace: '' };

    const requestedWorkspace = input.workspace.trim();
    const projectWorkspace = project.workspace.trim();
    const chosenWorkspace = projectWorkspace || requestedWorkspace;
    if (!chosenWorkspace) {
      throw new Error(`Cowork in Project ${project.id} requires a folder for this execution.`);
    }
    const resolvedWorkspace = await resolveWorkspace(chosenWorkspace);
    if (projectWorkspace && requestedWorkspace) {
      const requested = await resolveWorkspace(requestedWorkspace);
      if (requested !== resolvedWorkspace) {
        throw new Error(
          `Project ${project.id} defaults to ${resolvedWorkspace}; refusing workspace ${requested}.`
        );
      }
    }
    return { project, workspace: resolvedWorkspace };
  }
}
