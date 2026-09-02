import { isCancellationError } from './cancellation.js';
import type { RoutingBlastRadius, RoutingUrgency } from './cognitive-router.js';
import { classifyInferenceStage, type InferenceStage } from './inference-status.js';
import type {
  OllamaChatOptions,
  OllamaClient,
  OllamaGeneration,
  OllamaThinkingLevel
} from './ollama.js';
import type { OllamaStreamProgress } from './ollama-stream.js';
import type { BudgetAdmission, ProjectBudgetSession } from './project-budget.js';
import type { ModelSelection, ProjectDefinition, RoutingPolicy } from './project-store.js';
import {
  ProjectProviderRuntime,
  type RoutingCatalogOptions
} from './project-provider-runtime.js';
import {
  RoutedInferenceRuntime,
  type FallbackConfirmation,
  type RoutedInferenceAttemptObservation,
  type RoutedInferenceAttemptObserver,
  type RoutedInferenceResult
} from './routed-inference.js';
import type { InferenceRequest, ReasoningEffort } from './providers/types.js';

export type LegacyAgentChatClient = Pick<OllamaClient, 'chat'>;
export type ProjectRouteEvent = Pick<
  RoutedInferenceResult,
  'routing' | 'attempts' | 'fallbackUsed'
> & { stage: InferenceStage };

export interface ProjectRoutedChatOptions {
  policy?: RoutingPolicy;
  modelSelection?: ModelSelection;
  reasoningEffort?: ReasoningEffort;
  urgency?: RoutingUrgency;
  complexityScore?: number;
  blastRadius?: RoutingBlastRadius;
  connectionScope?: 'chat' | 'cowork';
  confirmFallback?: FallbackConfirmation;
  budget?: ProjectBudgetSession;
  onRoute?: (result: ProjectRouteEvent) => void;
  onAttemptComplete?: RoutedInferenceAttemptObserver;
}

function reasoningEffort(think: OllamaThinkingLevel | undefined): ReasoningEffort | undefined {
  if (think === undefined) return undefined;
  if (think === false) return 'none';
  if (think === true) return 'high';
  return think;
}

function localThinkingLevel(effort: ReasoningEffort): OllamaThinkingLevel {
  if (effort === 'none') return false;
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  return 'high';
}

function outputFormat(
  format: 'json' | Record<string, unknown> | undefined,
  stage: string
) {
  if (!format || format === 'json') return { type: 'text' as const };
  return {
    type: 'json_schema' as const,
    schema: format,
    name: `local_coder_${stage.replace(/[^a-z0-9_]+/gi, '_').toLowerCase()}`,
    strict: true
  };
}

function safeStreamProgress(
  startedAt: number,
  progress: {
    state: 'waiting-response' | 'reasoning' | 'generating';
    timestamp: string;
    eventCount: number;
    outputChars: number;
  }
): OllamaStreamProgress {
  return {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    chunkCount: progress.eventCount,
    thinkingChars: 0,
    outputChars: progress.outputChars,
    state: progress.state === 'generating' ? 'generating' : 'thinking',
    lastActivityAt: progress.timestamp
  };
}

function isStrictLegacyLocal(project: ProjectDefinition): boolean {
  const exact = new Set([
    ...project.connectionPolicy.chat.allowedConnectionIds,
    ...project.connectionPolicy.inference.allowedConnectionIds
  ]);
  return (
    project.privacy.cloudAllowed === false &&
    exact.size === 1 &&
    exact.has('ollama')
  );
}

function budgetCandidateKey(candidate: { providerId: string; modelId: string }): string {
  return `${candidate.providerId}\0${candidate.modelId}`;
}

