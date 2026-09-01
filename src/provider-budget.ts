import { randomUUID } from 'node:crypto';

import {
  PricingStore,
  calculateUsageCostUsd,
  type ModelPricing
} from './pricing-store.js';
import { ProviderSettingsStore } from './provider-settings.js';
import type { InferenceProvider, InferenceRequest, InferenceResult } from './providers/types.js';
import { UsageLedger, utcMonthPeriod, type UsageBudgetReservation } from './usage-ledger.js';

export type ProviderBudgetErrorCode =
  | 'budget-configuration-required'
  | 'pricing-required'
  | 'output-bound-required'
  | 'historical-cost-unknown'
  | 'monthly-budget-exceeded';

export class ProviderBudgetError extends Error {
  constructor(
    readonly code: ProviderBudgetErrorCode,
    readonly providerId: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ProviderBudgetError';
  }
}

export interface ProviderBudgetAdmission {
  providerId: string;
  modelId: string;
  limitUsd: number;
  currentUsd: number;
  projectedUsd: number;
  upperBoundCostUsd: number;
  reservationId: string;
}

export interface ProviderBudgetManagerOptions {
  settings?: ProviderSettingsStore;
  pricing?: PricingStore;
  ledger?: UsageLedger;
  now?: () => Date;
}

export const PROVIDER_BUDGET_PROJECT_ID = 'provider-budget';
const PROVIDER_BUDGET_ORGANIZATION_ID = 'global';
const RECONCILE_DELAYS_MS = [250, 2_500];

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function completeMonthSpend(
  ledger: UsageLedger,
  providerId: string,
  now: Date
): { knownCostUsd: number; unknownCostEvents: number } {
  const month = utcMonthPeriod(now);
  let knownCostUsd = 0;
  let unknownCostEvents = 0;
  for (const event of ledger.list()) {
    if (event.providerId !== providerId || event.providerKind !== 'cloud') continue;
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < month.from.getTime() || timestamp >= month.to.getTime()) continue;
    if (event.costUsd === undefined) unknownCostEvents += 1;
    else knownCostUsd += event.costUsd;
  }
  return { knownCostUsd: roundUsd(knownCostUsd), unknownCostEvents };
}

function providerReservations(
  reservations: UsageBudgetReservation[],
  providerId: string
): UsageBudgetReservation[] {
  return reservations.filter((reservation) =>
    reservation.projectId === PROVIDER_BUDGET_PROJECT_ID &&
    reservation.providerId === providerId
  );
}

function reservationCost(
  reservations: UsageBudgetReservation[],
  providerId: string
): number {
  return roundUsd(providerReservations(reservations, providerId)
    .reduce((sum, reservation) => sum + reservation.upperBoundCostUsd, 0));
}

function upperBoundCost(request: InferenceRequest, pricing: ModelPricing): number | undefined {
  if (
    request.maxOutputTokens === undefined ||
    !Number.isFinite(request.maxOutputTokens) ||
    request.maxOutputTokens <= 0
  ) return undefined;
  const promptBytes = Buffer.byteLength(`${request.systemPrompt}\n${request.userPrompt}`, 'utf8');
  return calculateUsageCostUsd({
    inputTokens: Math.max(1, promptBytes),
    outputTokens: Math.ceil(request.maxOutputTokens)
  }, pricing);
}

function reservationExpiry(now: Date): string {
  return utcMonthPeriod(now).to.toISOString();
}

export class ProviderBudgetManager {
  private readonly settings: ProviderSettingsStore;
  private readonly pricing: PricingStore;
  private readonly ledger: UsageLedger;
  private readonly now: () => Date;

  constructor(options: ProviderBudgetManagerOptions = {}) {
    this.settings = options.settings ?? new ProviderSettingsStore();
    this.pricing = options.pricing ?? new PricingStore();
    this.ledger = options.ledger ?? new UsageLedger();
    this.now = options.now ?? (() => new Date());
  }

  async reconcile(providerId: string): Promise<number> {
    return await this.ledger.withBudgetLock(() => this.reconcileLocked(providerId, this.now()));
  }

  private reconcileLocked(providerId: string, now: Date): number {
    const accounted = new Set(
      this.ledger.list()
        .filter((event) => event.providerId === providerId && event.billingId)
        .map((event) => event.billingId!)
    );
    let released = 0;
    for (const reservation of providerReservations(this.ledger.listReservations(undefined, now), providerId)) {
      if (!accounted.has(reservation.id)) continue;
      if (this.ledger.releaseReservation(reservation.id)) released += 1;
    }
    return released;
  }

