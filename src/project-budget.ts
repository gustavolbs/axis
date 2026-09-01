import { randomUUID } from 'node:crypto';

import type { RoutingCandidate } from './cognitive-router.js';
import type { InferenceStage } from './inference-status.js';
import {
  PricingStore,
  calculateUsageCostUsd,
  estimateRequestCostUsd,
  type ModelPricing,
  type RequestCostEstimate
} from './pricing-store.js';
import type { ProjectDefinition } from './project-store.js';
import type { InferenceRequest, InferenceResult } from './providers/types.js';
import {
  UsageLedger,
  utcDayPeriod,
  utcMonthPeriod,
  type UsageBudgetReservation,
  type UsageLedgerEvent,
  type UsagePeriodSummary
} from './usage-ledger.js';

export type BudgetGuardCode =
  | 'pricing-required'
  | 'output-bound-required'
  | 'historical-cost-unknown'
  | 'daily-budget-exceeded'
  | 'monthly-budget-exceeded'
  | 'job-budget-exceeded';

export class BudgetGuardError extends Error {
  constructor(
    readonly code: BudgetGuardCode,
    readonly projectId: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'BudgetGuardError';
  }
}

export interface BudgetWarning {
  scope: 'daily' | 'monthly' | 'job';
  fraction: number;
  projectedUsd: number;
  limitUsd: number;
}

export interface BudgetAdmission {
  attemptId: string;
  providerId: string;
  modelId: string;
  expectedCostUsd: number;
  upperBoundCostUsd: number;
  reservationId?: string;
  warnings: BudgetWarning[];
}

export interface ProjectBudgetSnapshot {
  projectId: string;
  jobId: string;
  jobKnownCostUsd: number;
  jobUnknownCostEvents: number;
  jobReservedUpperBoundUsd: number;
  dailyReservedUpperBoundUsd: number;
  monthlyReservedUpperBoundUsd: number;
  daily: UsagePeriodSummary;
  monthly: UsagePeriodSummary;
  warnings: BudgetWarning[];
}

interface PendingBudgetAttempt {
  candidateKey: string;
  reservationId?: string;
  pricing?: ModelPricing;
}

