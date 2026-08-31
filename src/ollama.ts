import fs from 'node:fs/promises';
import path from 'node:path';

import { readOllamaChatStream } from './ollama-stream.js';
import { preparePromptForInference } from './planning-policy.js';

import type { LocalCoderConfig } from './config.js';

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string }>;
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
}

function isQwen38(model: string): boolean {
  return /^qwen3\.8(?::|$)/i.test(model);
}

/**
 * Qwen3.8 exposes xhigh as its default maximum reasoning effort, but its current
 * chat template does not accept the literal `high` string. Ollama's native
 * `think: true` lets that template select its default xhigh mode. Keep callers
 * model-agnostic by translating only the maximum-reasoning intent for Qwen3.8.
 */
export function normalizeThinkingForModel(
  model: string,
  think: OllamaThinkingLevel | undefined
): OllamaThinkingLevel | undefined {
  if (isQwen38(model) && think === 'high') return true;
  return think;
}

/**
 * Bounded code generation already receives a planner-owned task, exact editable
 * paths, repository context and host-side validation. Qwen3.8 should still reason,
 * but at low effort so expensive xhigh thinking is reserved for investigation,
 * planning and adversarial review. Legacy/non-thinking models keep their old call.
 */
export function codingThinkingForModel(model: string): OllamaThinkingLevel | undefined {
  return isQwen38(model) ? 'low' : undefined;
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
      availableModels
    };
  }

  async chat(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    runtime: OllamaChatOptions = {}
  ): Promise<OllamaGeneration> {
    return await this.enqueue(async () =>
      await this.withGlobalInferenceLock(async () => {
        const model = runtime.model ?? this.config.model;
        const strongModel = this.config.strongModel ?? this.config.model;
        const keepAlive =
          runtime.keepAlive ??
          (model === strongModel
            ? this.config.strongModelKeepAlive ?? '30s'
            : this.config.fastModelKeepAlive ?? '90s');
        const think = normalizeThinkingForModel(model, runtime.think);
        const preparedPrompt = preparePromptForInference(
          systemPrompt,
          userPrompt,
          runtime.numCtx ?? this.config.ollamaNumCtx ?? 16_384
        );
        const timeouts = this.inferenceTimeouts();

        // The lock is shared by every local-coder MCP process. Once held, inspect Ollama's
        // actual loaded-model state so a second Claude Code session cannot leave the other
        // tier resident while this process starts a new inference.
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
                num_ctx: runtime.numCtx ?? this.config.ollamaNumCtx ?? 16_384
              }
            })
          },
          timeouts.headerMs
        );

        // The header timer is cleared as soon as Ollama accepts the streaming request.
        // Stream liveness is then governed independently: a cold/thinking model gets a
        // generous first-chunk window, active chunks reset the idle timer, and a hard cap
        // still prevents a genuinely runaway inference from occupying the GPU forever.
        const generation = await readOllamaChatStream(response, model, {
          firstChunkTimeoutMs: timeouts.firstChunkMs,
          idleTimeoutMs: timeouts.idleMs,
          maxDurationMs: timeouts.maxDurationMs
        });
        await this.recordInference(generation);
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
    // The lock must never be considered stale while a valid long inference is still
    // allowed to run. Keep its stale threshold beyond the absolute inference cap.
    const maxInferenceMs = this.config.inferenceMaxDurationMs ?? 1_800_000;
    const staleAfterMs = Math.max(
      maxInferenceMs + 120_000,
      this.config.requestTimeoutMs + 60_000,
      300_000
    );
    const deadline = Date.now() + staleAfterMs * 2;
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

  private async recordInference(generation: OllamaGeneration): Promise<void> {
    if (!this.config.telemetryEnabled) return;

    try {
      await fs.mkdir(path.dirname(this.config.telemetryPath), { recursive: true });
      await fs.appendFile(
        this.config.telemetryPath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          kind: 'inference',
          status: 'success',
          model: generation.model,
          promptTokens: generation.promptTokens,
          completionTokens: generation.completionTokens,
          generationDurationMs: generation.totalDurationNs
            ? generation.totalDurationNs / 1_000_000
            : 0
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
      // Important: do not abort the response body after headers arrive. The stream
      // reader owns liveness/absolute timeouts from this point forward.
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
