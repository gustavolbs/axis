import { randomUUID } from 'node:crypto';

import type { InferenceStage } from './inference-status.js';
import {
  PricingStore,
  calculateUsageCostUsd
} from './pricing-store.js';
import type { InferenceResult, ProviderKind } from './providers/types.js';
import { UsageLedger, type UsageLedgerEvent } from './usage-ledger.js';

export const PERSONAL_USAGE_PROJECT_ID = 'personal';
export const PERSONAL_USAGE_ORGANIZATION_ID = 'personal';

export interface PersonalUsageRecorderOptions {
  ledger?: UsageLedger;
  pricing?: PricingStore;
  now?: () => Date;
}

function completeBillableUsage(result: InferenceResult): boolean {
  return result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined;
}

export class PersonalUsageRecorder {
  private readonly ledger: UsageLedger;
  private readonly pricing: PricingStore;
  private readonly now: () => Date;

  constructor(options: PersonalUsageRecorderOptions = {}) {
    this.ledger = options.ledger ?? new UsageLedger();
    this.pricing = options.pricing ?? new PricingStore();
    this.now = options.now ?? (() => new Date());
  }

  recordInference(input: {
    jobId?: string;
    stage?: InferenceStage;
    providerId: string;
    providerKind: ProviderKind;
    modelId: string;
    result: InferenceResult;
  }): UsageLedgerEvent {
    const pricing = input.providerKind === 'cloud'
      ? this.pricing.get(input.providerId, input.modelId)
      : undefined;
    const costUsd = input.providerKind === 'local'
      ? 0
      : pricing && completeBillableUsage(input.result)
        ? calculateUsageCostUsd(input.result.usage, pricing)
        : undefined;

    return this.ledger.append({
      jobId: input.jobId?.trim() || randomUUID(),
      projectId: PERSONAL_USAGE_PROJECT_ID,
      organizationId: PERSONAL_USAGE_ORGANIZATION_ID,
      stage: input.stage ?? 'other',
      providerId: input.providerId,
      providerKind: input.providerKind,
      modelId: input.modelId,
      usage: input.result.usage,
      latencyMs: input.result.latencyMs,
      costUsd,
      pricingSource: pricing?.source,
      pricingVerifiedAt: pricing?.verifiedAt,
      billingId: input.result.billingId,
      fallbackUsed: false,
      timestamp: this.now().toISOString()
    });
  }

  recordLocalGeneration(input: {
    jobId?: string;
    modelId: string;
    promptTokens?: number;
    completionTokens?: number;
    totalDurationNs?: number;
  }): UsageLedgerEvent {
    const inputTokens = input.promptTokens;
    const outputTokens = input.completionTokens;
    return this.recordInference({
      jobId: input.jobId,
      providerId: 'ollama',
      providerKind: 'local',
      modelId: input.modelId,
      result: {
        providerId: 'ollama',
        model: input.modelId,
        content: '',
        latencyMs: input.totalDurationNs ? Math.max(0, input.totalDurationNs / 1_000_000) : 0,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens:
            inputTokens !== undefined || outputTokens !== undefined
              ? (inputTokens ?? 0) + (outputTokens ?? 0)
              : undefined
        }
      }
    });
  }
}
