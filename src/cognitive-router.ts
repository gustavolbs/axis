import type { InferenceStage } from './inference-status.js';
import {
  assertProjectProviderAllowed,
  type ModelSelection,
  type ProjectDefinition,
  type RoutingPolicy
} from './project-store.js';
import type { ProviderCapabilities, ProviderKind } from './providers/types.js';

export type RoutingUrgency = 'normal' | 'urgent';
export type RoutingBlastRadius = 'low' | 'medium' | 'high' | 'critical';

export interface RoutingCandidate {
  providerId: string;
  modelId: string;
  providerKind: ProviderKind;
  available: boolean;
  capabilities?: Partial<ProviderCapabilities>;
  /** Estimated provider/compute queue before the request can begin. */
  queueDelayMs?: number;
  /** Historical end-to-end p50 for comparable inference calls. */
  p50LatencyMs?: number;
  /** Historical success rate in [0, 1] for comparable work. */
  successRate?: number;
  historicalSamples?: number;
  /** Estimated monetary cost for this stage, not the entire job. */
  estimatedCostUsd?: number;
  /** Config/data-driven quality signal in [0, 100]. */
  qualityScore?: number;
  /** Explicit model catalog classification; never inferred from a provider-specific name. */
  frontier?: boolean;
}

export interface CognitiveRoutingRequest {
  project: Pick<ProjectDefinition, 'id' | 'defaultRoutingPolicy' | 'defaultModel' | 'privacy'>;
  stage: InferenceStage;
  candidates: RoutingCandidate[];
  policy?: RoutingPolicy;
  modelSelection?: ModelSelection;
  urgency?: RoutingUrgency;
  complexityScore?: number;
  blastRadius?: RoutingBlastRadius;
  requireReasoning?: boolean;
  requireStructuredOutput?: boolean;
}

export interface ConsideredRoutingCandidate {
  providerId: string;
  modelId: string;
  providerKind: ProviderKind;
  eligible: boolean;
  score?: number;
  exclusionReason?: string;
  signals: string[];
}

export interface CognitiveRoutingDecision {
  requestedPolicy: RoutingPolicy;
  effectivePolicy: Exclude<RoutingPolicy, 'auto'>;
  selected: { providerId: string; modelId: string; providerKind: ProviderKind };
  reasons: string[];
  considered: ConsideredRoutingCandidate[];
}

export class RoutingConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingConstraintError';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeSuccessRate(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : undefined;
}

function effectivePolicy(
  request: CognitiveRoutingRequest,
  requested: RoutingPolicy
): Exclude<RoutingPolicy, 'auto'> {
  if (requested !== 'auto') return requested;
  if (request.urgency === 'urgent') return 'speed-first';
  if ((request.complexityScore ?? 0) >= 70 || request.blastRadius === 'critical') return 'deep';
  return 'balanced';
}

function candidateKey(candidate: Pick<RoutingCandidate, 'providerId' | 'modelId'>): string {
  return `${candidate.providerId}\0${candidate.modelId}`;
}

function assertUniqueCandidates(candidates: RoutingCandidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) {
      throw new RoutingConstraintError(
        `Duplicate routing candidate: ${candidate.providerId}/${candidate.modelId}.`
      );
    }
    seen.add(key);
  }
}

