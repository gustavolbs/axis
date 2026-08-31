import fs from 'node:fs/promises';
import path from 'node:path';

import {
  readOllamaChatStream,
  type OllamaStreamProgress,
  type OllamaStreamProgressReporter
} from './ollama-stream.js';
import { preparePromptForInference } from './planning-policy.js';
import { reportProgress } from './progress-context.js';

import type { LocalCoderConfig } from './config.js';

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

type RuntimeStage =
  | 'analysis'
  | 'investigation'
  | 'planning'
  | 'implementation'
  | 'review'
  | 'report'
  | 'repo-learning'
  | 'other';

interface StageBudget {
  stage: RuntimeStage;
  maxDurationMs?: number;
  maxTokens?: number;
}

export interface OllamaHealth {
  ok: boolean;
  baseUrl: string;
  configuredModel: string;
  modelAvailable: boolean;
  fastModel: string;
  fastModelAvailable: boolean;
  strongModel: string;
  strongModelAvailable: boolean;
  adaptiveModelsEnabled: boolean;
  numCtx: number;
  maxParallelInferences: 1;
  globalInferenceLock: true;
  inferenceTimeouts: {
    headerMs: number;
    firstChunkMs: number;
    idleMs: number;
    maxDurationMs: number;
  };
  stageBudgets: Record<string, { maxDurationMs?: number; maxTokens?: number }>;
  availableModels: string[];
}

export interface OllamaGeneration {
  content: string;
  model: string;
  doneReason?: string;
  totalDurationNs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export type OllamaThinkingLevel = boolean | 'low' | 'medium' | 'high';

export interface OllamaChatOptions {
  model?: string;
  numCtx?: number;
  keepAlive?: string | number;
  /** Model-agnostic thinking intent. The client adapts it to model-specific templates. */
  think?: OllamaThinkingLevel;
  /** Optional caller override. The stage policy still cannot exceed the global hard cap. */
  maxDurationMs?: number;
  /** Optional Ollama num_predict override. */
  maxTokens?: number;
  /** Safe progress metadata only; hidden reasoning text is never surfaced. */
  onStreamProgress?: OllamaStreamProgressReporter;
}

function isQwen38(model: string): boolean {
  return /^qwen3\.8(?::|$)/i.test(model);
}

function classifyRuntimeStage(systemPrompt: string): RuntimeStage {
  const prompt = systemPrompt.toLowerCase();
  if (prompt.includes('pre-implementation impact analysis')) return 'analysis';
  if (prompt.includes('investigation stage of a local software-engineering agent')) {
    return 'investigation';
  }
  if (prompt.includes('reasoning/planning stage of a local software-engineering agent')) {
    return 'planning';
  }
  if (prompt.includes('read-only repository research reporter')) {
    return 'report';
  }
  if (prompt.includes('adversarial software-engineering reviewer')) {
    return 'review';
  }
  if (prompt.includes('durable repository intelligence')) {
    return 'repo-learning';
  }
  if (prompt.includes('local coding execution model') || prompt.includes('local coding executor')) {
    return 'implementation';
  }
  return 'other';
}

function stageBudget(config: LocalCoderConfig, stage: RuntimeStage): StageBudget {
  switch (stage) {
    case 'analysis':
      return {
        stage,
        maxDurationMs: config.investigationMaxDurationMs ?? 300_000,
        maxTokens: config.investigationMaxTokens ?? 2_048
      };
    case 'investigation':
      return {
        stage,
        maxDurationMs: config.investigationMaxDurationMs ?? 300_000,
        maxTokens: config.investigationMaxTokens ?? 2_048
      };
    case 'planning':
      return {
        stage,
        maxDurationMs: config.planningMaxDurationMs ?? 600_000,
        maxTokens: config.planningMaxTokens ?? 3_072
      };
    case 'review':
      return {
        stage,
        maxDurationMs: config.reviewMaxDurationMs ?? 600_000,
        maxTokens: config.reviewMaxTokens ?? 3_072
      };
    case 'report':
      return {
        stage,
        maxDurationMs: config.reportMaxDurationMs ?? 480_000,
        maxTokens: config.reportMaxTokens ?? 3_072
      };
    case 'repo-learning':
      return {
        stage,
        maxDurationMs: config.repoLearningMaxDurationMs ?? 300_000,
        maxTokens: config.repoLearningMaxTokens ?? 2_048
      };
    default:
      return { stage };
  }
}

export function normalizeThinkingForModel(
  model: string,
  think: OllamaThinkingLevel | undefined
): OllamaThinkingLevel | undefined {
  if (isQwen38(model) && think === 'high') return true;
  return think;
}

function stageThinking(
  model: string,
  stage: RuntimeStage,
  requested: OllamaThinkingLevel | undefined
): OllamaThinkingLevel | undefined {
  if (
    isQwen38(model) &&
    (stage === 'analysis' || stage === 'investigation') &&
    requested === 'high'
  ) {
    return 'medium';
  }
  return normalizeThinkingForModel(model, requested);
}

export function codingThinkingForModel(model: string): OllamaThinkingLevel | undefined {
  return isQwen38(model) ? 'low' : undefined;
}

function progressAction(stage: RuntimeStage, progress: OllamaStreamProgress): string {
  const label =
    stage === 'analysis' ? 'impact analysis' : stage === 'other' ? 'model' : stage;
  return progress.state === 'thinking'
    ? `Qwen is actively reasoning for ${label}`
    : `Qwen is generating the ${label} result`;
}

export class OllamaClient {
  private inferenceTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: LocalCoderConfig) {}

