import {
  fetchWithProviderErrors,
  readSse,
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
  type ProviderHealth,
  type ReasoningEffort
} from './types.js';

interface AnthropicSupportFlag {
  supported?: boolean;
}

interface AnthropicThinkingCapabilities extends AnthropicSupportFlag {
  types?: Record<string, AnthropicSupportFlag>;
}

interface AnthropicEffortCapabilities extends AnthropicSupportFlag {
  low?: AnthropicSupportFlag;
  medium?: AnthropicSupportFlag;
  high?: AnthropicSupportFlag;
  xhigh?: AnthropicSupportFlag;
  max?: AnthropicSupportFlag;
}

interface AnthropicModelCapabilities {
  structured_outputs?: AnthropicSupportFlag;
  thinking?: AnthropicThinkingCapabilities;
  effort?: AnthropicEffortCapabilities;
  [key: string]: unknown;
}

interface AnthropicModelInfo {
  id: string;
  display_name?: string;
  created_at?: string;
  max_input_tokens?: number | null;
  max_tokens?: number | null;
  capabilities?: AnthropicModelCapabilities | null;
}

interface AnthropicModelsResponse {
  data?: AnthropicModelInfo[];
  has_more?: boolean;
  last_id?: string | null;
}

interface AnthropicUsagePayload {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: string }>;
  usage?: AnthropicUsagePayload;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
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

function normalizeUsage(usage: AnthropicUsagePayload | undefined): InferenceUsage {
  if (!usage) return {};
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const uncachedInput = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const hasInput =
    usage.input_tokens !== undefined ||
    usage.cache_read_input_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined;
  return {
    inputTokens: hasInput ? uncachedInput + cacheRead + cacheWrite : undefined,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    cacheWriteInputTokens: usage.cache_creation_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens,
    totalTokens: hasInput || usage.output_tokens !== undefined
      ? uncachedInput + cacheRead + cacheWrite + output
      : undefined
  };
}

function mergeUsage(current: AnthropicUsagePayload, next: AnthropicUsagePayload | undefined): void {
  if (!next) return;
  if (next.input_tokens !== undefined) current.input_tokens = next.input_tokens;
  if (next.cache_creation_input_tokens !== undefined) {
    current.cache_creation_input_tokens = next.cache_creation_input_tokens;
  }
  if (next.cache_read_input_tokens !== undefined) {
    current.cache_read_input_tokens = next.cache_read_input_tokens;
  }
  if (next.output_tokens !== undefined) current.output_tokens = next.output_tokens;
  if (next.output_tokens_details?.thinking_tokens !== undefined) {
    current.output_tokens_details = {
      thinking_tokens: next.output_tokens_details.thinking_tokens
    };
  }
}

function supports(flag: AnthropicSupportFlag | undefined): boolean {
  return flag?.supported === true;
}

function modelCapabilities(info: AnthropicModelInfo): Partial<ProviderCapabilities> {
  return {
    structuredOutput: supports(info.capabilities?.structured_outputs),
    reasoning: supports(info.capabilities?.thinking),
    modelDiscovery: true,
    streaming: true,
    promptCaching: true,
    toolUse: true
  };
}

function manualThinkingBudget(effort: ReasoningEffort, maxTokens: number): number {
  const target =
    effort === 'low' ? 1_024
      : effort === 'medium' ? 2_048
        : effort === 'high' ? 4_096
          : effort === 'xhigh' ? 8_192
            : 16_384;
  return Math.max(1_024, Math.min(target, maxTokens - 512));
}

