import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalCoderConfig } from './config.js';

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
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
  /** Ollama native thinking control for reasoning-capable models. */
  think?: OllamaThinkingLevel;
}

export class OllamaClient {
  private inferenceTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: LocalCoderConfig) {}

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

        // The lock is shared by every local-coder MCP process. Once held, inspect Ollama's
        // actual loaded-model state so a second Claude Code session cannot leave the other
        // tier resident while this process starts a new inference.
        await this.unloadOtherConfiguredTier(model);

        const response = await this.request('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            keep_alive: keepAlive,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            ...(format ? { format } : {}),
            ...(runtime.think !== undefined ? { think: runtime.think } : {}),
            options: {
              temperature: format ? 0 : 0.2,
              num_ctx: runtime.numCtx ?? this.config.ollamaNumCtx ?? 16_384
            }
          })
        });

        const payload = (await response.json()) as OllamaChatResponse;
        const content = payload.message?.content?.trim();

        if (!content) {
          throw new Error('Ollama returned an empty assistant message.');
        }

        const generation: OllamaGeneration = {
          content,
          model: payload.model ?? model,
          doneReason: payload.done_reason,
          totalDurationNs: payload.total_duration,
          promptTokens: payload.prompt_eval_count,
          completionTokens: payload.eval_count
        };

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
    const staleAfterMs = Math.max(this.config.requestTimeoutMs + 60_000, 300_000);
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
