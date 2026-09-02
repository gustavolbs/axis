import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { InferenceRequest, InferenceUsage } from './providers/types.js';
import { UsageLedger } from './usage-ledger.js';

export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  source?: string;
  verifiedAt?: string;
}

interface PricingFile {
  version: 1;
  providers: Record<string, Record<string, ModelPricing>>;
  updatedAt: string;
}

const BUILT_IN_PRICING: PricingFile['providers'] = {
  openai: {
    'gpt-5.6-sol': { inputPerMillionUsd: 4, outputPerMillionUsd: 20, cacheReadPerMillionUsd: 0.4, source: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol', verifiedAt: '2026-09-01' },
    'gpt-5.6-terra': { inputPerMillionUsd: 2, outputPerMillionUsd: 12, cacheReadPerMillionUsd: 0.2, source: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra', verifiedAt: '2026-09-01' },
    'gpt-5.6-luna': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2, cacheReadPerMillionUsd: 0.02, source: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna', verifiedAt: '2026-09-01' },
    'gpt-5.4-mini': { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5, cacheReadPerMillionUsd: 0.075, source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini', verifiedAt: '2026-09-01' },
    'gpt-5.5-pro': { inputPerMillionUsd: 30, outputPerMillionUsd: 180, source: 'https://developers.openai.com/api/docs/models/gpt-5.5-pro', verifiedAt: '2026-09-01' }
  },
  anthropic: {
    'claude-fable-5': { inputPerMillionUsd: 10, outputPerMillionUsd: 50, cacheReadPerMillionUsd: 1, cacheWritePerMillionUsd: 12.5, source: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-09-01' },
    'claude-opus-5': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheReadPerMillionUsd: 0.5, cacheWritePerMillionUsd: 6.25, source: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-09-01' },
    'claude-sonnet-5': { inputPerMillionUsd: 2, outputPerMillionUsd: 10, cacheReadPerMillionUsd: 0.2, cacheWritePerMillionUsd: 2.5, source: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-09-01' },
    'claude-haiku-4-5-20251001': { inputPerMillionUsd: 1, outputPerMillionUsd: 5, cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 1.25, source: 'https://platform.claude.com/docs/en/about-claude/pricing', verifiedAt: '2026-09-01' }
  }
};

function builtInProviders(): PricingFile['providers'] {
  return structuredClone(BUILT_IN_PRICING);
}

const SAFE_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function providerId(value: string): string {
  const trimmed = value.trim();
  if (!SAFE_PROVIDER.test(trimmed)) throw new Error('Pricing provider id contains unsupported characters.');
  return trimmed;
}

/**
 * API connection ids are routing/audit identities, not separate billing products.
 * They inherit the price sheet of their provider family while ledger events keep the
 * exact connection id for provenance.
 */
export function pricingProviderId(value: string): string {
  const id = providerId(value);
  if (/^openai-api-[a-f0-9]{12}$/.test(id)) return 'openai';
  if (/^anthropic-api-[a-f0-9]{12}$/.test(id)) return 'anthropic';
  return id;
}

function modelId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240 || /[\r\n\0]/.test(trimmed)) {
    throw new Error('Pricing model id must be 1-240 characters without control line breaks.');
  }
  return trimmed;
}

function builtInPricingAlias(provider: string, model: string): string | undefined {
  if (provider !== 'anthropic') return undefined;
  if (model === 'claude-haiku-4-5') return 'claude-haiku-4-5-20251001';
  return undefined;
}

function money(value: number | undefined, label: string, required = false): number | undefined {
  if (value === undefined) {
    if (required) throw new Error(`${label} is required.`);
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number.`);
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function normalizePricing(input: ModelPricing): ModelPricing {
  const source = input.source?.trim();
  const verifiedAt = input.verifiedAt?.trim();
  if (source && source.length > 1000) throw new Error('Pricing source is too long.');
  if (verifiedAt && !Number.isFinite(Date.parse(verifiedAt))) throw new Error('Pricing verifiedAt must be an ISO-compatible date.');
  return {
    inputPerMillionUsd: money(input.inputPerMillionUsd, 'Input price', true)!,
    outputPerMillionUsd: money(input.outputPerMillionUsd, 'Output price', true)!,
    cacheReadPerMillionUsd: money(input.cacheReadPerMillionUsd, 'Cache-read price'),
    cacheWritePerMillionUsd: money(input.cacheWritePerMillionUsd, 'Cache-write price'),
    source: source || undefined,
    verifiedAt: verifiedAt || undefined
  };
}

export function pricingStorePath(): string {
  return process.env.LOCAL_CODER_PRICING_PATH?.trim() || path.join(os.homedir(), '.local-coder-mcp', 'pricing.json');
}

export class PricingStore {
  constructor(private readonly file = pricingStorePath()) {}

  get(provider: string, model: string): ModelPricing | undefined {
    const state = this.read();
    const requested = providerId(provider);
    const canonical = pricingProviderId(requested);
    const modelKey = modelId(model);
    const alias = builtInPricingAlias(canonical, modelKey);
    const requestedModels = state.providers[requested];
    const canonicalModels = state.providers[canonical];
    const value = requestedModels?.[modelKey] ??
      (alias ? requestedModels?.[alias] : undefined) ??
      canonicalModels?.[modelKey] ??
      (alias ? canonicalModels?.[alias] : undefined);
    return value ? structuredClone(value) : undefined;
  }

  list(): Record<string, Record<string, ModelPricing>> {
    return structuredClone(this.read().providers);
  }

  set(provider: string, model: string, pricing: ModelPricing): ModelPricing {
    const providerKey = providerId(provider);
    const modelKey = modelId(model);
    const normalized = normalizePricing(pricing);
    const state = this.read();
    state.providers[providerKey] ??= {};
    state.providers[providerKey]![modelKey] = normalized;
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return structuredClone(normalized);
  }

  remove(provider: string, model: string): boolean {
    const providerKey = providerId(provider);
    const modelKey = modelId(model);
    const state = this.read();
    const models = state.providers[providerKey];
    if (!models || !(modelKey in models)) return false;
    delete models[modelKey];
    if (Object.keys(models).length === 0) delete state.providers[providerKey];
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return true;
  }

  private read(): PricingFile {
    if (!fs.existsSync(this.file)) return { version: 1, providers: builtInProviders(), updatedAt: new Date(0).toISOString() };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read pricing settings: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Pricing settings must be a JSON object.');
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
      throw new Error(`Unsupported pricing settings version: ${String(value.version)}`);
    }
    const providers: PricingFile['providers'] = builtInProviders();
    for (const [rawProvider, rawModels] of Object.entries(value.providers as Record<string, unknown>)) {
      if (!rawModels || typeof rawModels !== 'object' || Array.isArray(rawModels)) throw new Error(`Invalid pricing model map for ${rawProvider}.`);
      const providerKey = providerId(rawProvider);
      providers[providerKey] ??= {};
      for (const [rawModel, rawPricing] of Object.entries(rawModels as Record<string, unknown>)) {
        if (!rawPricing || typeof rawPricing !== 'object' || Array.isArray(rawPricing)) throw new Error(`Invalid pricing entry for ${rawProvider}/${rawModel}.`);
        providers[providerKey]![modelId(rawModel)] = normalizePricing(rawPricing as ModelPricing);
      }
    }
    return {
      version: 1,
      providers,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: PricingFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}

export function backfillKnownUsagePricing(
  ledger: UsageLedger,
  pricing: PricingStore,
  onlyProviderId?: string
): number {
  return ledger.backfillUnpriced((event) => {
    if (onlyProviderId && event.providerId !== onlyProviderId) return undefined;
    const modelPricing = pricing.get(event.providerId, event.modelId);
    if (!modelPricing) return undefined;
    return {
      costUsd: calculateUsageCostUsd(event.usage, modelPricing),
      pricingSource: modelPricing.source,
      pricingVerifiedAt: modelPricing.verifiedAt
    };
  });
}

function tokenCost(tokens: number | undefined, perMillionUsd: number | undefined): number {
  if (!tokens || perMillionUsd === undefined) return 0;
  return (tokens / 1_000_000) * perMillionUsd;
}

export function calculateUsageCostUsd(usage: InferenceUsage, pricing: ModelPricing): number {
  const input = Math.max(0, usage.inputTokens ?? 0);
  const cacheRead = Math.min(input, Math.max(0, usage.cacheReadInputTokens ?? 0));
  const cacheWrite = Math.min(input - cacheRead, Math.max(0, usage.cacheWriteInputTokens ?? 0));
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  const output = Math.max(0, usage.outputTokens ?? 0);
  const total =
    tokenCost(uncached, pricing.inputPerMillionUsd) +
    tokenCost(cacheRead, pricing.cacheReadPerMillionUsd ?? pricing.inputPerMillionUsd) +
    tokenCost(cacheWrite, pricing.cacheWritePerMillionUsd ?? pricing.inputPerMillionUsd) +
    tokenCost(output, pricing.outputPerMillionUsd);
  return Math.round(total * 1_000_000_000) / 1_000_000_000;
}

export interface RequestCostEstimate {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  estimatedCostUsd: number;
}

export function estimateRequestCostUsd(
  request: Pick<InferenceRequest, 'systemPrompt' | 'userPrompt' | 'maxOutputTokens'>,
  pricing: ModelPricing
): RequestCostEstimate | undefined {
  if (request.maxOutputTokens === undefined || !Number.isFinite(request.maxOutputTokens) || request.maxOutputTokens <= 0) return undefined;
  const promptBytes = Buffer.byteLength(`${request.systemPrompt}\n${request.userPrompt}`, 'utf8');
  const estimatedInputTokens = Math.max(1, Math.ceil(promptBytes / 3));
  const maxOutputTokens = Math.ceil(request.maxOutputTokens);
  const estimatedCostUsd = calculateUsageCostUsd(
    { inputTokens: estimatedInputTokens, outputTokens: maxOutputTokens },
    pricing
  );
  return { estimatedInputTokens, maxOutputTokens, estimatedCostUsd };
}