  private inferenceTimeouts() {
    return {
      headerMs: this.config.inferenceHeaderTimeoutMs ?? 180_000,
      firstChunkMs: this.config.inferenceFirstChunkTimeoutMs ?? 600_000,
      idleMs: this.config.inferenceIdleTimeoutMs ?? 300_000,
      maxDurationMs: this.config.inferenceMaxDurationMs ?? 1_800_000
    };
  }

  private stageBudgets() {
    const stages: RuntimeStage[] = [
      'analysis',
      'investigation',
      'planning',
      'review',
      'report',
      'repo-learning'
    ];
    return Object.fromEntries(
      stages.map((stage) => {
        const budget = stageBudget(this.config, stage);
        return [stage, { maxDurationMs: budget.maxDurationMs, maxTokens: budget.maxTokens }];
      })
    );
  }

  async health(): Promise<OllamaHealth> {
    const response = await this.request('/api/tags', { method: 'GET' });
    const payload = (await response.json()) as OllamaTagsResponse;
    const availableModels = (payload.models ?? [])
      .map((entry) => entry.model ?? entry.name)
      .filter((value): value is string => Boolean(value));
    const fastModel = this.config.model;
    const strongModel = this.config.strongModel ?? fastModel;

    return {
      ok: true,
      baseUrl: this.config.ollamaBaseUrl,
      configuredModel: fastModel,
      modelAvailable: availableModels.includes(fastModel),
      fastModel,
      fastModelAvailable: availableModels.includes(fastModel),
      strongModel,
      strongModelAvailable: availableModels.includes(strongModel),
      adaptiveModelsEnabled: this.config.adaptiveModelsEnabled ?? false,
      numCtx: this.config.ollamaNumCtx ?? 16_384,
      maxParallelInferences: 1,
      globalInferenceLock: true,
      inferenceTimeouts: this.inferenceTimeouts(),
      stageBudgets: this.stageBudgets(),
      availableModels
    };
  }

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime: OllamaChatOptions = {}
  ): Promise<OllamaGeneration> {
    const stage = classifyRuntimeStage(systemPrompt);
    const budget = stageBudget(this.config, stage);
    reportProgress({
      action: `Waiting for the local inference slot (${stage})`,
      reasoningSummary:
        'The request is queued behind any active local model call. No Claude tokens are being used while it waits.'
    });

    return await this.enqueue(async () =>
      await this.withGlobalInferenceLock(async () => {
        const model = runtime.model ?? this.config.model;
        const strongModel = this.config.strongModel ?? this.config.model;
        const keepAlive =
          runtime.keepAlive ??
          (model === strongModel
            ? this.config.strongModelKeepAlive ?? '30s'
            : this.config.fastModelKeepAlive ?? '90s');
        const think = stageThinking(model, stage, runtime.think);
        const preparedPrompt = preparePromptForInference(
          systemPrompt,
          userPrompt,
          runtime.numCtx ?? this.config.ollamaNumCtx ?? 16_384
        );
        const timeouts = this.inferenceTimeouts();
        const maxDurationMs = Math.max(
          1,
          Math.min(
            timeouts.maxDurationMs,
            runtime.maxDurationMs ?? budget.maxDurationMs ?? timeouts.maxDurationMs
          )
        );
        const maxTokens = runtime.maxTokens ?? budget.maxTokens;

        reportProgress({
          action: `Inference slot acquired; preparing ${model}`,
          reasoningSummary: budget.maxDurationMs
            ? `${stage} has a ${Math.round(maxDurationMs / 60_000)} minute wall-clock budget${maxTokens ? ` and ${maxTokens} generated-token budget` : ''}.`
            : 'The model is being prepared for a bounded local inference.'
        });

        await this.unloadOtherConfiguredTier(model);

        const response = await this.requestStreamingHeaders(
          '/api/chat',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              stream: true,
              keep_alive: keepAlive,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: preparedPrompt.userPrompt }
              ],
              ...(format ? { format } : {}),
              ...(think !== undefined ? { think } : {}),
              options: {
                temperature: format ? 0 : 0.2,
                num_ctx: runtime.numCtx ?? this.config.ollamaNumCtx ?? 16_384,
                ...(maxTokens ? { num_predict: maxTokens } : {})
              }
            })
          },
          timeouts.headerMs
        );

        reportProgress({
          action: 'Ollama accepted the request; waiting for Qwen stream activity',
          reasoningSummary:
            'Headers are back from Ollama. The worker is now watching stream liveness and will distinguish active thinking from answer generation.'
        });

        let lastUiReportAt = 0;
        const streamReporter: OllamaStreamProgressReporter = (progress) => {
          runtime.onStreamProgress?.(progress);
          const now = Date.now();
          if (now - lastUiReportAt < 750) return;
          lastUiReportAt = now;
          reportProgress({
            action: progressAction(stage, progress),
            detail: `${progress.chunkCount} stream chunks · ${progress.thinkingChars} hidden-thinking chars observed · ${progress.outputChars} output chars`,
            reasoningSummary:
              progress.state === 'thinking'
                ? 'The model is not stalled: hidden reasoning chunks are actively arriving. Their content is intentionally not exposed.'
                : 'The model has moved from internal reasoning to generating the structured stage result.'
          });
        };

        const generation = await readOllamaChatStream(
          response,
          model,
          {
            firstChunkTimeoutMs: Math.min(timeouts.firstChunkMs, maxDurationMs),
            idleTimeoutMs: Math.min(timeouts.idleMs, maxDurationMs),
            maxDurationMs
          },
          streamReporter
        );
        await this.recordInference(generation, stage);
        return generation;
      })
    );
  }

  private async enqueue<T>(run: () => Promise<T>): Promise<T> {
    const current = this.inferenceTail.then(run, run);
    this.inferenceTail = current.then(
      () => undefined,
      () => undefined
    );
    return await current;
  }

  private async withGlobalInferenceLock<T>(run: () => Promise<T>): Promise<T> {
    const lockPath = path.join(path.dirname(this.config.telemetryPath), 'inference.lock');
    const maxInferenceMs = this.config.inferenceMaxDurationMs ?? 1_800_000;
    const staleAfterMs = Math.max(
      maxInferenceMs + 120_000,
      this.config.requestTimeoutMs + 60_000,
      300_000
    );
    const deadline = Date.now() + staleAfterMs * 2;
    let lastWaitReportAt = 0;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            'utf8'
          );
          return await run();
        } finally {
          await handle.close().catch(() => undefined);
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleAfterMs) {
            await fs.rm(lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }

        const now = Date.now();
        if (now - lastWaitReportAt >= 2_000) {
          lastWaitReportAt = now;
          reportProgress({
            action: 'Waiting for the machine-wide Qwen inference lock',
            reasoningSummary:
              'Another Local Coder session currently owns the GPU/model slot. This job is healthy and queued locally.'
          });
        }

        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for the machine-wide local-coder inference lock at ${lockPath}.`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private async unloadOtherConfiguredTier(requestedModel: string): Promise<void> {
    const fastModel = this.config.model;
    const strongModel = this.config.strongModel ?? fastModel;
    const otherModel = requestedModel === fastModel ? strongModel : fastModel;
    if (otherModel === requestedModel) return;

    const loaded = await this.loadedModelsUnlocked();
    if (loaded.includes(otherModel)) {
      reportProgress({ action: `Unloading inactive model tier ${otherModel}` });
      await this.unloadUnlocked(otherModel);
    }
  }

  private async loadedModelsUnlocked(): Promise<string[]> {
    const response = await this.request('/api/ps', { method: 'GET' });
    const payload = (await response.json()) as OllamaPsResponse;
    return (payload.models ?? [])
      .map((entry) => entry.model ?? entry.name)
      .filter((value): value is string => Boolean(value));
  }

  private async unloadUnlocked(model: string): Promise<void> {
    await this.request('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 })
    });
  }

  private async recordInference(generation: OllamaGeneration, stage: RuntimeStage): Promise<void> {
    if (!this.config.telemetryEnabled) return;

    try {
      await fs.mkdir(path.dirname(this.config.telemetryPath), { recursive: true });
      await fs.appendFile(
        this.config.telemetryPath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          kind: 'inference',
          status: 'success',
          stage,
          model: generation.model,
          promptTokens: generation.promptTokens,
          completionTokens: generation.completionTokens,
          generationDurationMs: generation.totalDurationNs
            ? generation.totalDurationNs / 1_000_000
            : 0,
          tokensPerSecond:
            generation.totalDurationNs && generation.completionTokens
              ? generation.completionTokens / (generation.totalDurationNs / 1_000_000_000)
              : undefined
        })}\n`,
        'utf8'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`local-coder inference telemetry write failed: ${message}`);
    }
  }

  private async requestStreamingHeaders(
    pathname: string,
    init: RequestInit,
    headerTimeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, headerTimeoutMs));
    let response: Response;

    try {
      response = await fetch(`${this.config.ollamaBaseUrl}${pathname}`, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Ollama did not return streaming response headers within ${headerTimeoutMs}ms.`
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not reach Ollama at ${this.config.ollamaBaseUrl}. Ensure Ollama is running. ${message}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama HTTP ${response.status}: ${body || response.statusText}`);
    }

    return response;
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    let response: Response;

    try {
      response = await fetch(`${this.config.ollamaBaseUrl}${pathname}`, {
        ...init,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not reach Ollama at ${this.config.ollamaBaseUrl}. Ensure Ollama is running. ${message}`
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama HTTP ${response.status}: ${body || response.statusText}`);
    }

    return response;
  }
}
