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
  /** Correlates a billable provider reservation with the durable usage event. */
  billingId?: string;
  fallbackUsed: boolean;
}

export interface UsageBudgetReservation {
  version: 1;
  id: string;
  jobId: string;
  timestamp: string;
  expiresAt: string;
  projectId: string;
  organizationId: string;
  providerId: string;
  modelId: string;
  upperBoundCostUsd: number;
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
const RESERVATION_PREFIX = 'reservation-';
const BUDGET_LOCK = '.budget.lock';

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

function validTimestamp(value: string, label: string): string {
  const trimmed = value.trim();
  if (!Number.isFinite(Date.parse(trimmed))) throw new Error(`${label} is invalid.`);
  return trimmed;
}

function normalizeEvent(input: UsageLedgerEvent): UsageLedgerEvent {
  const timestamp = validTimestamp(input.timestamp, 'Usage timestamp');
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
    billingId: input.billingId ? safeId(input.billingId, 'Usage billing id') : undefined,
    fallbackUsed: input.fallbackUsed === true
  };
}

function normalizeReservation(input: UsageBudgetReservation): UsageBudgetReservation {
  const timestamp = validTimestamp(input.timestamp, 'Reservation timestamp');
  const expiresAt = validTimestamp(input.expiresAt, 'Reservation expiry');
  if (Date.parse(expiresAt) <= Date.parse(timestamp)) {
    throw new Error('Reservation expiry must be after its timestamp.');
  }
  return {
    version: 1,
    id: safeId(input.id, 'Reservation id'),
    jobId: safeId(input.jobId, 'Reservation job id'),
    timestamp,
    expiresAt,
    projectId: safeId(input.projectId, 'Reservation project id'),
    organizationId: safeId(input.organizationId, 'Reservation organization id'),
    providerId: safeId(input.providerId, 'Reservation provider id'),
    modelId: safeModel(input.modelId),
    upperBoundCostUsd: finiteNonNegative(input.upperBoundCostUsd, 'Reservation upperBoundCostUsd') ?? 0
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
    this.atomicWrite(target, event);
    return structuredClone(event);
  }

  reserve(input: Omit<UsageBudgetReservation, 'version' | 'id' | 'timestamp'> & {
    id?: string;
    timestamp?: string;
  }): UsageBudgetReservation {
    const reservation = normalizeReservation({
      ...input,
      version: 1,
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString()
    });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.atomicWrite(this.reservationPath(reservation.id), reservation);
    return structuredClone(reservation);
  }

  releaseReservation(id: string): boolean {
    const reservationId = safeId(id, 'Reservation id');
    try {
      fs.unlinkSync(this.reservationPath(reservationId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  listReservations(projectId?: string, now = new Date()): UsageBudgetReservation[] {
    const project = projectId ? safeId(projectId, 'Reservation project id') : undefined;
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error('Reservation clock is invalid.');
    if (!fs.existsSync(this.root)) return [];
    const result: UsageBudgetReservation[] = [];
    for (const file of fs.readdirSync(this.root).filter((name) => name.startsWith(RESERVATION_PREFIX) && name.endsWith('.json')).sort()) {
      const full = path.join(this.root, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(`Could not read usage reservation ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Usage reservation ${file} is invalid.`);
      }
      const raw = parsed as UsageBudgetReservation;
      if (raw.version !== 1) throw new Error(`Unsupported usage reservation version in ${file}.`);
      const reservation = normalizeReservation(raw);
      if (Date.parse(reservation.expiresAt) <= nowMs) {
        try { fs.unlinkSync(full); } catch { /* best-effort stale reservation cleanup */ }
        continue;
      }
      if (!project || reservation.projectId === project) result.push(reservation);
    }
    return result;
  }

  async withBudgetLock<T>(run: () => T | Promise<T>): Promise<T> {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.root, BUDGET_LOCK);
    const deadline = Date.now() + 10_000;
    const staleAfterMs = 30_000;

    while (true) {
      try {
        const handle = await fs.promises.open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
          return await run();
        } finally {
          await handle.close().catch(() => undefined);
          await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleAfterMs) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for usage budget lock at ${lockPath}.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  list(projectId?: string): UsageLedgerEvent[] {
    const project = projectId ? safeId(projectId, 'Usage project id') : undefined;
    if (!fs.existsSync(this.root)) return [];
    const result: UsageLedgerEvent[] = [];
    for (const file of fs.readdirSync(this.root)
      .filter((name) => name.endsWith('.json') && !name.startsWith(RESERVATION_PREFIX))
      .sort()) {
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

  private reservationPath(id: string): string {
    return path.join(this.root, `${RESERVATION_PREFIX}${id}.json`);
  }

  private atomicWrite(target: string, value: unknown): void {
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temp, target);
      try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
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
