import {
  ProviderError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  type ModelDefinition,
  type ProviderCapabilities,
  type ProviderHealth
} from './types.js';

function retryable(error: unknown): boolean {
  return error instanceof ProviderError &&
    (error.options.retryable === true || error.options.rateLimited === true);
}

function compatibleCapabilities(
  preferred: ProviderCapabilities,
  fallback: ProviderCapabilities
): ProviderCapabilities {
  return {
    modelDiscovery: preferred.modelDiscovery && fallback.modelDiscovery,
    streaming: preferred.streaming && fallback.streaming,
    structuredOutput: preferred.structuredOutput && fallback.structuredOutput,
    reasoning: preferred.reasoning && fallback.reasoning,
    promptCaching: preferred.promptCaching && fallback.promptCaching,
    toolUse: preferred.toolUse && fallback.toolUse
  };
}

/**
 * Keeps existing `auto` semantics for the router's local provider: prefer the Windows
 * worker, but if that worker is genuinely unavailable use Ollama on the Mac. Both
 * implementations must represent the same logical provider id (`ollama`).
 */
export class AutoLocalInferenceProvider implements InferenceProvider {
  readonly id = 'ollama';
  readonly kind = 'local' as const;
  readonly capabilities: ProviderCapabilities;

  private active: 'preferred' | 'fallback' | undefined;

  constructor(
    private readonly preferred: InferenceProvider,
    private readonly fallback: InferenceProvider
  ) {
    if (
      preferred.id !== this.id || preferred.kind !== 'local' ||
      fallback.id !== this.id || fallback.kind !== 'local'
    ) {
      throw new Error('AutoLocalInferenceProvider requires two local providers with id ollama.');
    }
    this.capabilities = compatibleCapabilities(preferred.capabilities, fallback.capabilities);
  }

  async listModels(): Promise<ModelDefinition[]> {
    try {
      const models = await this.preferred.listModels();
      this.active = 'preferred';
      return models.map((model) => ({
        ...model,
        metadata: { ...(model.metadata ?? {}), autoLocalSource: 'remote-worker' }
      }));
    } catch (error) {
      if (!retryable(error)) throw error;
      const models = await this.fallback.listModels();
      this.active = 'fallback';
      return models.map((model) => ({
        ...model,
        metadata: { ...(model.metadata ?? {}), autoLocalSource: 'mac-ollama' }
      }));
    }
  }

  async health(): Promise<ProviderHealth> {
    const preferred = await this.preferred.health();
    if (preferred.ok) {
      this.active = 'preferred';
      return { ...preferred, providerId: this.id };
    }
    const fallback = await this.fallback.health();
    if (fallback.ok) this.active = 'fallback';
    return {
      ...fallback,
      providerId: this.id,
      message: fallback.ok
        ? `Windows worker unavailable; using Mac Ollama. ${preferred.message ?? ''}`.trim()
        : `Windows worker unavailable (${preferred.message ?? 'unknown'}); Mac Ollama unavailable (${fallback.message ?? 'unknown'}).`
    };
  }

  async invoke(request: InferenceRequest): Promise<InferenceResult> {
    if (!this.active) await this.listModels();
    if (this.active === 'fallback') return await this.fallback.invoke(request);

    try {
      return await this.preferred.invoke(request);
    } catch (error) {
      if (!retryable(error)) throw error;
      const fallbackModels = await this.fallback.listModels();
      if (!fallbackModels.some((model) => model.id === request.model)) {
        throw error;
      }
      this.active = 'fallback';
      return await this.fallback.invoke(request);
    }
  }
}
