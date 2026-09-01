import { UsageLedger, utcMonthPeriod, type UsageLedgerEvent } from './usage-ledger.js';
import type { ProviderKind } from './providers/types.js';

export type UsageDashboardPeriod = '7d' | '30d' | 'month' | 'all';

export interface UsageAggregate {
  calls: number;
  localCalls: number;
  cloudCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  knownCostUsd: number;
  unknownCostEvents: number;
}

export interface UsageProviderSummary extends UsageAggregate {
  providerId: string;
  providerKind: ProviderKind;
}

export interface UsageModelSummary extends UsageAggregate {
  providerId: string;
  providerKind: ProviderKind;
  modelId: string;
}

export interface UsageTimelinePoint extends UsageAggregate {
  key: string;
  label: string;
}

export interface UsageDashboardView {
  period: UsageDashboardPeriod;
  from: string;
  to: string;
  totals: UsageAggregate;
  currentMonth: UsageAggregate & { from: string; to: string };
  providers: UsageProviderSummary[];
  models: UsageModelSummary[];
  timeline: {
    interval: 'day' | 'month';
    points: UsageTimelinePoint[];
  };
}

interface MutableAggregate extends UsageAggregate {}

function emptyAggregate(): MutableAggregate {
  return {
    calls: 0,
    localCalls: 0,
    cloudCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    knownCostUsd: 0,
    unknownCostEvents: 0
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function token(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0;
}

function addEvent(target: MutableAggregate, event: UsageLedgerEvent): void {
  const input = token(event.usage.inputTokens);
  const output = token(event.usage.outputTokens);
  target.calls += 1;
  if (event.providerKind === 'local') target.localCalls += 1;
  else target.cloudCalls += 1;
  target.inputTokens += input;
  target.outputTokens += output;
  target.cacheReadInputTokens += token(event.usage.cacheReadInputTokens);
  target.cacheWriteInputTokens += token(event.usage.cacheWriteInputTokens);
  target.reasoningTokens += token(event.usage.reasoningTokens);
  target.totalTokens += input + output;
  if (event.providerKind === 'cloud' && event.costUsd === undefined) {
    target.unknownCostEvents += 1;
  } else {
    target.knownCostUsd += event.costUsd ?? 0;
  }
}

function finish<T extends MutableAggregate>(value: T): T {
  value.knownCostUsd = roundUsd(value.knownCostUsd);
  return value;
}

function rangeFor(period: UsageDashboardPeriod, now: Date, events: UsageLedgerEvent[]): { from: Date; to: Date } {
  const to = new Date(now.getTime() + 1);
  if (period === 'month') {
    const month = utcMonthPeriod(now);
    return { from: month.from, to };
  }
  if (period === '7d' || period === '30d') {
    const days = period === '7d' ? 7 : 30;
    return { from: new Date(now.getTime() - days * 86_400_000), to };
  }
  const first = events
    .map((event) => Date.parse(event.timestamp))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return { from: new Date(first ?? now.getTime()), to };
}

function inRange(event: UsageLedgerEvent, from: Date, to: Date): boolean {
  const at = Date.parse(event.timestamp);
  return Number.isFinite(at) && at >= from.getTime() && at < to.getTime();
}

function timelineInterval(from: Date, to: Date): 'day' | 'month' {
  return to.getTime() - from.getTime() > 93 * 86_400_000 ? 'month' : 'day';
}

function timelineKey(event: UsageLedgerEvent, interval: 'day' | 'month'): string {
  return interval === 'month' ? event.timestamp.slice(0, 7) : event.timestamp.slice(0, 10);
}

function timelineLabel(key: string, interval: 'day' | 'month'): string {
  if (interval === 'month') {
    const [year, month] = key.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
      .format(new Date(Date.UTC(year, Math.max(0, month - 1), 1)));
  }
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, Math.max(0, month - 1), day)));
}

function providerKey(event: UsageLedgerEvent): string {
  return `${event.providerId}\0${event.providerKind}`;
}

function modelKey(event: UsageLedgerEvent): string {
  return `${event.providerId}\0${event.providerKind}\0${event.modelId}`;
}

function sortAggregate<T extends UsageAggregate>(values: T[]): T[] {
  return values.sort((a, b) =>
    b.knownCostUsd - a.knownCostUsd ||
    b.totalTokens - a.totalTokens ||
    b.calls - a.calls
  );
}

export function parseUsageDashboardPeriod(value: string | null | undefined): UsageDashboardPeriod {
  if (value === undefined || value === null || value === '') return '30d';
  if (value === '7d' || value === '30d' || value === 'month' || value === 'all') return value;
  throw new Error('Usage period must be 7d, 30d, month, or all.');
}

export class UsageDashboard {
  constructor(private readonly ledger = new UsageLedger()) {}

  summary(period: UsageDashboardPeriod = '30d', now = new Date()): UsageDashboardView {
    if (!Number.isFinite(now.getTime())) throw new Error('Usage dashboard clock is invalid.');
    const allEvents = this.ledger.list();
    const { from, to } = rangeFor(period, now, allEvents);
    const selected = allEvents.filter((event) => inRange(event, from, to));
    const totals = emptyAggregate();
    const providers = new Map<string, UsageProviderSummary>();
    const models = new Map<string, UsageModelSummary>();

    for (const event of selected) {
      addEvent(totals, event);

      const pKey = providerKey(event);
      const provider = providers.get(pKey) ?? {
        providerId: event.providerId,
        providerKind: event.providerKind,
        ...emptyAggregate()
      };
      addEvent(provider, event);
      providers.set(pKey, provider);

      const mKey = modelKey(event);
      const model = models.get(mKey) ?? {
        providerId: event.providerId,
        providerKind: event.providerKind,
        modelId: event.modelId,
        ...emptyAggregate()
      };
      addEvent(model, event);
      models.set(mKey, model);
    }

    const month = utcMonthPeriod(now);
    const currentMonth = emptyAggregate();
    for (const event of allEvents) {
      if (inRange(event, month.from, month.to)) addEvent(currentMonth, event);
    }

    const interval = timelineInterval(from, to);
    const points = new Map<string, UsageTimelinePoint>();
    for (const event of selected) {
      const key = timelineKey(event, interval);
      const point = points.get(key) ?? { key, label: timelineLabel(key, interval), ...emptyAggregate() };
      addEvent(point, event);
      points.set(key, point);
    }

    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      totals: finish(totals),
      currentMonth: {
        from: month.from.toISOString(),
        to: month.to.toISOString(),
        ...finish(currentMonth)
      },
      providers: sortAggregate([...providers.values()].map(finish)),
      models: sortAggregate([...models.values()].map(finish)),
      timeline: {
        interval,
        points: [...points.values()].sort((a, b) => a.key.localeCompare(b.key)).map(finish)
      }
    };
  }
}
