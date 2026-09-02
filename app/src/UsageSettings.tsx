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

interface ProviderRuntimeSettings {
  enabled: boolean;
  defaultModelId?: string;
  unlimitedUsage?: boolean;
  monthlyBudgetUsd?: number;
  models: Record<string, unknown>;
}

interface ProviderAdminView {
  id: string;
  kind: 'local' | 'cloud';
  builtIn: boolean;
  settings: ProviderRuntimeSettings;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
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
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'
  }).format(value)}`;
}

function UsageChart({ points }: { points: UsageTimelinePoint[] }) {
  const [hoveredKey, setHoveredKey] = useState<string>();
  if (points.length === 0) return <div className="usage-empty">No token usage in this period yet.</div>;
  const width = 820;
  const height = 254;
  const top = 8;
  const bottom = 36;
  const left = 66;
  const right = 8;
  const baseline = height - bottom;
  const plotHeight = baseline - top;
  const max = Math.max(1, ...points.map((point) => point.totalTokens));
  const roundedMax = Math.max(1, Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)))) * Math.pow(10, Math.floor(Math.log10(max))));
  const slot = (width - left - right) / points.length;
  const barWidth = Math.max(3, Math.min(21, slot * 0.72));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const ticks = [1, 0.75, 0.5, 0.25, 0];
  const hoveredIndex = points.findIndex((point) => point.key === hoveredKey);
  const hoveredPoint = hoveredIndex >= 0 ? points[hoveredIndex] : undefined;
  const tooltipWidth = 246;
  const tooltipHeight = 126;
  const tooltipGeometry = hoveredPoint ? (() => {
    const center = left + hoveredIndex * slot + slot / 2;
    const totalHeight = ((hoveredPoint.inputTokens + hoveredPoint.outputTokens) / roundedMax) * plotHeight;
    const x = Math.max(left, Math.min(width - right - tooltipWidth, center - tooltipWidth / 2));
    const y = Math.max(top + 2, baseline - totalHeight - tooltipHeight - 10);
    return { x, y, pointerX: Math.max(14, Math.min(tooltipWidth - 14, center - x)) };
  })() : undefined;
  return <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Token usage over time">
    {ticks.map((fraction) => {
      const y = top + (1 - fraction) * plotHeight;
      return <g key={fraction}>
        <text x={left - 12} y={y + 4} textAnchor="end" className="usage-axis-label">{tokens(roundedMax * fraction)}</text>
        {fraction > 0 ? <line x1={left} y1={y} x2={width - right} y2={y} className="usage-grid-line" /> : null}
      </g>;
    })}
    {points.map((point, index) => {
      const x = left + index * slot + (slot - barWidth) / 2;
      const inputHeight = (point.inputTokens / roundedMax) * plotHeight;
      const outputHeight = (point.outputTokens / roundedMax) * plotHeight;
      const totalHeight = inputHeight + outputHeight;
      const showLabel = index % labelEvery === 0 || index === points.length - 1;
      return <g className="usage-bar-group" key={point.key} onPointerEnter={() => setHoveredKey(point.key)} onPointerLeave={() => setHoveredKey((current) => current === point.key ? undefined : current)}>
        <title>{`${point.label}: ${tokens(point.inputTokens)} input · ${tokens(point.outputTokens)} output`}</title>
        {inputHeight > 0 ? <rect x={x} y={baseline - inputHeight} width={barWidth} height={inputHeight} rx="2" className="usage-bar-input" /> : null}
        {outputHeight > 0 ? <rect x={x} y={baseline - totalHeight} width={barWidth} height={outputHeight} rx="2" className="usage-bar-output" /> : null}
        {showLabel ? <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" className="usage-axis-label usage-x-label">{point.label}</text> : null}
      </g>;
    })}
    {hoveredPoint && tooltipGeometry ? <g className="usage-chart-tooltip" transform={`translate(${tooltipGeometry.x} ${tooltipGeometry.y})`} aria-hidden="true">
      <rect width={tooltipWidth} height={tooltipHeight} rx="9" className="usage-tooltip-surface" />
      <path d={`M ${tooltipGeometry.pointerX - 6} ${tooltipHeight} L ${tooltipGeometry.pointerX + 6} ${tooltipHeight} L ${tooltipGeometry.pointerX} ${tooltipHeight + 6} Z`} className="usage-tooltip-surface" />
      <text x="15" y="23" className="usage-tooltip-title">{hoveredPoint.label} (UTC)</text>
      <circle cx="18" cy="45" r="4" className="usage-tooltip-input-dot" />
      <text x="31" y="50" className="usage-tooltip-value">Input: {tokens(hoveredPoint.inputTokens)}</text>
      <circle cx="18" cy="68" r="4" className="usage-tooltip-output-dot" />
      <text x="31" y="73" className="usage-tooltip-value">Output: {tokens(hoveredPoint.outputTokens)}</text>
      <text x="15" y="96" className="usage-tooltip-value">Total tokens: {tokens(hoveredPoint.totalTokens)}</text>
      <text x="15" y="117" className="usage-tooltip-spend">Spend: {costLabel(hoveredPoint)}</text>
    </g> : null}
  </svg>;
}

function Share({ value }: { value: number }) {
  return <span className="usage-share">{new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(value)}</span>;
}

export function UsageSettings() {
  const [period, setPeriod] = useState<UsagePeriod>('30d');
  const [tab, setTab] = useState<UsageTab>('models');
  const [usage, setUsage] = useState<UsageDashboardView>();
  const [monthUsage, setMonthUsage] = useState<UsageDashboardView>();
  const [providers, setProviders] = useState<ProviderAdminView[]>([]);
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [unlimitedDrafts, setUnlimitedDrafts] = useState<Record<string, boolean>>({});
  const [savingBudget, setSavingBudget] = useState<string>();
  const [budgetError, setBudgetError] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [showAllRows, setShowAllRows] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [selectedResponse, monthResponse, providersResponse] = await Promise.all([
        api<{ usage: UsageDashboardView }>(`/api/usage?period=${period}`),
        api<{ usage: UsageDashboardView }>('/api/usage?period=month'),
        api<{ providers: ProviderAdminView[] }>('/api/providers')
      ]);
      setUsage(selectedResponse.usage);
      setMonthUsage(monthResponse.usage);
      setProviders(providersResponse.providers);
      setBudgetDrafts(Object.fromEntries(providersResponse.providers.map((provider) => [
        provider.id,
        provider.settings.monthlyBudgetUsd === undefined ? '' : String(provider.settings.monthlyBudgetUsd)
      ])));
      setUnlimitedDrafts(Object.fromEntries(providersResponse.providers.map((provider) => [
        provider.id,
        provider.kind === 'local' || provider.settings.unlimitedUsage === true
      ])));
      setLastUpdated(new Date());
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setShowAllRows(false); }, [period, tab]);

  async function saveBudget(providerId: string): Promise<void> {
    const provider = providers.find((item) => item.id === providerId);
    if (provider?.kind === 'local') return;
    const unlimited = unlimitedDrafts[providerId] === true;
    const draft = budgetDrafts[providerId]?.trim() ?? '';
    const amount = Number(draft);
    if (!unlimited && (!draft || !Number.isFinite(amount) || amount <= 0)) {
      setBudgetError('Monthly budget must be a positive USD amount.');
      return;
    }
    setSavingBudget(providerId);
    setBudgetError(undefined);
    try {
      const { settings } = await api<{ settings: ProviderRuntimeSettings }>(`/api/providers/${encodeURIComponent(providerId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ unlimitedUsage: unlimited, monthlyBudgetUsd: unlimited ? null : amount })
      });
      setProviders((current) => current.map((item) => item.id === providerId ? { ...item, settings } : item));
      setBudgetDrafts((current) => ({ ...current, [providerId]: settings.monthlyBudgetUsd === undefined ? '' : String(settings.monthlyBudgetUsd) }));
      setUnlimitedDrafts((current) => ({ ...current, [providerId]: settings.unlimitedUsage === true }));
    } catch (next) {
      setBudgetError(next instanceof Error ? next.message : String(next));
    } finally {
      setSavingBudget(undefined);
    }
  }

  const totalTokens = usage?.totals.totalTokens ?? 0;
  const modelRows = useMemo(() => usage?.models ?? [], [usage]);
  const providerRows = useMemo(() => usage?.providers ?? [], [usage]);
  const activeRows = tab === 'models' ? modelRows : providerRows;
  const visibleRows = showAllRows ? activeRows : activeRows.slice(0, 6);
  const hiddenRows = activeRows.length - visibleRows.length;
  const monthByProvider = useMemo(() => new Map((monthUsage?.providers ?? []).map((provider) => [provider.providerId, provider])), [monthUsage]);
  const budgetProviders = useMemo(() => {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    for (const usageProvider of monthUsage?.providers ?? []) {
      if (byId.has(usageProvider.providerId)) continue;
      byId.set(usageProvider.providerId, {
        id: usageProvider.providerId,
        kind: usageProvider.providerKind,
        builtIn: false,
        settings: { enabled: true, unlimitedUsage: usageProvider.providerKind === 'local', models: {} }
      });
    }
    return [...byId.values()].sort((a, b) => Number(a.kind === 'local') - Number(b.kind === 'local') || providerLabel(a.id).localeCompare(providerLabel(b.id)));
  }, [providers, monthUsage]);

  return <div className="focused-settings-page usage-settings-page">
    <header><div><h1>Usage</h1><p>Token usage and API spend across local and cloud providers.</p></div><div className="usage-page-meta"><span>{updatedLabel(lastUpdated)}</span><button className={`usage-refresh ${loading ? 'loading' : ''}`} onClick={() => void load()} disabled={loading} aria-label="Refresh usage" title="Refresh usage"><RefreshCw size={14} /></button></div></header>
    {error ? <div className="usage-error" role="alert">{error}</div> : null}

    <section className="usage-shell" aria-busy={loading}>
      <div className="usage-toolbar"><div className="usage-tabs" role="tablist" aria-label="Usage breakdown"><button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button><button role="tab" aria-selected={tab === 'models'} className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>Models</button></div><div className="usage-periods" role="radiogroup" aria-label="Usage period">{([['all', 'All'], ['month', 'Month'], ['30d', '30d'], ['7d', '7d']] as Array<[UsagePeriod, string]>).map(([value, label]) => <button key={value} className={period === value ? 'active' : ''} role="radio" aria-checked={period === value} onClick={() => setPeriod(value)}>{label}</button>)}</div></div>
      <div className="usage-chart-wrap">{usage ? <UsageChart points={usage.timeline.points} /> : <div className="usage-empty">Loading usage…</div>}</div>
      {usage ? <div className="usage-list">{visibleRows.map((row, index) => {
        const share = totalTokens === 0 ? 0 : row.totalTokens / totalTokens;
        const key = 'modelId' in row ? `${row.providerId}:${row.modelId}` : `${row.providerId}:${row.providerKind}`;
        const label = 'modelId' in row ? row.modelId : providerLabel(row.providerId);
        return <div className={`usage-row usage-color-${index % 6}`} key={key}><div className="usage-row-main"><span className="usage-dot" /><strong>{label}</strong></div><div className="usage-row-numbers">{tokens(row.inputTokens)} in · {tokens(row.outputTokens)} out</div><div className="usage-row-cost">{costLabel(row)}</div><Share value={share} /></div>;
      })}{hiddenRows > 0 ? <button className="usage-show-more" onClick={() => setShowAllRows(true)}>Show {hiddenRows} more</button> : null}{showAllRows && activeRows.length > 6 ? <button className="usage-show-more" onClick={() => setShowAllRows(false)}>Show less</button> : null}{tab === 'models' && modelRows.length === 0 ? <div className="usage-empty">No model usage in this period.</div> : null}{tab === 'overview' && providerRows.length === 0 ? <div className="usage-empty">No provider usage in this period.</div> : null}</div> : null}
    </section>

    <section className="usage-budget-shell" aria-label="Provider budgets">
      <div className="usage-budget-heading"><div><strong>Provider budgets</strong><small>Cloud spend is disabled by default. Explicitly choose Unlimited or set a monthly hard stop. The policy applies across Projects and personal Chat.</small></div></div>
      {budgetError ? <div className="usage-budget-error" role="alert">{budgetError}</div> : null}
      {budgetProviders.map((provider) => {
        const month = monthByProvider.get(provider.id);
        const spent = month?.knownCostUsd ?? 0;
        const unpriced = month?.unknownCostEvents ?? 0;
        const local = provider.kind === 'local';
        const unlimited = local || (unlimitedDrafts[provider.id] ?? provider.settings.unlimitedUsage === true);
        const persistedUnlimited = local || provider.settings.unlimitedUsage === true;
        const persistedLimit = provider.settings.monthlyBudgetUsd;
        const progress = persistedLimit === undefined || persistedLimit <= 0 ? 0 : Math.min(1, spent / persistedLimit);
        const busy = savingBudget === provider.id;
        const draft = budgetDrafts[provider.id] ?? '';
        const validDraft = local || unlimited || (draft.trim() !== '' && Number.isFinite(Number(draft)) && Number(draft) > 0);
        return <div className="usage-budget-row" key={provider.id}>
          <div className="usage-budget-provider"><strong>{providerLabel(provider.id)}</strong><small>{local ? `${tokens(month?.totalTokens ?? 0)} tokens this month · $0 API cost` : `${costLabel(month ?? { knownCostUsd: 0, unknownCostEvents: 0 })} this month`}</small>{unpriced > 0 && persistedLimit !== undefined ? <small className="usage-budget-warning">Unpriced usage makes the hard stop indeterminate; further budgeted cloud calls are blocked.</small> : null}</div>
          <div className="usage-budget-control">
            {local ? <div className="usage-budget-meta">Local inference · $0 API cost · no monetary cap required</div> : <>
              <div className="usage-budget-fields"><label className="usage-unlimited"><input type="checkbox" checked={unlimited} onChange={(event) => setUnlimitedDrafts((current) => ({ ...current, [provider.id]: event.target.checked }))} disabled={busy} />Unlimited</label><label className={`usage-budget-input ${unlimited ? 'disabled' : ''}`}><span>$</span><input type="number" min="0.01" step="0.01" inputMode="decimal" aria-label={`${providerLabel(provider.id)} monthly budget in USD`} placeholder="Monthly" value={draft} disabled={unlimited || busy} onChange={(event) => setBudgetDrafts((current) => ({ ...current, [provider.id]: event.target.value }))} /></label><button className="usage-budget-save" disabled={busy || !validDraft} onClick={() => void saveBudget(provider.id)}>{busy ? 'Saving…' : 'Save'}</button></div>
              <progress className={`usage-budget-progress ${progress >= .9 ? 'warn' : ''}`} value={progress} max={1} aria-label={`${providerLabel(provider.id)} monthly budget used`} />
              <div className="usage-budget-meta">{persistedUnlimited ? 'Unlimited' : persistedLimit === undefined ? 'Spend disabled — configure Unlimited or a monthly budget' : `${usd(spent)} / ${usd(persistedLimit)} this month · ${Math.round(progress * 100)}%`}</div>
            </>}
          </div>
        </div>;
      })}
      {budgetProviders.length === 0 ? <div className="usage-empty">No providers configured yet.</div> : null}
    </section>

    <p className="usage-note">Ollama API cost is always $0. Cloud providers cannot spend until a policy is explicitly configured. Finite budgets require known pricing and a bounded maximum output, reserve a pessimistic upper bound before inference, and fail closed on unpriced history, accounting failures, concurrent calls or uncertain provider/network errors.</p>
  </div>;
}
