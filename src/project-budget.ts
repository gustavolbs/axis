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
  providerId: string;
  modelId: string;
  expectedCostUsd: number;
  upperBoundCostUsd: number;
  warnings: BudgetWarning[];
}

export interface ProjectBudgetSnapshot {
  projectId: string;
  jobId: string;
  jobKnownCostUsd: number;
  jobUnknownCostEvents: number;
  daily: UsagePeriodSummary;
  monthly: UsagePeriodSummary;
  warnings: BudgetWarning[];
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
  // Byte-fallback tokenizers cannot create more billable input tokens than prompt bytes.
  // This is intentionally much more conservative than the routing estimate.
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

export class ProjectBudgetSession {
  readonly jobId: string;
  private jobKnownCostUsd = 0;
  private jobUnknownCostEvents = 0;
  private readonly warningsSeen: BudgetWarning[] = [];

  constructor(
    readonly project: ProjectDefinition,
    private readonly pricing = new PricingStore(),
    private readonly ledger = new UsageLedger(),
    options: { jobId?: string; now?: () => Date } = {}
  ) {
    this.jobId = options.jobId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
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

  authorize(
    candidate: RoutingCandidate,
    inference: Omit<InferenceRequest, 'model'>
  ): BudgetAdmission {
    if (candidate.providerKind === 'local') {
      return {
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        expectedCostUsd: 0,
        upperBoundCostUsd: 0,
        warnings: []
      };
    }

    const active = limitsActive(this.project);
    const modelPricing = this.pricing.get(candidate.providerId, candidate.modelId);
    if (!modelPricing) {
      if (active) {
        throw new BudgetGuardError(
          'pricing-required',
          this.project.id,
          `Project ${this.project.id} has a cloud budget but no pricing for ${candidate.providerId}/${candidate.modelId}.`,
          { providerId: candidate.providerId, modelId: candidate.modelId }
        );
      }
      return {
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        expectedCostUsd: candidate.estimatedCostUsd ?? 0,
        upperBoundCostUsd: candidate.estimatedCostUsd ?? 0,
        warnings: []
      };
    }

    const expected: RequestCostEstimate | undefined = estimateRequestCostUsd(inference, modelPricing);
    const upper = upperBoundCost(inference, modelPricing);
    if (active && upper === undefined) {
      throw new BudgetGuardError(
        'output-bound-required',
        this.project.id,
        `Budgeted cloud inference requires maxOutputTokens for ${candidate.providerId}/${candidate.modelId}.`,
        { providerId: candidate.providerId, modelId: candidate.modelId }
      );
    }
    const upperCostUsd = upper ?? expected?.estimatedCostUsd ?? 0;
    const expectedCostUsd = expected?.estimatedCostUsd ?? candidate.estimatedCostUsd ?? upperCostUsd;
    const warnings: BudgetWarning[] = [];
    const now = this.now();

    if (this.project.budgets.dailyUsd !== undefined) {
      const period = utcDayPeriod(now);
      const daily = this.ledger.summarize(this.project.id, period.from, period.to);
      if (daily.unknownCostEvents > 0) {
        throw new BudgetGuardError(
          'historical-cost-unknown',
          this.project.id,
          'Daily cloud spend contains unpriced usage; refusing another budgeted cloud call.',
          { scope: 'daily', unknownCostEvents: daily.unknownCostEvents }
        );
      }
      const projected = daily.knownCostUsd + upperCostUsd;
      if (projected > threshold(this.project.budgets.dailyUsd, this.project.budgets.hardStopFraction)) {
        throw new BudgetGuardError(
          'daily-budget-exceeded',
          this.project.id,
          `Cloud call could exceed the Project daily budget (${projected.toFixed(4)} > ${this.project.budgets.dailyUsd.toFixed(4)} USD before hard-stop fraction).`,
          { currentUsd: daily.knownCostUsd, projectedUsd: projected, limitUsd: this.project.budgets.dailyUsd }
        );
      }
      warnings.push(...warningEvents(
        'daily',
        daily.knownCostUsd,
        projected,
        this.project.budgets.dailyUsd,
        this.project.budgets.warningFractions
      ));
    }

    if (this.project.budgets.monthlyUsd !== undefined) {
      const period = utcMonthPeriod(now);
      const monthly = this.ledger.summarize(this.project.id, period.from, period.to);
      if (monthly.unknownCostEvents > 0) {
        throw new BudgetGuardError(
          'historical-cost-unknown',
          this.project.id,
          'Monthly cloud spend contains unpriced usage; refusing another budgeted cloud call.',
          { scope: 'monthly', unknownCostEvents: monthly.unknownCostEvents }
        );
      }
      const projected = monthly.knownCostUsd + upperCostUsd;
      if (projected > threshold(this.project.budgets.monthlyUsd, this.project.budgets.hardStopFraction)) {
        throw new BudgetGuardError(
          'monthly-budget-exceeded',
          this.project.id,
          `Cloud call could exceed the Project monthly budget (${projected.toFixed(4)} > ${this.project.budgets.monthlyUsd.toFixed(4)} USD before hard-stop fraction).`,
          { currentUsd: monthly.knownCostUsd, projectedUsd: projected, limitUsd: this.project.budgets.monthlyUsd }
        );
      }
      warnings.push(...warningEvents(
        'monthly',
        monthly.knownCostUsd,
        projected,
        this.project.budgets.monthlyUsd,
        this.project.budgets.warningFractions
      ));
    }

    if (this.project.budgets.perJobUsd !== undefined) {
      if (this.jobUnknownCostEvents > 0) {
        throw new BudgetGuardError(
          'historical-cost-unknown',
          this.project.id,
          'This job already contains unpriced cloud usage; refusing another budgeted cloud call.',
          { scope: 'job', unknownCostEvents: this.jobUnknownCostEvents }
        );
      }
      const projected = this.jobKnownCostUsd + upperCostUsd;
      if (projected > threshold(this.project.budgets.perJobUsd, this.project.budgets.hardStopFraction)) {
        throw new BudgetGuardError(
          'job-budget-exceeded',
          this.project.id,
          `Cloud call could exceed the Project per-job budget (${projected.toFixed(4)} > ${this.project.budgets.perJobUsd.toFixed(4)} USD before hard-stop fraction).`,
          { currentUsd: this.jobKnownCostUsd, projectedUsd: projected, limitUsd: this.project.budgets.perJobUsd }
        );
      }
      warnings.push(...warningEvents(
        'job',
        this.jobKnownCostUsd,
        projected,
        this.project.budgets.perJobUsd,
        this.project.budgets.warningFractions
      ));
    }

    this.warningsSeen.push(...warnings);
    return {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      expectedCostUsd: roundUsd(expectedCostUsd),
      upperBoundCostUsd: roundUsd(upperCostUsd),
      warnings
    };
  }

  record(
    stage: InferenceStage,
    candidate: Pick<RoutingCandidate, 'providerId' | 'providerKind' | 'modelId'>,
    result: InferenceResult,
    fallbackUsed: boolean
  ): UsageLedgerEvent {
    const modelPricing = candidate.providerKind === 'cloud'
      ? this.pricing.get(candidate.providerId, candidate.modelId)
      : undefined;
    const costUsd = candidate.providerKind === 'local'
      ? 0
      : modelPricing && hasCompleteBillableUsage(result)
        ? calculateUsageCostUsd(result.usage, modelPricing)
        : undefined;
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
      fallbackUsed
    });
    if (costUsd === undefined && candidate.providerKind === 'cloud') this.jobUnknownCostEvents += 1;
    else this.jobKnownCostUsd = roundUsd(this.jobKnownCostUsd + (costUsd ?? 0));
    return event;
  }

  recordLocalGeneration(
    stage: InferenceStage,
    modelId: string,
    generation: {
      promptTokens?: number;
      completionTokens?: number;
      totalDurationNs?: number;
    }
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
          totalTokens:
            generation.promptTokens !== undefined || generation.completionTokens !== undefined
              ? (generation.promptTokens ?? 0) + (generation.completionTokens ?? 0)
              : undefined
        }
      },
      false
    );
  }

  snapshot(): ProjectBudgetSnapshot {
    const now = this.now();
    const day = utcDayPeriod(now);
    const month = utcMonthPeriod(now);
    return {
      projectId: this.project.id,
      jobId: this.jobId,
      jobKnownCostUsd: this.jobKnownCostUsd,
      jobUnknownCostEvents: this.jobUnknownCostEvents,
      daily: this.ledger.summarize(this.project.id, day.from, day.to),
      monthly: this.ledger.summarize(this.project.id, month.from, month.to),
      warnings: [...this.warningsSeen]
    };
  }
}
