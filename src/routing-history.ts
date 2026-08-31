import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RoutingCandidate } from './cognitive-router.js';
import type { InferenceStage } from './inference-status.js';
import type { RoutingMetrics, RoutingMetricsSource } from './project-provider-runtime.js';
import { projectIsolationKey, type ProjectDefinition } from './project-store.js';

export type RoutingAttemptOutcome = 'success' | 'error';
export type RoutingFailureKind = 'retryable' | 'rate-limited' | 'fatal';

export interface RoutingHistoryEvent {
  version: 1;
  id: string;
  timestamp: string;
  projectId: string;
  organizationId: string;
  stage: InferenceStage;
  providerId: string;
  providerKind: 'local' | 'cloud';
  modelId: string;
  outcome: RoutingAttemptOutcome;
  latencyMs: number;
  fallback: boolean;
  failureKind?: RoutingFailureKind;
}

export interface RoutingHistoryOptions {
  maxAgeMs?: number;
  maxSamplesPerCandidate?: number;
  minSamples?: number;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SAMPLES = 100;
const DEFAULT_MIN_SAMPLES = 3;

function safeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID.test(trimmed)) throw new Error(`${label} contains unsupported characters.`);
  return trimmed;
}

function safeModel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240 || /[\r\n\0]/.test(trimmed)) {
    throw new Error('Routing history model id is invalid.');
  }
  return trimmed;
}

function validTimestamp(value: string): string {
  const trimmed = value.trim();
  if (!Number.isFinite(Date.parse(trimmed))) throw new Error('Routing history timestamp is invalid.');
  return trimmed;
}

function normalizeEvent(input: RoutingHistoryEvent): RoutingHistoryEvent {
  if (input.providerKind !== 'local' && input.providerKind !== 'cloud') {
    throw new Error('Routing history providerKind is invalid.');
  }
  if (input.outcome !== 'success' && input.outcome !== 'error') {
    throw new Error('Routing history outcome is invalid.');
  }
  if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) {
    throw new Error('Routing history latencyMs must be non-negative.');
  }
  if (
    input.failureKind !== undefined &&
    !['retryable', 'rate-limited', 'fatal'].includes(input.failureKind)
  ) {
    throw new Error('Routing history failureKind is invalid.');
  }
  if (input.outcome === 'success' && input.failureKind !== undefined) {
    throw new Error('Successful routing history events cannot have a failureKind.');
  }
  return {
    version: 1,
    id: safeId(input.id, 'Routing history event id'),
    timestamp: validTimestamp(input.timestamp),
    projectId: safeId(input.projectId, 'Routing history project id'),
    organizationId: safeId(input.organizationId, 'Routing history organization id'),
    stage: input.stage,
    providerId: safeId(input.providerId, 'Routing history provider id'),
    providerKind: input.providerKind,
    modelId: safeModel(input.modelId),
    outcome: input.outcome,
    latencyMs: input.latencyMs,
    fallback: input.fallback === true,
    failureKind: input.failureKind
  };
}

