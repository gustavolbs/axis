export type ProviderKind = 'local' | 'cloud';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Provider-agnostic capability classes controlled centrally in Settings. */
export type ProviderCapabilityKind = 'skills' | 'abilities' | 'mcps' | 'plugins' | 'tools';

/**
 * An inference must explicitly declare every external capability it intends to use.
 * The provider policy wrapper rejects undeclared/blocked access before inference.
 */
export interface ProviderCapabilityRequest {
  kind: ProviderCapabilityKind;
  id: string;
}

export interface ProviderCapabilities {
  modelDiscovery: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  promptCaching: boolean;
  toolUse: boolean;
}

export interface ModelDefinition {
  providerId: string;
  id: string;
  displayName: string;
  createdAt?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ProviderCapabilities>;
  metadata?: Record<string, unknown>;
}

export interface ProviderHealth {
  providerId: string;
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  modelsAvailable?: number;
  message?: string;
}

export type InferenceOutputFormat =
  | { type: 'text' }
  | {
      type: 'json_schema';
      schema: Record<string, unknown>;
      name?: string;
      strict?: boolean;
    };

export interface InferenceRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  stage?: string;
  output?: InferenceOutputFormat;
  reasoning?: { effort: ReasoningEffort };
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Capabilities requested by this inference. Empty/undefined means model-only inference. */
  capabilityRequests?: ProviderCapabilityRequest[];
  /**
   * Opaque, namespaced provider hints. Runtime/router code must not inspect them.
   * Example: `{ ollama: { numCtx, keepAlive } }`. This preserves provider-specific
   * tuning without contaminating the common inference contract.
   */
  providerOptions?: Record<string, unknown>;
  onProgress?: ProviderProgressReporter;
}

export interface InferenceUsage {
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface InferenceResult {
  providerId: string;
  model: string;
  content: string;
  responseId?: string;
  stopReason?: string;
  latencyMs: number;
  usage: InferenceUsage;
  /**
   * Host-generated correlation id for a potentially billable cloud call. It is
   * persisted into the usage ledger before the global provider reservation can
   * be released, preventing accounting failures from silently freeing budget.
   */
  billingId?: string;
}

export interface ProviderProgress {
  providerId: string;
  model: string;
  state: 'waiting-response' | 'reasoning' | 'generating';
  timestamp: string;
  eventCount: number;
  outputChars: number;
}

export type ProviderProgressReporter = (progress: ProviderProgress) => void;

export interface InferenceProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  listModels(): Promise<ModelDefinition[]>;
  health(): Promise<ProviderHealth>;
  invoke(request: InferenceRequest): Promise<InferenceResult>;
}

export class ProviderError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
    readonly options: {
      status?: number;
      retryable?: boolean;
      rateLimited?: boolean;
      retryAfterMs?: number;
      code?: string;
    } = {}
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
