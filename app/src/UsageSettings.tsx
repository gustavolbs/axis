import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';

interface UsageAggregate {
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

interface UsageProviderSummary extends UsageAggregate {
  providerId: string;
  providerKind: 'local' | 'cloud';
}

interface UsageModelSummary extends UsageProviderSummary {
  modelId: string;
}

interface UsageTimelinePoint extends UsageAggregate {
  key: string;
  label: string;
}

type UsagePeriod = '7d' | '30d' | 'month' | 'all';
type UsageTab = 'overview' | 'models';

interface UsageDashboardView {
  period: UsagePeriod;
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

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function tokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 1 : 2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toLocaleString('en-US');
}

function usd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2
  }).format(value);
}

function costLabel(usage: Pick<UsageAggregate, 'knownCostUsd' | 'unknownCostEvents'>): string {
  if (usage.unknownCostEvents === 0) return usd(usage.knownCostUsd);
  return `${usd(usage.knownCostUsd)} known · ${usage.unknownCostEvents} unpriced`;
}

function providerLabel(id: string): string {
  if (id === 'openai') return 'OpenAI';
  if (id === 'anthropic') return 'Anthropic';
  if (id === 'ollama') return 'Ollama';
  return id;
}

function updatedLabel(value: Date | undefined): string {
  if (!value) return 'Not updated yet';
  return `Last updated ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(value)}`;
}

function UsageChart({ points }: { points: UsageTimelinePoint[] }) {
  if (points.length === 0) {
    return <div className="usage-empty">No token usage in this period yet.</div>;
  }

  const width = 820;
  const height = 260;
  const top = 14;
  const bottom = 34;
  const left = 60;
  const right = 10;
  const baseline = height - bottom;
  const plotHeight = baseline - top;
  const max = Math.max(1, ...points.map((point) => point.totalTokens));
  const roundedMax = Math.max(1, Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)))) * Math.pow(10, Math.floor(Math.log10(max))));
  const slot = (width - left - right) / points.length;
  const barWidth = Math.max(3, Math.min(22, slot * 0.72));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const ticks = [1, 0.75, 0.5, 0.25, 0];

  return <svg
    className="usage-chart"
    viewBox={`0 0 ${width} ${height}`}
    width="100%"
    height="260"
    role="img"
    aria-label="Token usage over time"
  >
    {ticks.map((fraction) => {
      const y = top + (1 - fraction) * plotHeight;
      return <g key={fraction}>
        <text x={left - 12} y={y + 4} textAnchor="end" className="usage-axis-label">
          {tokens(roundedMax * fraction)}
        </text>
        {fraction > 0 ? <line x1={left} y1={y} x2={width - right} y2={y} className="usage-grid-line" /> : null}
      </g>;
    })}
    {points.map((point, index) => {
      const x = left + index * slot + (slot - barWidth) / 2;
      const inputHeight = (point.inputTokens / roundedMax) * plotHeight;
      const outputHeight = (point.outputTokens / roundedMax) * plotHeight;
      const totalHeight = inputHeight + outputHeight;
      const showLabel = index % labelEvery === 0 || index === points.length - 1;
      return <g key={point.key}>
        {outputHeight > 0 ? <rect
          x={x}
          y={baseline - outputHeight}
          width={barWidth}
          height={outputHeight}
          rx="2"
          className="usage-bar-output"
        /> : null}
        {inputHeight > 0 ? <rect
          x={x}
          y={baseline - totalHeight}
          width={barWidth}
          height={inputHeight}
          rx="2"
          className="usage-bar-input"
        /> : null}
        {showLabel ? <text
          x={x + barWidth / 2}
          y={height - 8}
          textAnchor="middle"
          className="usage-axis-label usage-x-label"
        >{point.label}</text> : null}
      </g>;
    })}
  </svg>;
}

function Share({ value }: { value: number }) {
  return <span className="usage-share">
    {new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(value)}
  </span>;
}

