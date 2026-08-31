import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { InferenceStage } from './inference-status.js';
import type { InferenceUsage, ProviderKind } from './providers/types.js';

export interface UsageLedgerEvent {
  version: 1;
  id: string;
  jobId: string;
  timestamp: string;
  projectId: string;
  organizationId: string;
  stage: InferenceStage;
  providerId: string;
  providerKind: ProviderKind;
  modelId: string;
  usage: InferenceUsage;
  latencyMs: number;
  costUsd?: number;
  pricingSource?: string;
  pricingVerifiedAt?: string;
  fallbackUsed: boolean;
}

export interface UsagePeriodSummary {
  projectId: string;
  from: string;
  to: string;
  events: number;
  cloudEvents: number;
  localEvents: number;
  knownCostUsd: number;
  unknownCostEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID.test(trimmed)) throw new Error(`${label} contains unsupported characters.`);
  return trimmed;
}

function safeModel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240 || /[\r\n\0]/.test(trimmed)) {
    throw new Error('Usage model id is invalid.');
  }
  return trimmed;
}

function finiteNonNegative(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative.`);
  return value;
}

function normalizeUsage(input: InferenceUsage): InferenceUsage {
  return {
    inputTokens: finiteNonNegative(input.inputTokens, 'inputTokens'),
    cacheReadInputTokens: finiteNonNegative(input.cacheReadInputTokens, 'cacheReadInputTokens'),
    cacheWriteInputTokens: finiteNonNegative(input.cacheWriteInputTokens, 'cacheWriteInputTokens'),
    outputTokens: finiteNonNegative(input.outputTokens, 'outputTokens'),
    reasoningTokens: finiteNonNegative(input.reasoningTokens, 'reasoningTokens'),
    totalTokens: finiteNonNegative(input.totalTokens, 'totalTokens')
  };
}

function normalizeEvent(input: UsageLedgerEvent): UsageLedgerEvent {
  const timestamp = input.timestamp.trim();
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Usage timestamp is invalid.');
  if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) throw new Error('Usage latencyMs is invalid.');
  if (input.providerKind !== 'local' && input.providerKind !== 'cloud') {
    throw new Error('Usage providerKind is invalid.');
  }
  const costUsd = finiteNonNegative(input.costUsd, 'costUsd');
  return {
    version: 1,
    id: safeId(input.id, 'Usage event id'),
    jobId: safeId(input.jobId, 'Usage job id'),
    timestamp,
    projectId: safeId(input.projectId, 'Usage project id'),
    organizationId: safeId(input.organizationId, 'Usage organization id'),
    stage: input.stage,
    providerId: safeId(input.providerId, 'Usage provider id'),
    providerKind: input.providerKind,
    modelId: safeModel(input.modelId),
    usage: normalizeUsage(input.usage),
    latencyMs: input.latencyMs,
    costUsd,
    pricingSource: input.pricingSource?.trim() || undefined,
    pricingVerifiedAt: input.pricingVerifiedAt?.trim() || undefined,
    fallbackUsed: input.fallbackUsed === true
  };
}

export function usageLedgerPath(): string {
  return process.env.LOCAL_CODER_USAGE_LEDGER_PATH?.trim() ||
    path.join(os.homedir(), '.local-coder-mcp', 'usage-ledger');
}

export class UsageLedger {
  constructor(private readonly root = usageLedgerPath()) {}

  append(input: Omit<UsageLedgerEvent, 'version' | 'id' | 'timestamp'> & {
    id?: string;
    timestamp?: string;
  }): UsageLedgerEvent {
    const event = normalizeEvent({
      ...input,
      version: 1,
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString()
    });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const filename = `${Date.parse(event.timestamp)}-${event.id}.json`;
    const target = path.join(this.root, filename);
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temp, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temp, target);
      try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
    return structuredClone(event);
  }

  list(projectId?: string): UsageLedgerEvent[] {
    const project = projectId ? safeId(projectId, 'Usage project id') : undefined;
    if (!fs.existsSync(this.root)) return [];
    const result: UsageLedgerEvent[] = [];
    for (const file of fs.readdirSync(this.root).filter((name) => name.endsWith('.json')).sort()) {
      const full = path.join(this.root, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(`Could not read usage ledger event ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Usage ledger event ${file} is invalid.`);
      }
      const raw = parsed as UsageLedgerEvent;
      if (raw.version !== 1) throw new Error(`Unsupported usage ledger event version in ${file}.`);
      const event = normalizeEvent(raw);
      if (!project || event.projectId === project) result.push(event);
    }
    return result;
  }

  summarize(projectId: string, from: Date, to: Date): UsagePeriodSummary {
    const project = safeId(projectId, 'Usage project id');
    const fromMs = from.getTime();
    const toMs = to.getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new Error('Usage summary period is invalid.');
    }
    const summary: UsagePeriodSummary = {
      projectId: project,
      from: from.toISOString(),
      to: to.toISOString(),
      events: 0,
      cloudEvents: 0,
      localEvents: 0,
      knownCostUsd: 0,
      unknownCostEvents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0
    };
    for (const event of this.list(project)) {
      const at = Date.parse(event.timestamp);
      if (at < fromMs || at >= toMs) continue;
      summary.events += 1;
      if (event.providerKind === 'cloud') summary.cloudEvents += 1;
      else summary.localEvents += 1;
      if (event.costUsd === undefined && event.providerKind === 'cloud') summary.unknownCostEvents += 1;
      else summary.knownCostUsd += event.costUsd ?? 0;
      summary.inputTokens += event.usage.inputTokens ?? 0;
      summary.outputTokens += event.usage.outputTokens ?? 0;
      summary.cacheReadInputTokens += event.usage.cacheReadInputTokens ?? 0;
      summary.cacheWriteInputTokens += event.usage.cacheWriteInputTokens ?? 0;
      summary.reasoningTokens += event.usage.reasoningTokens ?? 0;
    }
    summary.knownCostUsd = Math.round(summary.knownCostUsd * 1_000_000_000) / 1_000_000_000;
    return summary;
  }
}

export function utcDayPeriod(now = new Date()): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from, to };
}

export function utcMonthPeriod(now = new Date()): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from, to };
}