export class ProjectRoutedChatClient implements LegacyAgentChatClient {
  constructor(
    private readonly project: ProjectDefinition,
    private readonly providers: ProjectProviderRuntime,
    private readonly legacyLocal: LegacyAgentChatClient,
    private readonly options: ProjectRoutedChatOptions = {}
  ) {}

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime: OllamaChatOptions = {}
  ): Promise<OllamaGeneration> {
    const stage = classifyInferenceStage(systemPrompt);
    const selectedEffort = this.options.reasoningEffort ?? reasoningEffort(runtime.think);
    const routedThink = this.options.reasoningEffort === undefined
      ? runtime.think
      : localThinkingLevel(this.options.reasoningEffort);

    if (isStrictLegacyLocal(this.project)) {
      const selection = this.options.modelSelection;
      const explicit = selection?.mode === 'explicit' ? selection : undefined;
      const localFirst = selection?.mode === 'local-first' ? selection : undefined;
      if (explicit && explicit.providerId !== 'ollama') {
        throw new Error(
          `Local-only Project ${this.project.id} cannot execute explicit connection ${explicit.providerId}.`
        );
      }
      const modelId = localFirst?.modelId ?? explicit?.modelId ?? runtime.model ?? 'ollama-local';
      const effectiveRuntime: OllamaChatOptions = {
        ...runtime,
        model: modelId,
        think: routedThink
      };
      const candidate = {
        providerId: 'ollama',
        providerKind: 'local' as const,
        modelId,
        available: true
      };
      const startedAt = Date.now();
      try {
        const generation = await this.legacyLocal.chat(systemPrompt, userPrompt, format, effectiveRuntime);
        this.options.budget?.recordLocalGeneration(stage, generation.model, generation);
        await this.observe({
          candidate: { ...candidate, modelId: generation.model },
          stage,
          fallback: false,
          outcome: 'success',
          latencyMs: Math.max(0, Date.now() - startedAt)
        });
        return generation;
      } catch (error) {
        if (!isCancellationError(error)) {
          await this.observe({
            candidate,
            stage,
            fallback: false,
            outcome: 'error',
            latencyMs: Math.max(0, Date.now() - startedAt),
            failureKind: 'fatal'
          });
        }
        throw error;
      }
    }

    const catalogOptions: RoutingCatalogOptions = {
      stage,
      localModelHint: runtime.model,
      modelSelection: this.options.modelSelection ?? this.project.defaultModel,
      connectionScope: this.options.connectionScope ?? 'cowork'
    };
    const { registry, candidates: rawCandidates } = await this.providers.routingCandidates(
      this.project,
      catalogOptions
    );
    if (rawCandidates.length === 0) {
      throw new Error(
        `Project ${this.project.id} has no configured/available ${catalogOptions.connectionScope} model candidates for ${stage}.`
      );
    }

    const startedAt = Date.now();
    const inference: Omit<InferenceRequest, 'model'> = {
      systemPrompt,
      userPrompt,
      stage,
      output: outputFormat(format, stage),
      reasoning: selectedEffort === undefined ? undefined : { effort: selectedEffort },
      maxOutputTokens: runtime.maxTokens,
      timeoutMs: runtime.maxDurationMs,
      providerOptions: {
        ollama: {
          numCtx: runtime.numCtx,
          keepAlive: runtime.keepAlive,
          think: routedThink
        }
      },
      onProgress: runtime.onStreamProgress
        ? (progress) => runtime.onStreamProgress?.(safeStreamProgress(startedAt, progress))
        : undefined
    };
    const candidates = this.options.budget
      ? this.options.budget.annotateCandidates(rawCandidates, inference)
      : rawCandidates;
    const admissions = new Map<string, BudgetAdmission>();
    const routed = new RoutedInferenceRuntime(registry);
    const result = await routed.invoke({
      inference,
      routing: {
        project: this.project,
        stage,
        candidates,
        policy: this.options.policy,
        modelSelection: this.options.modelSelection,
        urgency: this.options.urgency,
        complexityScore: this.options.complexityScore,
        blastRadius: this.options.blastRadius,
        requireReasoning: selectedEffort !== undefined && selectedEffort !== 'none',
        requireStructuredOutput: format !== undefined && format !== 'json'
      },
      confirmFallback: this.options.confirmFallback,
      authorizeAttempt: this.options.budget
        ? async ({ candidate }) => {
            const admission = await this.options.budget!.authorize(candidate, inference);
            admissions.set(budgetCandidateKey(candidate), admission);
          }
        : undefined,
      onAttemptFailure: this.options.budget
        ? ({ candidate }) => {
            const key = budgetCandidateKey(candidate);
            const admission = admissions.get(key);
            if (admission) this.options.budget!.releaseAttempt(admission);
            admissions.delete(key);
          }
        : undefined,
      onAttemptComplete: this.options.onAttemptComplete
    });

    const selectedCandidate = candidates.find(
      (candidate) =>
        candidate.providerId === result.routing.selected.providerId &&
        candidate.modelId === result.routing.selected.modelId
    );
    if (!selectedCandidate) {
      throw new Error(
        `Routed selection ${result.routing.selected.providerId}/${result.routing.selected.modelId} is missing from its candidate catalog.`
      );
    }
    const selectedAdmission = admissions.get(budgetCandidateKey(selectedCandidate));
    if (this.options.budget && !selectedAdmission) {
      throw new Error(
        `Budget admission is missing for routed selection ${selectedCandidate.providerId}/${selectedCandidate.modelId}.`
      );
    }
    if (result.result.providerId !== selectedCandidate.providerId) {
      if (selectedAdmission) this.options.budget?.releaseAttempt(selectedAdmission);
      throw new Error(
        `Routed provider identity mismatch: selected ${selectedCandidate.providerId}, returned ${result.result.providerId}.`
      );
    }
    this.options.budget?.record(
      stage,
      selectedCandidate,
      result.result,
      result.fallbackUsed,
      selectedAdmission
    );

    this.options.onRoute?.({
      stage,
      routing: result.routing,
      attempts: result.attempts,
      fallbackUsed: result.fallbackUsed
    });

    return {
      content: result.result.content,
      model: result.result.model,
      doneReason: result.result.stopReason,
      totalDurationNs: Math.max(0, result.result.latencyMs) * 1_000_000,
      promptTokens: result.result.usage.inputTokens,
      completionTokens: result.result.usage.outputTokens
    };
  }

  private async observe(observation: RoutedInferenceAttemptObservation): Promise<void> {
    if (!this.options.onAttemptComplete) return;
    try {
      await this.options.onAttemptComplete(observation);
    } catch {
      // History/calibration is advisory and must never alter the agent call result.
    }
  }
}