function limitsActive(project: ProjectDefinition): boolean {
  return (
    project.budgets.dailyUsd !== undefined ||
    project.budgets.monthlyUsd !== undefined ||
    project.budgets.perJobUsd !== undefined
  );
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function upperBoundCost(
  inference: Omit<InferenceRequest, 'model'>,
  pricing: ModelPricing
): number | undefined {
  if (
    inference.maxOutputTokens === undefined ||
    !Number.isFinite(inference.maxOutputTokens) ||
    inference.maxOutputTokens <= 0
  ) return undefined;
  const promptBytes = Buffer.byteLength(`${inference.systemPrompt}\n${inference.userPrompt}`, 'utf8');
  const upperInputTokens = Math.max(1, promptBytes);
  return calculateUsageCostUsd(
    {
      inputTokens: upperInputTokens,
      outputTokens: Math.ceil(inference.maxOutputTokens)
    },
    pricing
  );
}

function threshold(limitUsd: number, hardStopFraction: number): number {
  return limitUsd * hardStopFraction;
}

function warningEvents(
  scope: BudgetWarning['scope'],
  currentUsd: number,
  projectedUsd: number,
  limitUsd: number,
  fractions: number[]
): BudgetWarning[] {
  if (limitUsd <= 0) return [];
  return fractions
    .filter((fraction) => currentUsd / limitUsd < fraction && projectedUsd / limitUsd >= fraction)
    .map((fraction) => ({
      scope,
      fraction,
      projectedUsd: roundUsd(projectedUsd),
      limitUsd
    }));
}

function hasCompleteBillableUsage(result: InferenceResult): boolean {
  return result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined;
}

function reservationCost(reservations: UsageBudgetReservation[], jobId?: string): number {
  return roundUsd(
    reservations
      .filter((reservation) => !jobId || reservation.jobId === jobId)
      .reduce((sum, reservation) => sum + reservation.upperBoundCostUsd, 0)
  );
}

function reservationLeaseMs(inference: Omit<InferenceRequest, 'model'>): number {
  const requested = inference.timeoutMs ?? 1_800_000;
  return Math.max(60_000, Math.min(requested + 120_000, 7_200_000));
}

function candidateKey(candidate: Pick<RoutingCandidate, 'providerId' | 'modelId'>): string {
  return `${candidate.providerId}\0${candidate.modelId}`;
}

export class ProjectBudgetSession {
  readonly jobId: string;
  private jobKnownCostUsd = 0;
  private jobUnknownCostEvents = 0;
  private readonly warningsSeen: BudgetWarning[] = [];
  private readonly warningKeys = new Set<string>();
  private readonly pendingAttempts = new Map<string, PendingBudgetAttempt>();

  constructor(
    readonly project: ProjectDefinition,
    private readonly pricing = new PricingStore(),
    private readonly ledger = new UsageLedger(),
    options: { jobId?: string; now?: () => Date } = {}
  ) {
    this.jobId = options.jobId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    for (const event of this.ledger.list(this.project.id)) {
      if (event.jobId !== this.jobId) continue;
      if (event.providerKind === 'cloud' && event.costUsd === undefined) {
        this.jobUnknownCostEvents += 1;
      } else {
        this.jobKnownCostUsd = roundUsd(this.jobKnownCostUsd + (event.costUsd ?? 0));
      }
    }
  }

  private readonly now: () => Date;

  estimateCandidate(
    candidate: RoutingCandidate,
    inference: Omit<InferenceRequest, 'model'>
  ): number | undefined {
    if (candidate.providerKind === 'local') return 0;
    const modelPricing = this.pricing.get(candidate.providerId, candidate.modelId);
    if (!modelPricing) return candidate.estimatedCostUsd;
    return estimateRequestCostUsd(inference, modelPricing)?.estimatedCostUsd;
  }

  annotateCandidates(
    candidates: RoutingCandidate[],
    inference: Omit<InferenceRequest, 'model'>
  ): RoutingCandidate[] {
    return candidates.map((candidate) => ({
      ...candidate,
      estimatedCostUsd: this.estimateCandidate(candidate, inference)
    }));
  }

  async authorize(
    candidate: RoutingCandidate,
    inference: Omit<InferenceRequest, 'model'>
  ): Promise<BudgetAdmission> {
    const attemptId = randomUUID();
    if (candidate.providerKind === 'local') {
      return {
        attemptId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        expectedCostUsd: 0,
        upperBoundCostUsd: 0,
        warnings: []
      };
    }

    const active = limitsActive(this.project);
    if (!active) {
      const modelPricing = this.pricing.get(candidate.providerId, candidate.modelId);
      if (!modelPricing) {
        return {
          attemptId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          expectedCostUsd: candidate.estimatedCostUsd ?? 0,
          upperBoundCostUsd: candidate.estimatedCostUsd ?? 0,
          warnings: []
        };
      }
      const expected: RequestCostEstimate | undefined = estimateRequestCostUsd(inference, modelPricing);
      const upper = upperBoundCost(inference, modelPricing);
      const upperCostUsd = upper ?? expected?.estimatedCostUsd ?? 0;
      const expectedCostUsd = expected?.estimatedCostUsd ?? candidate.estimatedCostUsd ?? upperCostUsd;
      this.rememberAttempt(attemptId, candidate, undefined, modelPricing);
      return {
        attemptId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        expectedCostUsd: roundUsd(expectedCostUsd),
        upperBoundCostUsd: roundUsd(upperCostUsd),
        warnings: []
      };
    }

    return await this.ledger.withBudgetLock(async () => {
      const modelPricing = this.pricing.get(candidate.providerId, candidate.modelId);
      if (!modelPricing) {
        throw new BudgetGuardError(
          'pricing-required',
          this.project.id,
          `Project ${this.project.id} has a cloud budget but no pricing for ${candidate.providerId}/${candidate.modelId}.`,
          { providerId: candidate.providerId, modelId: candidate.modelId }
        );
      }
      const expected: RequestCostEstimate | undefined = estimateRequestCostUsd(inference, modelPricing);
      const upper = upperBoundCost(inference, modelPricing);
      if (upper === undefined) {
        throw new BudgetGuardError(
          'output-bound-required',
          this.project.id,
          `Budgeted cloud inference requires maxOutputTokens for ${candidate.providerId}/${candidate.modelId}.`,
          { providerId: candidate.providerId, modelId: candidate.modelId }
        );
      }
      const upperCostUsd = upper;
      const expectedCostUsd = expected?.estimatedCostUsd ?? candidate.estimatedCostUsd ?? upperCostUsd;
      const warnings: BudgetWarning[] = [];
      const now = this.now();
      const reservations = this.ledger.listReservations(this.project.id, now);
      const reservedProjectUsd = reservationCost(reservations);
      const reservedJobUsd = reservationCost(reservations, this.jobId);

      if (this.project.budgets.dailyUsd !== undefined) {
        const period = utcDayPeriod(now);
        const daily = this.ledger.summarize(this.project.id, period.from, period.to);
        if (daily.unknownCostEvents > 0) {
          throw new BudgetGuardError('historical-cost-unknown', this.project.id, 'Daily cloud spend contains unpriced usage; refusing another budgeted cloud call.', { scope: 'daily', unknownCostEvents: daily.unknownCostEvents });
        }
        const current = daily.knownCostUsd + reservedProjectUsd;
        const projected = current + upperCostUsd;
        if (projected > threshold(this.project.budgets.dailyUsd, this.project.budgets.hardStopFraction)) {
          throw new BudgetGuardError('daily-budget-exceeded', this.project.id, `Cloud call could exceed the Project daily hard stop (${projected.toFixed(4)} > ${threshold(this.project.budgets.dailyUsd, this.project.budgets.hardStopFraction).toFixed(4)} USD).`, { currentUsd: current, projectedUsd: projected, limitUsd: this.project.budgets.dailyUsd });
        }
        warnings.push(...warningEvents('daily', current, projected, this.project.budgets.dailyUsd, this.project.budgets.warningFractions));
      }

      if (this.project.budgets.monthlyUsd !== undefined) {
        const period = utcMonthPeriod(now);
        const monthly = this.ledger.summarize(this.project.id, period.from, period.to);
        if (monthly.unknownCostEvents > 0) {
          throw new BudgetGuardError('historical-cost-unknown', this.project.id, 'Monthly cloud spend contains unpriced usage; refusing another budgeted cloud call.', { scope: 'monthly', unknownCostEvents: monthly.unknownCostEvents });
        }
        const current = monthly.knownCostUsd + reservedProjectUsd;
        const projected = current + upperCostUsd;
        if (projected > threshold(this.project.budgets.monthlyUsd, this.project.budgets.hardStopFraction)) {
          throw new BudgetGuardError('monthly-budget-exceeded', this.project.id, `Cloud call could exceed the Project monthly hard stop (${projected.toFixed(4)} > ${threshold(this.project.budgets.monthlyUsd, this.project.budgets.hardStopFraction).toFixed(4)} USD).`, { currentUsd: current, projectedUsd: projected, limitUsd: this.project.budgets.monthlyUsd });
        }
        warnings.push(...warningEvents('monthly', current, projected, this.project.budgets.monthlyUsd, this.project.budgets.warningFractions));
      }

      if (this.project.budgets.perJobUsd !== undefined) {
        if (this.jobUnknownCostEvents > 0) {
          throw new BudgetGuardError('historical-cost-unknown', this.project.id, 'This job already contains unpriced cloud usage; refusing another budgeted cloud call.', { scope: 'job', unknownCostEvents: this.jobUnknownCostEvents });
        }
        const current = this.jobKnownCostUsd + reservedJobUsd;
        const projected = current + upperCostUsd;
        if (projected > threshold(this.project.budgets.perJobUsd, this.project.budgets.hardStopFraction)) {
          throw new BudgetGuardError('job-budget-exceeded', this.project.id, `Cloud call could exceed the Project per-job hard stop (${projected.toFixed(4)} > ${threshold(this.project.budgets.perJobUsd, this.project.budgets.hardStopFraction).toFixed(4)} USD).`, { currentUsd: current, projectedUsd: projected, limitUsd: this.project.budgets.perJobUsd });
        }
        warnings.push(...warningEvents('job', current, projected, this.project.budgets.perJobUsd, this.project.budgets.warningFractions));
      }

      this.rememberWarnings(warnings);
      const expiresAt = new Date(now.getTime() + reservationLeaseMs(inference)).toISOString();
      const reservation = this.ledger.reserve({
        jobId: this.jobId,
        expiresAt,
        projectId: this.project.id,
        organizationId: this.project.organizationId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        upperBoundCostUsd: roundUsd(upperCostUsd),
        timestamp: now.toISOString()
      });
      this.rememberAttempt(attemptId, candidate, reservation.id, modelPricing);
      return { attemptId, providerId: candidate.providerId, modelId: candidate.modelId, expectedCostUsd: roundUsd(expectedCostUsd), upperBoundCostUsd: roundUsd(upperCostUsd), reservationId: reservation.id, warnings };
    });
  }

  releaseAttempt(attempt: Pick<BudgetAdmission, 'attemptId'> | Pick<RoutingCandidate, 'providerId' | 'modelId'>): void {
    const attemptId = this.resolveAttemptId(attempt);
    if (!attemptId) return;
    const pending = this.pendingAttempts.get(attemptId);
    if (pending?.reservationId) this.ledger.releaseReservation(pending.reservationId);
    this.pendingAttempts.delete(attemptId);
  }

  record(
    stage: InferenceStage,
    candidate: Pick<RoutingCandidate, 'providerId' | 'providerKind' | 'modelId'>,
    result: InferenceResult,
    fallbackUsed: boolean,
    admission?: Pick<BudgetAdmission, 'attemptId'>
  ): UsageLedgerEvent {
    const attemptId = admission?.attemptId ?? this.findPendingAttempt(candidate);
    const pending = attemptId ? this.pendingAttempts.get(attemptId) : undefined;
    const modelPricing = candidate.providerKind === 'cloud' ? pending?.pricing ?? this.pricing.get(candidate.providerId, candidate.modelId) : undefined;
    const costUsd = candidate.providerKind === 'local' ? 0 : modelPricing && hasCompleteBillableUsage(result) ? calculateUsageCostUsd(result.usage, modelPricing) : undefined;
    const event = this.ledger.append({
      jobId: this.jobId,
      projectId: this.project.id,
      organizationId: this.project.organizationId,
      stage,
      providerId: candidate.providerId,
      providerKind: candidate.providerKind,
      modelId: candidate.modelId,
      usage: result.usage,
      latencyMs: result.latencyMs,
      costUsd,
      pricingSource: modelPricing?.source,
      pricingVerifiedAt: modelPricing?.verifiedAt,
      billingId: result.billingId,
      fallbackUsed,
      timestamp: this.now().toISOString()
    });
    if (pending?.reservationId) this.ledger.releaseReservation(pending.reservationId);
    if (attemptId) this.pendingAttempts.delete(attemptId);
    if (costUsd === undefined && candidate.providerKind === 'cloud') this.jobUnknownCostEvents += 1;
    else this.jobKnownCostUsd = roundUsd(this.jobKnownCostUsd + (costUsd ?? 0));
    return event;
  }

  recordLocalGeneration(
    stage: InferenceStage,
    modelId: string,
    generation: { promptTokens?: number; completionTokens?: number; totalDurationNs?: number }
  ): UsageLedgerEvent {
    return this.record(
      stage,
      { providerId: 'ollama', providerKind: 'local', modelId },
      {
        providerId: 'ollama',
        model: modelId,
        content: '',
        latencyMs: generation.totalDurationNs ? generation.totalDurationNs / 1_000_000 : 0,
        usage: {
          inputTokens: generation.promptTokens,
          outputTokens: generation.completionTokens,
          totalTokens: generation.promptTokens !== undefined || generation.completionTokens !== undefined ? (generation.promptTokens ?? 0) + (generation.completionTokens ?? 0) : undefined
        }
      },
      false
    );
  }

  snapshot(): ProjectBudgetSnapshot {
    const now = this.now();
    const day = utcDayPeriod(now);
    const month = utcMonthPeriod(now);
    const reservations = this.ledger.listReservations(this.project.id, now);
    const reserved = reservationCost(reservations);
    return {
      projectId: this.project.id,
      jobId: this.jobId,
      jobKnownCostUsd: this.jobKnownCostUsd,
      jobUnknownCostEvents: this.jobUnknownCostEvents,
      jobReservedUpperBoundUsd: reservationCost(reservations, this.jobId),
      dailyReservedUpperBoundUsd: reserved,
      monthlyReservedUpperBoundUsd: reserved,
      daily: this.ledger.summarize(this.project.id, day.from, day.to),
      monthly: this.ledger.summarize(this.project.id, month.from, month.to),
      warnings: [...this.warningsSeen]
    };
  }

  private rememberWarnings(warnings: BudgetWarning[]): void {
    for (const warning of warnings) {
      const key = `${warning.scope}\0${warning.fraction}`;
      if (this.warningKeys.has(key)) continue;
      this.warningKeys.add(key);
      this.warningsSeen.push(warning);
    }
  }

  private rememberAttempt(
    attemptId: string,
    candidate: Pick<RoutingCandidate, 'providerId' | 'modelId'>,
    reservationId: string | undefined,
    pricing: ModelPricing | undefined
  ): void {
    this.pendingAttempts.set(attemptId, {
      candidateKey: candidateKey(candidate),
      reservationId,
      pricing: pricing ? structuredClone(pricing) : undefined
    });
  }

  private findPendingAttempt(candidate: Pick<RoutingCandidate, 'providerId' | 'modelId'>): string | undefined {
    const key = candidateKey(candidate);
    for (const [attemptId, pending] of this.pendingAttempts) {
      if (pending.candidateKey === key) return attemptId;
    }
    return undefined;
  }

  private resolveAttemptId(attempt: Pick<BudgetAdmission, 'attemptId'> | Pick<RoutingCandidate, 'providerId' | 'modelId'>): string | undefined {
    return 'attemptId' in attempt ? attempt.attemptId : this.findPendingAttempt(attempt);
  }
}