export function UsageSettings() {
  const [period, setPeriod] = useState<UsagePeriod>('30d');
  const [tab, setTab] = useState<UsageTab>('models');
  const [usage, setUsage] = useState<UsageDashboardView>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const { usage: next } = await api<{ usage: UsageDashboardView }>(`/api/usage?period=${period}`);
      setUsage(next);
      setLastUpdated(new Date());
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalTokens = usage?.totals.totalTokens ?? 0;
  const modelRows = useMemo(() => usage?.models ?? [], [usage]);
  const providerRows = useMemo(() => usage?.providers ?? [], [usage]);

  return <div className="focused-settings-page usage-settings-page">
    <style>{`
      .usage-settings-page { width: min(760px, calc(100% - 48px)); }
      .usage-settings-page > header { align-items: flex-end; margin-bottom: 18px; }
      .usage-page-meta { display: flex; align-items: center; gap: 9px; color: var(--lc-muted); font-size: 10.5px; white-space: nowrap; }
      .usage-refresh { display: grid; place-items: center; width: 27px; height: 27px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--lc-muted); cursor: pointer; }
      .usage-refresh:hover { background: var(--lc-surface-2); color: var(--lc-text); }
      .usage-refresh:disabled { opacity: .5; cursor: default; }
      .usage-refresh.loading svg { animation: usage-spin .8s linear infinite; }
      @keyframes usage-spin { to { transform: rotate(360deg); } }
      .usage-shell { overflow: hidden; border: 1px solid var(--lc-border); border-radius: 14px; background: var(--lc-surface); }
      .usage-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 12px 9px 14px; }
      .usage-tabs, .usage-periods { display: flex; align-items: center; gap: 3px; }
      .usage-tabs button, .usage-periods button { border: 0; border-radius: 7px; background: transparent; color: var(--lc-muted); font: inherit; font-size: 11px; cursor: pointer; }
      .usage-tabs button { padding: 7px 10px; }
      .usage-periods button { padding: 7px 9px; }
      .usage-tabs button.active, .usage-periods button.active { background: var(--lc-surface-2); color: var(--lc-text); }
      .usage-chart-wrap { padding: 10px 12px 0 4px; border-top: 1px solid color-mix(in srgb, var(--lc-border) 60%, transparent); }
      .usage-chart { display: block; color: var(--lc-muted); }
      .usage-axis-label { fill: var(--lc-muted); font-size: 10px; }
      .usage-x-label { opacity: .78; }
      .usage-grid-line { stroke: var(--lc-border); stroke-width: .7; opacity: .28; }
      .usage-bar-output { fill: #4f86dc; }
      .usage-bar-input { fill: #86aee9; }
      .usage-summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; border-top: 1px solid var(--lc-border); background: var(--lc-border); }
      .usage-summary-item { min-width: 0; padding: 10px 13px; background: var(--lc-surface); }
      .usage-summary-item small, .usage-summary-item strong { display: block; }
      .usage-summary-item small { margin-bottom: 4px; color: var(--lc-muted); font-size: 9.5px; }
      .usage-summary-item strong { overflow: hidden; color: var(--lc-text); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .usage-list { border-top: 1px solid var(--lc-border); }
      .usage-row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(180px, .9fr) 62px; gap: 12px; align-items: center; min-height: 39px; padding: 6px 15px; }
      .usage-row + .usage-row { border-top: 1px solid color-mix(in srgb, var(--lc-border) 55%, transparent); }
      .usage-row-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .usage-dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 2px; background: #4f86dc; }
      .usage-row-main strong { overflow: hidden; color: var(--lc-text-soft); font-size: 11px; font-weight: 540; text-overflow: ellipsis; white-space: nowrap; }
      .usage-row-main small { color: var(--lc-muted); font-size: 9px; }
      .usage-row-numbers { color: var(--lc-muted); font-size: 10px; text-align: right; white-space: nowrap; }
      .usage-row-cost { display: block; margin-top: 2px; color: var(--lc-text-soft); font-size: 9px; }
      .usage-share { color: var(--lc-text-soft); font-size: 10.5px; font-weight: 560; text-align: right; }
      .usage-note { margin: 10px 3px 0; color: var(--lc-faint); font-size: 9.5px; line-height: 1.45; }
      .usage-empty { display: grid; min-height: 170px; place-items: center; color: var(--lc-muted); font-size: 11px; }
      .usage-error { margin-bottom: 12px; color: var(--lc-negative); font-size: 10.5px; }
      @media (max-width: 720px) {
        .usage-settings-page { width: calc(100% - 28px); }
        .usage-settings-page > header { align-items: flex-start; flex-direction: column; }
        .usage-page-meta { align-self: flex-end; }
        .usage-toolbar { align-items: flex-start; flex-direction: column; }
        .usage-row { grid-template-columns: minmax(0, 1fr) auto; }
        .usage-row-numbers { grid-column: 1 / -1; grid-row: 2; text-align: left; }
        .usage-summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    `}</style>

    <header>
      <div>
        <h1>Usage</h1>
        <p>Token usage and API spend across local and cloud providers.</p>
      </div>
      <div className="usage-page-meta">
        <span>{updatedLabel(lastUpdated)}</span>
        <button
          className={`usage-refresh ${loading ? 'loading' : ''}`}
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh usage"
          title="Refresh usage"
        >
          <RefreshCw size={14} />
        </button>
      </div>
    </header>

    {error ? <div className="usage-error" role="alert">{error}</div> : null}

    <section className="usage-shell" aria-busy={loading}>
      <div className="usage-toolbar">
        <div className="usage-tabs" role="tablist" aria-label="Usage breakdown">
          <button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
          <button role="tab" aria-selected={tab === 'models'} className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>Models</button>
        </div>
        <div className="usage-periods" role="radiogroup" aria-label="Usage period">
          {([
            ['all', 'All'],
            ['month', 'Month'],
            ['30d', '30d'],
            ['7d', '7d']
          ] as Array<[UsagePeriod, string]>).map(([value, label]) => <button
            key={value}
            className={period === value ? 'active' : ''}
            role="radio"
            aria-checked={period === value}
            onClick={() => setPeriod(value)}
          >{label}</button>)}
        </div>
      </div>

      <div className="usage-chart-wrap">
        {usage ? <UsageChart points={usage.timeline.points} /> : <div className="usage-empty">Loading usage…</div>}
      </div>

      {usage ? <>
        <div className="usage-summary-strip">
          <div className="usage-summary-item"><small>Month spend</small><strong>{costLabel(usage.currentMonth)}</strong></div>
          <div className="usage-summary-item"><small>Input</small><strong>{tokens(usage.totals.inputTokens)}</strong></div>
          <div className="usage-summary-item"><small>Output</small><strong>{tokens(usage.totals.outputTokens)}</strong></div>
          <div className="usage-summary-item"><small>Calls</small><strong>{usage.totals.calls.toLocaleString('en-US')}</strong></div>
        </div>

        <div className="usage-list">
          {tab === 'models' ? modelRows.map((model) => {
            const share = totalTokens === 0 ? 0 : model.totalTokens / totalTokens;
            return <div className="usage-row" key={`${model.providerId}:${model.modelId}`}>
              <div className="usage-row-main">
                <span className="usage-dot" />
                <div>
                  <strong>{model.modelId}</strong>
                  <small>{providerLabel(model.providerId)}</small>
                </div>
              </div>
              <div className="usage-row-numbers">
                {tokens(model.inputTokens)} in · {tokens(model.outputTokens)} out
                <span className="usage-row-cost">{model.providerKind === 'local' ? usd(0) : costLabel(model)}</span>
              </div>
              <Share value={share} />
            </div>;
          }) : providerRows.map((provider) => {
            const share = totalTokens === 0 ? 0 : provider.totalTokens / totalTokens;
            return <div className="usage-row" key={`${provider.providerId}:${provider.providerKind}`}>
              <div className="usage-row-main">
                <span className="usage-dot" />
                <div>
                  <strong>{providerLabel(provider.providerId)}</strong>
                  <small>{provider.providerKind}</small>
                </div>
              </div>
              <div className="usage-row-numbers">
                {tokens(provider.inputTokens)} in · {tokens(provider.outputTokens)} out
                <span className="usage-row-cost">{provider.providerKind === 'local' ? usd(0) : costLabel(provider)}</span>
              </div>
              <Share value={share} />
            </div>;
          })}
          {tab === 'models' && modelRows.length === 0 ? <div className="usage-empty">No model usage in this period.</div> : null}
          {tab === 'overview' && providerRows.length === 0 ? <div className="usage-empty">No provider usage in this period.</div> : null}
        </div>
      </> : null}
    </section>

    <p className="usage-note">
      Ollama API cost is always $0. Cloud spend uses the historical price captured for each call; unpriced cloud calls are shown explicitly and excluded from known spend.
    </p>
  </div>;
}