function effortSupported(info: AnthropicModelInfo | undefined, effort: ReasoningEffort): boolean {
  if (!info?.capabilities?.effort || effort === 'none') return false;
  return supports(info.capabilities.effort[effort]);
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

export class AnthropicInferenceProvider implements InferenceProvider {
  readonly id = 'anthropic';
  readonly kind = 'cloud' as const;
  readonly capabilities = providerCapabilities;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly modelCache = new Map<string, AnthropicModelInfo>();

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey.trim()) throw new Error('Anthropic API key is required.');
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.apiVersion = options.apiVersion ?? '2023-06-01';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async listModels(): Promise<ModelDefinition[]> {
    const models: AnthropicModelInfo[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: '1000' });
      if (afterId) query.set('after_id', afterId);
      const response = await fetchWithProviderErrors(
        this.id,
        this.fetchImpl,
        `${this.baseUrl}/v1/models?${query.toString()}`,
        { method: 'GET', headers: this.headers() },
        this.timeoutMs,
        [this.apiKey]
      );
      const payload = (await response.json()) as AnthropicModelsResponse;
      const pageModels = Array.isArray(payload.data) ? payload.data : [];
      models.push(...pageModels);
      for (const model of pageModels) this.modelCache.set(model.id, model);
      if (!payload.has_more || !payload.last_id) break;
      afterId = payload.last_id;
    }
    return models.map((model) => ({
      providerId: this.id,
      id: model.id,
      displayName: model.display_name ?? model.id,
      createdAt: model.created_at,
      contextWindow: model.max_input_tokens && model.max_input_tokens > 0
        ? model.max_input_tokens
        : undefined,
      maxOutputTokens: model.max_tokens && model.max_tokens > 0 ? model.max_tokens : undefined,
      capabilities: modelCapabilities(model),
      metadata: model.capabilities ? { anthropicCapabilities: model.capabilities } : undefined
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
    const modelInfo = await this.ensureCapabilities(request);
    const maxTokens = Math.max(1, request.maxOutputTokens ?? 8_192);
    const outputConfig: Record<string, unknown> = {};
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: maxTokens,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userPrompt }],
      stream: Boolean(request.onProgress)
    };

    if (request.output?.type === 'json_schema') {
      if (modelInfo && !supports(modelInfo.capabilities?.structured_outputs)) {
        throw new ProviderError(this.id, `Model ${request.model} does not advertise structured output support.`, {
          code: 'unsupported_structured_output'
        });
      }
      outputConfig.format = {
        type: 'json_schema',
        schema: request.output.schema
      };
    }

    const effort = request.reasoning?.effort;
    if (effort && effort !== 'none') {
      const thinking = modelInfo?.capabilities?.thinking;
      if (supports(thinking?.types?.adaptive)) {
        body.thinking = { type: 'adaptive' };
        if (effortSupported(modelInfo, effort)) outputConfig.effort = effort;
      } else if (supports(thinking?.types?.enabled)) {
        if (maxTokens < 1_536) {
          throw new ProviderError(
            this.id,
            `Model ${request.model} requires at least 1536 max output tokens for manual thinking.`,
            { code: 'reasoning_budget_too_small' }
          );
        }
        body.thinking = { type: 'enabled', budget_tokens: manualThinkingBudget(effort, maxTokens) };
      } else {
        throw new ProviderError(this.id, `Model ${request.model} does not advertise thinking support.`, {
          code: 'unsupported_reasoning'
        });
      }
    }

    if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
    emitProgress(request, this.id, 'waiting-response', 0, 0);

    const response = await fetchWithProviderErrors(
      this.id,
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body)
      },
      request.timeoutMs ?? this.timeoutMs,
      [this.apiKey]
    );

    if (request.onProgress) {
      return await this.readStream(response, request, started);
    }
    const payload = (await response.json()) as AnthropicMessageResponse;
    return {
      providerId: this.id,
      model: payload.model ?? request.model,
      content: (payload.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join(''),
      responseId: payload.id,
      stopReason: payload.stop_reason ?? undefined,
      latencyMs: Date.now() - started,
      usage: normalizeUsage(payload.usage)
    };
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion
    };
  }

  private async ensureCapabilities(request: InferenceRequest): Promise<AnthropicModelInfo | undefined> {
    if (request.output?.type !== 'json_schema' && request.reasoning?.effort === undefined) {
      return this.modelCache.get(request.model);
    }
    if (!this.modelCache.has(request.model)) await this.listModels();
    return this.modelCache.get(request.model);
  }

  private async readStream(
    response: Response,
    request: InferenceRequest,
    started: number
  ): Promise<InferenceResult> {
    let content = '';
    let eventCount = 0;
    let responseId: string | undefined;
    let model = request.model;
    let stopReason: string | undefined;
    const usage: AnthropicUsagePayload = {};

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

      if (type === 'message_start' && payload.message && typeof payload.message === 'object') {
        const message = payload.message as AnthropicMessageResponse;
        responseId = message.id;
        model = message.model ?? model;
        mergeUsage(usage, message.usage);
        continue;
      }

      if (type === 'content_block_delta' && payload.delta && typeof payload.delta === 'object') {
        const delta = payload.delta as Record<string, unknown>;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          content += delta.text;
          emitProgress(request, this.id, 'generating', eventCount, content.length);
        } else if (typeof delta.type === 'string' && delta.type.includes('thinking')) {
          emitProgress(request, this.id, 'reasoning', eventCount, content.length);
        }
        continue;
      }

      if (type === 'message_delta') {
        if (payload.delta && typeof payload.delta === 'object') {
          const delta = payload.delta as Record<string, unknown>;
          if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
        }
        if (payload.usage && typeof payload.usage === 'object') {
          mergeUsage(usage, payload.usage as AnthropicUsagePayload);
        }
      }
    }

    return {
      providerId: this.id,
      model,
      content,
      responseId,
      stopReason,
      latencyMs: Date.now() - started,
      usage: normalizeUsage(usage)
    };
  }
}