function exclusionReason(
  request: CognitiveRoutingRequest,
  candidate: RoutingCandidate,
  policy: Exclude<RoutingPolicy, 'auto'>
): string | undefined {
  if (!candidate.providerId.trim() || !candidate.modelId.trim()) return 'provider/model id is empty';
  if (!candidate.available) return 'model/provider is unavailable';

  try {
    assertProjectProviderAllowed(
      request.project as ProjectDefinition,
      candidate.providerId,
      candidate.providerKind
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  // Capability-constrained stages fail closed. "Unknown" is not equivalent to support.
  if (request.requireReasoning && candidate.capabilities?.reasoning !== true) {
    return 'stage requires positively known reasoning support';
  }
  if (request.requireStructuredOutput && candidate.capabilities?.structuredOutput !== true) {
    return 'stage requires positively known structured-output support';
  }
  if (policy === 'frontier-only' && candidate.frontier !== true) {
    return 'frontier-only policy excludes non-frontier models';
  }
  return undefined;
}

function quality(candidate: RoutingCandidate): number {
  const explicit = finiteNonNegative(candidate.qualityScore);
  if (explicit !== undefined) return clamp(explicit, 0, 100);
  const success = normalizeSuccessRate(candidate.successRate);
  if (success !== undefined && (candidate.historicalSamples ?? 0) >= 3) return success * 100;

  // Provider-agnostic cold-start priors. Eval/history data replaces these once available.
  if (candidate.frontier) return 86;
  return candidate.providerKind === 'cloud' ? 72 : 60;
}

function speed(candidate: RoutingCandidate): number {
  const queue = finiteNonNegative(candidate.queueDelayMs) ?? 0;
  const latency = finiteNonNegative(candidate.p50LatencyMs);
  const expectedMs = queue + (latency ?? (candidate.providerKind === 'cloud' ? 240_000 : 900_000));
  return clamp(100 - expectedMs / 18_000, 0, 100);
}

function cost(candidate: RoutingCandidate): number {
  if (candidate.providerKind === 'local') return 100;
  const estimate = finiteNonNegative(candidate.estimatedCostUsd);
  if (estimate === undefined) return 45;
  return clamp(100 - Math.max(0, estimate - 0.1) * 50, 0, 100);
}

function stageAffinity(stage: InferenceStage, candidate: RoutingCandidate): number {
  if (stage === 'repo-learning') return candidate.providerKind === 'local' ? 14 : -4;
  if (stage === 'deliberation') return candidate.frontier ? 14 : 0;
  if (stage === 'review') return candidate.frontier ? 8 : 0;
  if (stage === 'implementation' && candidate.providerKind === 'cloud') return 2;
  return 0;
}

function scoreCandidate(
  request: CognitiveRoutingRequest,
  policy: Exclude<RoutingPolicy, 'auto'>,
  candidate: RoutingCandidate
): number {
  const qualityScore = quality(candidate);
  const speedScore = speed(candidate);
  const costScore = cost(candidate);
  let score: number;

  switch (policy) {
    case 'local-first':
      score = qualityScore * 0.28 + speedScore * 0.17 + costScore * 0.25;
      score += candidate.providerKind === 'local' ? 34 : -18;
      break;
    case 'speed-first':
      score = qualityScore * 0.23 + speedScore * 0.67 + costScore * 0.10;
      break;
    case 'deep':
      score = qualityScore * 0.68 + speedScore * 0.12 + costScore * 0.08;
      score += candidate.frontier ? 14 : 0;
      score += request.requireReasoning && candidate.capabilities?.reasoning === true ? 5 : 0;
      break;
    case 'frontier-only':
      score = qualityScore * 0.70 + speedScore * 0.18 + costScore * 0.12;
      break;
    case 'balanced':
    default:
      score = qualityScore * 0.44 + speedScore * 0.28 + costScore * 0.28;
      break;
  }

  score += stageAffinity(request.stage, candidate);
  if (request.urgency === 'urgent') score += speedScore * 0.08;
  if ((request.complexityScore ?? 0) >= 70) score += qualityScore * 0.06;
  if (request.blastRadius === 'critical') score += qualityScore * 0.06;
  return Math.round(score * 100) / 100;
}

function signalSummary(candidate: RoutingCandidate): string[] {
  const result: string[] = [];
  const queue = finiteNonNegative(candidate.queueDelayMs);
  const latency = finiteNonNegative(candidate.p50LatencyMs);
  const estimate = finiteNonNegative(candidate.estimatedCostUsd);
  const success = normalizeSuccessRate(candidate.successRate);
  if (queue !== undefined) result.push(`queue ${Math.round(queue / 1000)}s`);
  if (latency !== undefined) result.push(`historical p50 ${Math.round(latency / 1000)}s`);
  if (success !== undefined) result.push(`historical success ${(success * 100).toFixed(0)}%`);
  if (estimate !== undefined) result.push(`estimated stage cost $${estimate.toFixed(4)}`);
  if (candidate.frontier) result.push('frontier model');
  result.push(candidate.providerKind === 'local' ? 'local compute' : 'cloud compute');
  return result;
}

function exactSelection(
  request: CognitiveRoutingRequest,
  selection: Extract<ModelSelection, { mode: 'explicit' }>,
  policy: Exclude<RoutingPolicy, 'auto'>
): CognitiveRoutingDecision {
  const candidate = request.candidates.find(
    (item) => item.providerId === selection.providerId && item.modelId === selection.modelId
  );
  if (!candidate) {
    throw new RoutingConstraintError(
      `Explicit model ${selection.providerId}/${selection.modelId} is not present in the routing catalog.`
    );
  }
  const excluded = exclusionReason(request, candidate, policy);
  if (excluded) {
    throw new RoutingConstraintError(
      `Explicit model ${selection.providerId}/${selection.modelId} cannot be used: ${excluded}.`
    );
  }

  return {
    requestedPolicy: request.policy ?? request.project.defaultRoutingPolicy,
    effectivePolicy: policy,
    selected: {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      providerKind: candidate.providerKind
    },
    reasons: [
      `Explicit model selection requires ${candidate.providerId}/${candidate.modelId}.`,
      ...signalSummary(candidate)
    ],
    considered: request.candidates.map((item) => {
      const isSelected = item === candidate;
      return {
        providerId: item.providerId,
        modelId: item.modelId,
        providerKind: item.providerKind,
        eligible: isSelected,
        score: isSelected ? scoreCandidate(request, policy, item) : undefined,
        exclusionReason: isSelected
          ? undefined
          : 'not selected because the user/project chose an explicit model',
        signals: signalSummary(item)
      };
    })
  };
}

export function routeCognitiveStage(request: CognitiveRoutingRequest): CognitiveRoutingDecision {
  if (request.candidates.length === 0) {
    throw new RoutingConstraintError('No inference candidates are available to the cognitive router.');
  }
  assertUniqueCandidates(request.candidates);

  const requestedPolicy = request.policy ?? request.project.defaultRoutingPolicy;
  const policy = effectivePolicy(request, requestedPolicy);
  const selection = request.modelSelection ?? request.project.defaultModel;
  if (selection.mode === 'explicit') return exactSelection(request, selection, policy);

  const considered: ConsideredRoutingCandidate[] = request.candidates.map((candidate) => {
    const excluded = exclusionReason(request, candidate, policy);
    return {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      providerKind: candidate.providerKind,
      eligible: excluded === undefined,
      score: excluded === undefined ? scoreCandidate(request, policy, candidate) : undefined,
      exclusionReason: excluded,
      signals: signalSummary(candidate)
    };
  });

  const eligible = considered
    .filter((candidate) => candidate.eligible && candidate.score !== undefined)
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  const winner = eligible[0];
  if (!winner) {
    const excluded = considered
      .map((candidate) => `${candidate.providerId}/${candidate.modelId}: ${candidate.exclusionReason ?? 'excluded'}`)
      .join('; ');
    throw new RoutingConstraintError(`No model satisfies the project/stage routing constraints. ${excluded}`);
  }

  const source = request.candidates.find(
    (candidate) => candidate.providerId === winner.providerId && candidate.modelId === winner.modelId
  )!;
  const reasons = [
    `Routing policy ${requestedPolicy}${requestedPolicy === 'auto' ? ` resolved to ${policy}` : ''}.`,
    `Selected ${winner.providerId}/${winner.modelId} with routing score ${winner.score?.toFixed(2)}.`,
    ...winner.signals
  ];
  if (request.urgency === 'urgent') reasons.push('Urgency favors lower queue and latency.');
  if ((request.complexityScore ?? 0) >= 70) reasons.push('High complexity increases the weight of model quality.');
  if (request.blastRadius === 'critical') reasons.push('Critical blast radius increases the weight of model quality.');
  if (request.stage === 'repo-learning' && source.providerKind === 'local') {
    reasons.push('Repo learning has a local-compute affinity when other constraints allow it.');
  }

  return {
    requestedPolicy,
    effectivePolicy: policy,
    selected: {
      providerId: winner.providerId,
      modelId: winner.modelId,
      providerKind: winner.providerKind
    },
    reasons,
    considered
  };
}