  async authorize(provider: InferenceProvider, request: InferenceRequest): Promise<ProviderBudgetAdmission | undefined> {
    if (provider.kind === 'local') return undefined;
    const settings = this.settings.get(provider.id);
    if (settings?.unlimitedUsage === true) return undefined;
    const limitUsd = settings?.monthlyBudgetUsd;
    if (limitUsd === undefined) {
      throw new ProviderBudgetError(
        'budget-configuration-required',
        provider.id,
        `Cloud spend for ${provider.id} is disabled until you explicitly choose Unlimited or set a monthly budget in Settings → Usage.`,
        { modelId: request.model }
      );
    }

    return await this.ledger.withBudgetLock(() => {
      const pricing = this.pricing.get(provider.id, request.model);
      if (!pricing) {
        throw new ProviderBudgetError(
          'pricing-required',
          provider.id,
          `Provider ${provider.id} has a monthly budget but no pricing for ${request.model}.`,
          { modelId: request.model, limitUsd }
        );
      }
      const upper = upperBoundCost(request, pricing);
      if (upper === undefined) {
        throw new ProviderBudgetError(
          'output-bound-required',
          provider.id,
          `Budgeted provider ${provider.id}/${request.model} requires maxOutputTokens before inference.`,
          { modelId: request.model, limitUsd }
        );
      }

      const now = this.now();
      this.reconcileLocked(provider.id, now);
      const month = completeMonthSpend(this.ledger, provider.id, now);
      if (month.unknownCostEvents > 0) {
        throw new ProviderBudgetError(
          'historical-cost-unknown',
          provider.id,
          `Provider ${provider.id} has unpriced cloud usage this month; refusing another budgeted call until pricing is known.`,
          { unknownCostEvents: month.unknownCostEvents, limitUsd }
        );
      }

      const reservedUsd = reservationCost(this.ledger.listReservations(undefined, now), provider.id);
      const currentUsd = roundUsd(month.knownCostUsd + reservedUsd);
      const projectedUsd = roundUsd(currentUsd + upper);
      if (projectedUsd > limitUsd) {
        throw new ProviderBudgetError(
          'monthly-budget-exceeded',
          provider.id,
          `Provider ${provider.id} monthly budget could be exceeded (${projectedUsd.toFixed(4)} > ${limitUsd.toFixed(4)} USD).`,
          {
            currentUsd,
            projectedUsd,
            upperBoundCostUsd: roundUsd(upper),
            limitUsd,
            modelId: request.model
          }
        );
      }

      const reservation = this.ledger.reserve({
        jobId: randomUUID(),
        expiresAt: reservationExpiry(now),
        projectId: PROVIDER_BUDGET_PROJECT_ID,
        organizationId: PROVIDER_BUDGET_ORGANIZATION_ID,
        providerId: provider.id,
        modelId: request.model,
        upperBoundCostUsd: roundUsd(upper),
        timestamp: now.toISOString()
      });
      return {
        providerId: provider.id,
        modelId: request.model,
        limitUsd,
        currentUsd,
        projectedUsd,
        upperBoundCostUsd: roundUsd(upper),
        reservationId: reservation.id
      };
    });
  }

  /** Explicit release is only safe before invoke() has started. */
  release(admission: ProviderBudgetAdmission | undefined): void {
    if (!admission) return;
    this.ledger.releaseReservation(admission.reservationId);
  }

  private scheduleReconcile(providerId: string): void {
    for (const delay of RECONCILE_DELAYS_MS) {
      const timer = setTimeout(() => {
        void this.reconcile(providerId).catch(() => {
          // Fail closed: a failed reconciliation leaves the reservation in place.
        });
      }, delay);
      timer.unref?.();
    }
  }

  wrap(provider: InferenceProvider): InferenceProvider {
    if (provider.kind === 'local') return provider;
    const budget = this;
    return {
      id: provider.id,
      kind: provider.kind,
      capabilities: provider.capabilities,
      listModels: () => provider.listModels(),
      health: () => provider.health(),
      async invoke(request: InferenceRequest): Promise<InferenceResult> {
        const admission = await budget.authorize(provider, request);
        try {
          const result = await provider.invoke(request);
          if (!admission) return result;
          const correlated: InferenceResult = {
            ...result,
            billingId: admission.reservationId
          };
          budget.scheduleReconcile(provider.id);
          return correlated;
        } catch (error) {
          // Once invoke() has started, a transport error cannot prove that the remote
          // provider did not process/bill the request. Keep the upper-bound reservation
          // until month rollover rather than risking an unexpectedly large invoice.
          throw error;
        }
      }
    };
  }
}
