import { useEffect, useMemo, useState } from 'react';

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

function UsageChart({ points }: { points: UsageTimelinePoint[] }) {
  if (points.length === 0) {
    return <div className="settings-empty-state">No token usage in this period yet.</div>;
  }

  const width = 760;
  const height = 220;
  const top = 10;
  const bottom = 30;
  const left = 12;
  const right = 12;
  const baseline = height - bottom;
  const plotHeight = baseline - top;
  const max = Math.max(1, ...points.map((point) => point.totalTokens));
  const slot = (width - left - right) / points.length;
  const barWidth = Math.max(2, Math.min(20, slot * 0.72));
  const labelEvery = Math.max(1, Math.ceil(points.length / 7));

  return <svg
    viewBox={`0 0 ${width} ${height}`}
    width="100%"
    height="220"
    role="img"
    aria-label="Token usage over time"
  >
    <line x1={left} y1={baseline} x2={width - right} y2={baseline} stroke="var(--lc-border)" />
    {points.map((point, index) => {
      const x = left + index * slot + (slot - barWidth) / 2;
      const inputHeight = (point.inputTokens / max) * plotHeight;
      const outputHeight = (point.outputTokens / max) * plotHeight;
      const totalHeight = inputHeight + outputHeight;
      const showLabel = index % labelEvery === 0 || index === points.length - 1;
      return <g key={point.key}>
        {inputHeight > 0 ? <rect
          x={x}
          y={baseline - inputHeight}
          width={barWidth}
          height={inputHeight}
          rx="2"
          fill="var(--lc-accent)"
          opacity="0.58"
        /> : null}
        {outputHeight > 0 ? <rect
          x={x}
          y={baseline - totalHeight}
          width={barWidth}
          height={outputHeight}
          rx="2"
          fill="var(--lc-accent)"
        /> : null}
        {showLabel ? <text
          x={x + barWidth / 2}
          y={height - 9}
          textAnchor="middle"
          fill="currentColor"
          opacity="0.62"
          fontSize="10"
        >{point.label}</text> : null}
      </g>;
    })}
  </svg>;
}

function UsageCards({ usage }: { usage: UsageDashboardView }) {
  const monthTitle = usage.currentMonth.unknownCostEvents > 0 ? 'Known spend this month' : 'Spend this month';
  return <>
    <div className="settings-card">
      <div><strong>{monthTitle}</strong><p>Cloud API cost recorded for the current calendar month.</p></div>
      <span className="settings-status">{costLabel(usage.currentMonth)}</span>
    </div>
    <div className="settings-card">
      <div><strong>Input tokens</strong><p>Prompt and context tokens in the selected period.</p></div>
      <span className="settings-status">{tokens(usage.totals.inputTokens)}</span>
    </div>
    <div className="settings-card">
      <div><strong>Output tokens</strong><p>Generated tokens in the selected period.</p></div>
      <span className="settings-status">{tokens(usage.totals.outputTokens)}</span>
    </div>
    <div className="settings-card">
      <div><strong>Inference calls</strong><p>{usage.totals.localCalls} local · {usage.totals.cloudCalls} cloud.</p></div>
      <span className="settings-status">{usage.totals.calls.toLocaleString('en-US')}</span>
    </div>
  </>;
}

export function UsageSettings() {
  const [period, setPeriod] = useState<UsagePeriod>('30d');
  const [usage, setUsage] = useState<UsageDashboardView>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void api<{ usage: UsageDashboardView }>(`/api/usage?period=${period}`)
      .then(({ usage: next }) => {
        if (!cancelled) setUsage(next);
      })
      .catch((next) => {
        if (!cancelled) setError(next instanceof Error ? next.message : String(next));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [period]);

  const totalTokens = usage?.totals.totalTokens ?? 0;
  const modelRows = useMemo(() => usage?.models ?? [], [usage]);

  return <div className="focused-settings-page usage-settings-page">
    <header>
      <div>
        <h1>Usage</h1>
        <p>Token usage and API spend across local and cloud providers.</p>
      </div>
      <div className="settings-endpoint-row" role="radiogroup" aria-label="Usage period">
        {([
          ['all', 'All'],
          ['month', 'Month'],
          ['30d', '30d'],
          ['7d', '7d']
        ] as Array<[UsagePeriod, string]>).map(([value, label]) => <button
          key={value}
          className={period === value ? 'btn-primary' : 'btn-secondary'}
          role="radio"
          aria-checked={period === value}
          onClick={() => setPeriod(value)}
        >{label}</button>)}
      </div>
    </header>

    {error ? <div className="settings-inline-message">{error}</div> : null}
    {loading && !usage ? <div className="settings-empty-state">Loading usage…</div> : null}

    {usage ? <>
      <UsageCards usage={usage} />

      <section className="settings-stacked-section">
        <div className="settings-section-copy">
          <strong>Tokens over time</strong>
          <p>Light bars are input tokens; solid bars are output tokens.</p>
        </div>
        <UsageChart points={usage.timeline.points} />
      </section>

      <section className="settings-stacked-section">
        <div className="settings-section-copy">
          <strong>By provider</strong>
          <p>Ollama has zero API cost but remains fully represented in token usage.</p>
        </div>
        {usage.providers.length === 0 ? <div className="settings-empty-state">No providers used in this period.</div> : <table className="runs-table">
          <thead><tr><th>Provider</th><th>Calls</th><th>Input</th><th>Output</th><th>Tokens</th><th>Cost</th></tr></thead>
          <tbody>{usage.providers.map((provider) => <tr key={`${provider.providerId}:${provider.providerKind}`}>
            <td><strong>{providerLabel(provider.providerId)}</strong><small>{provider.providerKind}</small></td>
            <td>{provider.calls.toLocaleString('en-US')}</td>
            <td>{tokens(provider.inputTokens)}</td>
            <td>{tokens(provider.outputTokens)}</td>
            <td>{tokens(provider.totalTokens)}</td>
            <td>{provider.providerKind === 'local' ? usd(0) : costLabel(provider)}</td>
          </tr>)}</tbody>
        </table>}
      </section>

      <section className="settings-stacked-section">
        <div className="settings-section-copy">
          <strong>By model</strong>
          <p>Detailed token mix and recorded API cost for each model.</p>
        </div>
        {modelRows.length === 0 ? <div className="settings-empty-state">No model usage in this period.</div> : <table className="runs-table">
          <thead><tr><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cost</th><th>Share</th></tr></thead>
          <tbody>{modelRows.map((model) => {
            const share = totalTokens === 0 ? 0 : model.totalTokens / totalTokens;
            return <tr key={`${model.providerId}:${model.modelId}`}>
              <td><strong>{model.modelId}</strong><small>{providerLabel(model.providerId)} · {model.providerKind}</small></td>
              <td>{model.calls.toLocaleString('en-US')}</td>
              <td>{tokens(model.inputTokens)}</td>
              <td>{tokens(model.outputTokens)}</td>
              <td>{tokens(model.cacheReadInputTokens)}</td>
              <td>{model.providerKind === 'local' ? usd(0) : costLabel(model)}</td>
              <td>{new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(share)}</td>
            </tr>;
          })}</tbody>
        </table>}
      </section>

      <div className="settings-inline-message">
        Costs come from the historical usage ledger and are not recomputed when pricing changes. Cloud calls without pricing are marked <strong>unpriced</strong> and excluded from known spend; Ollama API cost is always $0.
      </div>
    </> : null}
  </div>;
}
