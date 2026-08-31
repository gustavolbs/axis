import {
  routeCognitiveStage,
  RoutingConstraintError,
  type CognitiveRoutingDecision,
  type CognitiveRoutingRequest,
  type RoutingCandidate
} from './cognitive-router.js';
import type { ModelSelection } from './project-store.js';
import { ProviderRegistry } from './providers/registry.js';
import {
  ProviderError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult
} from './providers/types.js';

export interface RoutedInferenceAttempt {
  providerId: string;
  modelId: string;
  status: 'success' | 'error';
  error?: string;
  retryable?: boolean;
  rateLimited?: boolean;
}

export interface FallbackConfirmationRequest {
  from: RoutingCandidate;
  to: RoutingCandidate;
  reason: string;
  costChange: 'none' | 'known-material' | 'unknown';
}

export type FallbackConfirmation = (
  request: FallbackConfirmationRequest
) => boolean | Promise<boolean>;

export interface AttemptAuthorizationRequest {
  candidate: RoutingCandidate;
  inference: Omit<InferenceRequest, 'model'>;
  fallback: boolean;
  reason?: string;
}

export type AttemptAuthorizer = (
  request: AttemptAuthorizationRequest
) => void | Promise<void>;

export interface RoutedInferenceInput {
  inference: Omit<InferenceRequest, 'model'>;
  routing: CognitiveRoutingRequest;
  /**
   * Called only when fallback changes the cost/privacy risk materially. Absence means
   * "do not silently cross that boundary", not implicit approval.
   */
  confirmFallback?: FallbackConfirmation;
  /** Hard admission hook (budgets, quotas, policy extensions) run before provider I/O. */
  authorizeAttempt?: AttemptAuthorizer;
}

export interface RoutedInferenceResult {
  result: InferenceResult;
  routing: CognitiveRoutingDecision;
  attempts: RoutedInferenceAttempt[];
  fallbackUsed: boolean;
}

export class FallbackConfirmationRequired extends Error {
  constructor(readonly request: FallbackConfirmationRequest) {
    super(
      `Fallback from ${request.from.providerId}/${request.from.modelId} to ` +
      `${request.to.providerId}/${request.to.modelId} requires user confirmation: ${request.reason}`
    );
    this.name = 'FallbackConfirmationRequired';
  }
}

function isExplicit(selection: ModelSelection): boolean {
  return selection.mode === 'explicit';
}

function candidateKey(candidate: Pick<RoutingCandidate, 'providerId' | 'modelId'>): string {
  return `${candidate.providerId}\0${candidate.modelId}`;
}

function orderedEligibleFallbacks(
  routing: CognitiveRoutingDecision,
  candidates: RoutingCandidate[]
): RoutingCandidate[] {
  const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const selectedKey = `${routing.selected.providerId}\0${routing.selected.modelId}`;
  return routing.considered
    .filter((candidate) => candidate.eligible && candidate.score !== undefined)
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
    .flatMap((candidate) => {
      const key = `${candidate.providerId}\0${candidate.modelId}`;
      if (key === selectedKey) return [];
      const source = byKey.get(key);
      return source ? [source] : [];
    });
}

function costChange(
  from: RoutingCandidate,
  to: RoutingCandidate
): 'none' | 'known-material' | 'unknown' {
  if (to.providerKind === 'local') return 'none';
  if (from.providerKind === 'local' && to.providerKind === 'cloud') return 'known-material';

  const fromCost = from.estimatedCostUsd;
  const toCost = to.estimatedCostUsd;
  if (
    typeof fromCost !== 'number' || !Number.isFinite(fromCost) || fromCost < 0 ||
    typeof toCost !== 'number' || !Number.isFinite(toCost) || toCost < 0
  ) return 'unknown';

  const absoluteIncrease = toCost - fromCost;
  const relativeIncrease = fromCost === 0 ? (toCost > 0 ? Infinity : 1) : toCost / fromCost;
  return absoluteIncrease >= 0.05 && relativeIncrease > 1.25 ? 'known-material' : 'none';
}

async function ensureFallbackAllowed(
  from: RoutingCandidate,
  to: RoutingCandidate,
  confirm: FallbackConfirmation | undefined,
  reason: string
): Promise<void> {
  const change = costChange(from, to);
  if (change === 'none') return;
  const request: FallbackConfirmationRequest = { from, to, reason, costChange: change };
  if (!confirm || !(await confirm(request))) throw new FallbackConfirmationRequired(request);
}

