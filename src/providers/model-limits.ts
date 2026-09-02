import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  ModelDefinition,
  ProviderKind
} from './types.js';

export const FALLBACK_CLOUD_CONTEXT_WINDOW = 128_000;
export const FALLBACK_CLOUD_MAX_OUTPUT_TOKENS = 8_192;
export const FALLBACK_LOCAL_CONTEXT_WINDOW = 16_384;
export const FALLBACK_LOCAL_MAX_OUTPUT_TOKENS = 2_048;

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function fallbackLimits(kind: ProviderKind): { contextWindow: number; maxOutputTokens: number } {
  return kind === 'cloud'
    ? {
        contextWindow: FALLBACK_CLOUD_CONTEXT_WINDOW,
        maxOutputTokens: FALLBACK_CLOUD_MAX_OUTPUT_TOKENS
      }
    : {
        contextWindow: FALLBACK_LOCAL_CONTEXT_WINDOW,
        maxOutputTokens: FALLBACK_LOCAL_MAX_OUTPUT_TOKENS
      };
}

/**
 * Completes provider discovery without presenting fallback values as published
 * specifications. Consumers always receive usable numeric limits and can inspect
 * metadata.modelLimitsSource when they need to distinguish provider data from a
 * conservative runtime fallback.
 */
export function modelWithSafeLimits(
  model: ModelDefinition,
  kind: ProviderKind
): ModelDefinition & { contextWindow: number; maxOutputTokens: number } {
  const fallback = fallbackLimits(kind);
  const publishedContext = positiveInteger(model.contextWindow);
  const publishedOutput = positiveInteger(model.maxOutputTokens);
  const contextWindow = Math.max(
    publishedContext ?? fallback.contextWindow,
    publishedOutput ?? 0
  );
  const maxOutputTokens = Math.min(
    publishedOutput ?? fallback.maxOutputTokens,
    contextWindow
  );
  return {
    ...model,
    contextWindow,
    maxOutputTokens,
    metadata: {
      ...(model.metadata ?? {}),
      modelLimitsSource:
        publishedContext !== undefined && publishedOutput !== undefined
          ? 'provider'
          : 'conservative-fallback'
    }
  };
}

/**
 * Provider-agnostic contract wrapper. It guarantees complete discovery metadata
 * and a finite inference output bound for current and future providers.
 */
export function withSafeModelLimits(provider: InferenceProvider): InferenceProvider {
  const models = new Map<string, ModelDefinition & { contextWindow: number; maxOutputTokens: number }>();

  const discover = async () => {
    const discovered = (await provider.listModels()).map((model) => modelWithSafeLimits(model, provider.kind));
    for (const model of discovered) models.set(model.id, model);
    return discovered;
  };

  return {
    id: provider.id,
    kind: provider.kind,
    capabilities: provider.capabilities,
    listModels: discover,
    health: () => provider.health(),
    async invoke(request: InferenceRequest): Promise<InferenceResult> {
      if (positiveInteger(request.maxOutputTokens) !== undefined) {
        return await provider.invoke(request);
      }

      let model = models.get(request.model);
      if (!model) {
        try {
          await discover();
          model = models.get(request.model);
        } catch {
          // Discovery must not turn a safe fallback into an availability failure.
        }
      }
      const fallback = fallbackLimits(provider.kind);
      return await provider.invoke({
        ...request,
        maxOutputTokens: Math.min(
          model?.maxOutputTokens ?? fallback.maxOutputTokens,
          fallback.maxOutputTokens
        )
      });
    }
  };
}