function percentile50(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function routingHistoryPath(): string {
  return process.env.LOCAL_CODER_ROUTING_HISTORY_PATH?.trim() ||
    path.join(os.homedir(), '.local-coder-mcp', 'routing-history');
}

export class RoutingHistoryStore {
  private readonly maxAgeMs: number;
  private readonly maxSamplesPerCandidate: number;
  private readonly minSamples: number;

  constructor(
    private readonly root = routingHistoryPath(),
    options: RoutingHistoryOptions = {}
  ) {
    this.maxAgeMs = positiveInt(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
    this.maxSamplesPerCandidate = positiveInt(
      options.maxSamplesPerCandidate,
      DEFAULT_MAX_SAMPLES
    );
    this.minSamples = positiveInt(options.minSamples, DEFAULT_MIN_SAMPLES);
  }

  record(
    project: Pick<ProjectDefinition, 'id' | 'organizationId'>,
    input: {
      stage: InferenceStage;
      candidate: Pick<RoutingCandidate, 'providerId' | 'providerKind' | 'modelId'>;
      outcome: RoutingAttemptOutcome;
      latencyMs: number;
      fallback: boolean;
      failureKind?: RoutingFailureKind;
      timestamp?: string;
      id?: string;
    }
  ): RoutingHistoryEvent {
    const event = normalizeEvent({
      version: 1,
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      projectId: project.id,
      organizationId: project.organizationId,
      stage: input.stage,
      providerId: input.candidate.providerId,
      providerKind: input.candidate.providerKind,
      modelId: input.candidate.modelId,
      outcome: input.outcome,
      latencyMs: input.latencyMs,
      fallback: input.fallback,
      failureKind: input.failureKind
    });
    const dir = this.projectDir(project);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${Date.parse(event.timestamp)}-${event.id}.json`);
    this.atomicWrite(target, event);
    this.compact(project, event.timestamp);
    return structuredClone(event);
  }

  list(
    project: Pick<ProjectDefinition, 'id' | 'organizationId'>,
    now = new Date()
  ): RoutingHistoryEvent[] {
    const dir = this.projectDir(project);
    if (!fs.existsSync(dir)) return [];
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error('Routing history clock is invalid.');
    const cutoff = nowMs - this.maxAgeMs;
    const events: RoutingHistoryEvent[] = [];
    for (const filename of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
      const full = path.join(dir, filename);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(
          `Could not read routing history ${filename}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Routing history ${filename} is invalid.`);
      }
      const raw = parsed as RoutingHistoryEvent;
      if (raw.version !== 1) throw new Error(`Unsupported routing history version in ${filename}.`);
      const event = normalizeEvent(raw);
      if (event.projectId !== project.id || event.organizationId !== project.organizationId) {
        throw new Error(`Routing history isolation mismatch in ${filename}.`);
      }
      if (Date.parse(event.timestamp) >= cutoff && Date.parse(event.timestamp) <= nowMs) {
        events.push(event);
      }
    }
    return events;
  }

  metrics(
    project: Pick<ProjectDefinition, 'id' | 'organizationId'>,
    stage: InferenceStage,
    providerId: string,
    modelId: string,
    now = new Date()
  ): RoutingMetrics | undefined {
    const provider = safeId(providerId, 'Routing history provider id');
    const model = safeModel(modelId);
    const matching = this.list(project, now)
      .filter((event) => event.stage === stage && event.providerId === provider && event.modelId === model)
      .slice(-this.maxSamplesPerCandidate);
    if (matching.length === 0) return undefined;

    const successes = matching.filter((event) => event.outcome === 'success');
    const metrics: RoutingMetrics = { historicalSamples: matching.length };
    if (matching.length >= this.minSamples) {
      metrics.successRate = successes.length / matching.length;
    }
    if (successes.length >= this.minSamples) {
      metrics.p50LatencyMs = percentile50(successes.map((event) => event.latencyMs));
    }
    return metrics;
  }

  forProject(
    project: Pick<ProjectDefinition, 'id' | 'organizationId'>
  ): RoutingMetricsSource {
    const scoped = { id: project.id, organizationId: project.organizationId };
    return {
      get: (projectId, stage, providerId, modelId) => {
        if (projectId !== scoped.id) {
          throw new Error(
            `Routing history scope ${scoped.id} cannot serve metrics for project ${projectId}.`
          );
        }
        return this.metrics(scoped, stage, providerId, modelId);
      }
    };
  }

  private compact(
    project: Pick<ProjectDefinition, 'id' | 'organizationId'>,
    nowIso: string
  ): void {
    const dir = this.projectDir(project);
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs) || !fs.existsSync(dir)) return;
    const cutoff = nowMs - this.maxAgeMs;
    const grouped = new Map<string, Array<{ file: string; at: number }>>();

    for (const filename of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
      const full = path.join(dir, filename);
      let raw: RoutingHistoryEvent;
      try {
        raw = normalizeEvent(JSON.parse(fs.readFileSync(full, 'utf8')) as RoutingHistoryEvent);
      } catch {
        continue;
      }
      const at = Date.parse(raw.timestamp);
      if (at < cutoff) {
        try { fs.unlinkSync(full); } catch { /* best-effort stale cleanup */ }
        continue;
      }
      const key = `${raw.stage}\0${raw.providerId}\0${raw.modelId}`;
      const list = grouped.get(key) ?? [];
      list.push({ file: full, at });
      grouped.set(key, list);
    }

    for (const samples of grouped.values()) {
      samples.sort((a, b) => b.at - a.at);
      for (const sample of samples.slice(this.maxSamplesPerCandidate)) {
        try { fs.unlinkSync(sample.file); } catch { /* best-effort retention cleanup */ }
      }
    }
  }

  private projectDir(project: Pick<ProjectDefinition, 'id' | 'organizationId'>): string {
    safeId(project.id, 'Routing history project id');
    safeId(project.organizationId, 'Routing history organization id');
    return path.join(this.root, projectIsolationKey(project as ProjectDefinition));
  }

  private atomicWrite(target: string, value: unknown): void {
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    try {
      fs.renameSync(temp, target);
      try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}

export function mergeRoutingMetricsSources(
  primary: RoutingMetricsSource | undefined,
  fallback: RoutingMetricsSource
): RoutingMetricsSource {
  return {
    get: async (projectId, stage, providerId, modelId) => {
      const [preferred, historical] = await Promise.all([
        primary?.get(projectId, stage, providerId, modelId),
        fallback.get(projectId, stage, providerId, modelId)
      ]);
      if (!preferred) return historical;
      if (!historical) return preferred;
      return {
        ...historical,
        ...Object.fromEntries(
          Object.entries(preferred).filter(([, value]) => value !== undefined)
        )
      } as RoutingMetrics;
    }
  };
}