function providerFailure(error: unknown): ProviderError | undefined {
  return error instanceof ProviderError ? error : undefined;
}

/**
 * Provider-agnostic inference entrypoint. Routing is deterministic host code; it never
 * invokes a local model (or any model) to decide which provider should receive the call.
 */
export class RoutedInferenceRuntime {
  constructor(private readonly providers: ProviderRegistry) {}

  async invoke(input: RoutedInferenceInput): Promise<RoutedInferenceResult> {
    this.assertCatalogMatchesRegistry(input.routing.candidates);
    const routing = routeCognitiveStage(input.routing);
    const selection = input.routing.modelSelection ?? input.routing.project.defaultModel;
    const candidates = input.routing.candidates;
    const primary = candidates.find(
      (candidate) =>
        candidate.providerId === routing.selected.providerId &&
        candidate.modelId === routing.selected.modelId
    );
    if (!primary) {
      throw new RoutingConstraintError('Cognitive router selected a model missing from its candidate catalog.');
    }

    const attempts: RoutedInferenceAttempt[] = [];
    const primaryProvider = this.providerFor(primary);
    await input.authorizeAttempt?.({
      candidate: primary,
      inference: input.inference,
      fallback: false
    });
    try {
      const result = await primaryProvider.invoke({ ...input.inference, model: primary.modelId });
      attempts.push({ providerId: primary.providerId, modelId: primary.modelId, status: 'success' });
      return { result, routing, attempts, fallbackUsed: false };
    } catch (error) {
      const providerError = providerFailure(error);
      attempts.push({
        providerId: primary.providerId,
        modelId: primary.modelId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        retryable: providerError?.options.retryable,
        rateLimited: providerError?.options.rateLimited
      });
      if (!providerError || (!providerError.options.retryable && !providerError.options.rateLimited)) throw error;
      if (isExplicit(selection)) throw error;
    }

    let previous = primary;
    for (const fallback of orderedEligibleFallbacks(routing, candidates)) {
      const prior = attempts.at(-1);
      const reason = prior?.rateLimited
        ? `${previous.providerId}/${previous.modelId} is rate-limited.`
        : `${previous.providerId}/${previous.modelId} is temporarily unavailable.`;
      await ensureFallbackAllowed(previous, fallback, input.confirmFallback, reason);
      await input.authorizeAttempt?.({
        candidate: fallback,
        inference: input.inference,
        fallback: true,
        reason
      });

      const provider = this.providerFor(fallback);
      try {
        const result = await provider.invoke({ ...input.inference, model: fallback.modelId });
        attempts.push({ providerId: fallback.providerId, modelId: fallback.modelId, status: 'success' });
        return {
          result,
          routing: {
            ...routing,
            reasons: [
              ...routing.reasons,
              `Fallback selected ${fallback.providerId}/${fallback.modelId}: ${reason}`
            ]
          },
          attempts,
          fallbackUsed: true
        };
      } catch (error) {
        const providerError = providerFailure(error);
        attempts.push({
          providerId: fallback.providerId,
          modelId: fallback.modelId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          retryable: providerError?.options.retryable,
          rateLimited: providerError?.options.rateLimited
        });
        if (!providerError || (!providerError.options.retryable && !providerError.options.rateLimited)) throw error;
        previous = fallback;
      }
    }

    const last = attempts.at(-1);
    throw new ProviderError(
      last?.providerId ?? primary.providerId,
      `All eligible routed inference providers failed for stage ${input.inference.stage ?? 'other'}.`,
      { retryable: true, code: 'routing_fallback_exhausted' }
    );
  }

  private assertCatalogMatchesRegistry(candidates: RoutingCandidate[]): void {
    for (const candidate of candidates) this.providerFor(candidate);
  }

  private providerFor(candidate: RoutingCandidate): InferenceProvider {
    const provider = this.providers.get(candidate.providerId);
    if (provider.kind !== candidate.providerKind) {
      throw new RoutingConstraintError(
        `Routing candidate ${candidate.providerId}/${candidate.modelId} declares ${candidate.providerKind} ` +
        `compute but the registered provider is ${provider.kind}. Refusing to route with inconsistent privacy metadata.`
      );
    }
    return provider;
  }
}
