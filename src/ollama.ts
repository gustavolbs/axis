import type { LocalCoderConfig } from './config.js';

interface OllamaTagsResponse {
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

export class OllamaClient {
  constructor(private readonly config: LocalCoderConfig) {}

  async health(): Promise<OllamaHealth> {
    const response = await this.request('/api/tags', { method: 'GET' });
    const payload = (await response.json()) as OllamaTagsResponse;
    const availableModels = (payload.models ?? [])
      .map((entry) => entry.model ?? entry.name)
      .filter((value): value is string => Boolean(value));

    return {
      ok: true,
      baseUrl: this.config.ollamaBaseUrl,
      configuredModel: this.config.model,
      modelAvailable: availableModels.includes(this.config.model),
      availableModels
    };
  }

  async chat(systemPrompt: string, userPrompt: string): Promise<OllamaGeneration> {
    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        options: {
          temperature: 0.2
        }
      })
    });

    const payload = (await response.json()) as OllamaChatResponse;
    const content = payload.message?.content?.trim();

    if (!content) {
      throw new Error('Ollama returned an empty assistant message.');
    }

    return {
      content,
      model: payload.model ?? this.config.model,
      doneReason: payload.done_reason,
      totalDurationNs: payload.total_duration,
      promptTokens: payload.prompt_eval_count,
      completionTokens: payload.eval_count
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;

    try {
      response = await fetch(`${this.config.ollamaBaseUrl}${path}`, {
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
