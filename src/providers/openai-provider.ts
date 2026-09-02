import {
  fetchWithProviderErrors,
  readSse,
  redactSecrets,
  type FetchLike
} from './http.js';
import {
  ProviderError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type InferenceUsage,
  type ModelDefinition,
  type ProviderCapabilities,
  type ProviderHealth
} from './types.js';

interface OpenAIModelInfo {
  id: string;
  created?: number;
  owned_by?: string;
  shutdown_date?: string | null;
}

interface OpenAIModelsResponse {
  data?: OpenAIModelInfo[];
}

interface OpenAIUsagePayload {
  input_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

interface OpenAIResponsePayload {
  id?: string;
  model?: string;
  status?: string;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: OpenAIUsagePayload | null;
}

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const providerCapabilities: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

/**
 * OpenAI's /models response does not expose context/output limits. Keep only
 * values that are published as stable model metadata instead of pretending
 * every GPT family has the same window. Unknown models simply omit the fields
 * and the chat runtime falls back conservatively.
 */
function knownModelLimits(modelId: string): Pick<ModelDefinition, 'contextWindow' | 'maxOutputTokens'> {
  if (/^gpt-5\.6(?:-|$)/i.test(modelId)) {
    return { contextWindow: 1_050_000, maxOutputTokens: 128_000 };
  }
  if (modelId.toLowerCase() === 'gpt-5.4-mini') {
    return { contextWindow: 400_000, maxOutputTokens: 128_000 };
  }
  if (/^gpt-5\.5-pro(?:-|$)/i.test(modelId)) {
    return { contextWindow: 1_050_000, maxOutputTokens: 128_000 };
  }
  return {};
}

function normalizeUsage(usage: OpenAIUsagePayload | null | undefined): InferenceUsage {
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens,
    cacheReadInputTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    totalTokens: usage.total_tokens
  };
}

function outputText(payload: OpenAIResponsePayload): string {
  return (payload.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
    .map((content) => content.text)
    .join('');
}

function stopReason(payload: OpenAIResponsePayload): string | undefined {
  if (payload.status === 'incomplete') return payload.incomplete_details?.reason ?? 'incomplete';
  return payload.status;
}

function emitProgress(
  request: InferenceRequest,
  providerId: string,
  state: 'waiting-response' | 'reasoning' | 'generating',
  eventCount: number,
  outputChars: number
): void {
  request.onProgress?.({
    providerId,
    model: request.model,
    state,
    timestamp: new Date().toISOString(),
    eventCount,
    outputChars
  });
}

export class OpenAIInferenceProvider implements InferenceProvider {
  readonly id = 'openai';
  readonly kind = 'cloud' as const;
  readonly capabilities = providerCapabilities;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey.trim()) throw new Error('OpenAI API key is required.');
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async listModels(): Promise<ModelDefinition[]> {
    const response = await fetchWithProviderErrors(
      this.id,
      this.fetchImpl,
      `${this.baseUrl}/models`,
      { method: 'GET', headers: this.headers() },
      this.timeoutMs,
      [this.apiKey]
    );
    const payload = (await response.json()) as OpenAIModelsResponse;
    return (Array.isArray(payload.data) ? payload.data : []).map((model) => ({
      providerId: this.id,
      id: model.id,
      displayName: model.id,
      createdAt: model.created ? new Date(model.created * 1000).toISOString() : undefined,
      ...knownModelLimits(model.id),
      metadata: {
        ownedBy: model.owned_by,
        shutdownDate: model.shutdown_date ?? undefined
      }
    }));
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const models = await this.listModels();
      return {
        providerId: this.id,
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        modelsAvailable: models.length
      };
    } catch (error) {
      return {
        providerId: this.id,
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: request.model,
      instructions: request.systemPrompt,
      input: request.userPrompt,
      store: false,
      stream: Boolean(request.onProgress)
    };

    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    if (request.reasoning?.effort !== undefined) {
      body.reasoning = { effort: request.reasoning.effort };
    }
    if (request.output?.type === 'json_schema') {
      body.text = {
        format: {
          type: 'json_schema',
          name: request.output.name ?? 'local_coder_output',
          strict: request.output.strict ?? true,
          schema: request.output.schema
        }
      };
    }

    emitProgress(request, this.id, 'waiting-response', 0, 0);
    const response = await fetchWithProviderErrors(
      this.id,
      this.fetchImpl,
      `${this.baseUrl}/responses`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body)
      },
      request.timeoutMs ?? this.timeoutMs,
      [this.apiKey]
    );

    if (request.onProgress) return await this.readStream(response, request, started);
    const payload = (await response.json()) as OpenAIResponsePayload;
    this.assertSuccessful(payload);
    return {
      providerId: this.id,
      model: payload.model ?? request.model,
      content: outputText(payload),
      responseId: payload.id,
      stopReason: stopReason(payload),
      latencyMs: Date.now() - started,
      usage: normalizeUsage(payload.usage)
    };
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  private assertSuccessful(payload: OpenAIResponsePayload): void {
    if (payload.status !== 'failed' && !payload.error) return;
    const message = redactSecrets(
      payload.error?.message ?? `OpenAI response failed with status ${payload.status ?? 'unknown'}.`,
      [this.apiKey]
    );
    throw new ProviderError(this.id, message, {
      code: payload.error?.code,
      retryable: false
    });
  }

  private async readStream(
    response: Response,
    request: InferenceRequest,
    started: number
  ): Promise<InferenceResult> {
    let content = '';
    let eventCount = 0;
    let completed: OpenAIResponsePayload | undefined;

    for await (const event of readSse(response)) {
      if (event.data === '[DONE]') break;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      eventCount += 1;
      const type = typeof payload.type === 'string' ? payload.type : event.event;
      if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        content += payload.delta;
        emitProgress(request, this.id, 'generating', eventCount, content.length);
        continue;
      }
      if (typeof type === 'string' && type.includes('reasoning')) {
        emitProgress(request, this.id, 'reasoning', eventCount, content.length);
        continue;
      }
      if (
        (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') &&
        payload.response && typeof payload.response === 'object'
      ) {
        completed = payload.response as OpenAIResponsePayload;
      }
    }

    if (completed) {
      this.assertSuccessful(completed);
      const finalText = outputText(completed);
      return {
        providerId: this.id,
        model: completed.model ?? request.model,
        content: finalText || content,
        responseId: completed.id,
        stopReason: stopReason(completed),
        latencyMs: Date.now() - started,
        usage: normalizeUsage(completed.usage)
      };
    }

    return {
      providerId: this.id,
      model: request.model,
      content,
      latencyMs: Date.now() - started,
      usage: {}
    };
  }
}
