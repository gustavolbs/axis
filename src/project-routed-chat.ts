import type { RoutingBlastRadius, RoutingUrgency } from './cognitive-router.js';
import { classifyInferenceStage } from './inference-status.js';
import type {
  OllamaChatOptions,
  OllamaClient,
  OllamaGeneration,
  OllamaThinkingLevel
} from './ollama.js';
import type { OllamaStreamProgress } from './ollama-stream.js';
import type { ModelSelection, ProjectDefinition, RoutingPolicy } from './project-store.js';
import {
  ProjectProviderRuntime,
  type RoutingCatalogOptions
} from './project-provider-runtime.js';
import {
  RoutedInferenceRuntime,
  type FallbackConfirmation,
  type RoutedInferenceResult
} from './routed-inference.js';
import type { ReasoningEffort } from './providers/types.js';

export type LegacyAgentChatClient = Pick<OllamaClient, 'chat'>;

export interface ProjectRoutedChatOptions {
  policy?: RoutingPolicy;
  modelSelection?: ModelSelection;
  urgency?: RoutingUrgency;
  complexityScore?: number;
  blastRadius?: RoutingBlastRadius;
  confirmFallback?: FallbackConfirmation;
  onRoute?: (result: Pick<RoutedInferenceResult, 'routing' | 'attempts' | 'fallbackUsed'>) => void;
}

function reasoningEffort(think: OllamaThinkingLevel | undefined): ReasoningEffort | undefined {
  if (think === undefined) return undefined;
  if (think === false) return 'none';
  if (think === true) return 'high';
  return think;
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
    // Hidden reasoning content is never transported through the provider contract.
    thinkingChars: 0,
    outputChars: progress.outputChars,
    state: progress.state === 'generating' ? 'generating' : 'thinking',
    lastActivityAt: progress.timestamp
  };
}

function isStrictLegacyLocal(project: ProjectDefinition): boolean {
  return (
    project.privacy.cloudAllowed === false &&
    project.privacy.allowedProviderIds.length === 1 &&
    project.privacy.allowedProviderIds[0] === 'ollama'
  );
}

/**
 * Structural adapter for the current Agent Runtime. Existing stages can keep calling
 * `.chat(...)` while project-aware jobs route each call independently. A strictly
 * Local-only project bypasses the new provider layer entirely, preserving the v0.14
 * Ollama fast/strong/numCtx/keepAlive behavior byte-for-byte at the call boundary.
 */
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
    if (isStrictLegacyLocal(this.project)) {
      return await this.legacyLocal.chat(systemPrompt, userPrompt, format, runtime);
    }

    const stage = classifyInferenceStage(systemPrompt);
    const catalogOptions: RoutingCatalogOptions = {
      stage,
      localModelHint: runtime.model,
      modelSelection: this.options.modelSelection ?? this.project.defaultModel
    };
    const { registry, candidates } = await this.providers.routingCandidates(
      this.project,
      catalogOptions
    );
    if (candidates.length === 0) {
      throw new Error(
        `Project ${this.project.id} has no configured/available model candidates for ${stage}.`
      );
    }

    const startedAt = Date.now();
    const routed = new RoutedInferenceRuntime(registry);
    const result = await routed.invoke({
      inference: {
        systemPrompt,
        userPrompt,
        stage,
        output: outputFormat(format, stage),
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
          ? (progress) => runtime.onStreamProgress?.(safeStreamProgress(startedAt, progress))
          : undefined
      },
      routing: {
        project: this.project,
        stage,
        candidates,
        policy: this.options.policy,
        modelSelection: this.options.modelSelection,
        urgency: this.options.urgency,
        complexityScore: this.options.complexityScore,
        blastRadius: this.options.blastRadius,
        requireReasoning: runtime.think !== false && runtime.think !== undefined,
        requireStructuredOutput: format !== undefined && format !== 'json'
      },
      confirmFallback: this.options.confirmFallback
    });

    this.options.onRoute?.({
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
}
