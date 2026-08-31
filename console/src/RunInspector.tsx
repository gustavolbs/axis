import { useEffect, useMemo, useState } from 'react';

interface RoutingAttempt {
  providerId: string;
  modelId: string;
  status: 'success' | 'error';
  error?: string;
  retryable?: boolean;
  rateLimited?: boolean;
  admissionDenied?: boolean;
}

interface RoutingTrace {
  stage: string;
  requestedPolicy: string;
  effectivePolicy: string;
  providerId: string;
  modelId: string;
  providerKind: 'local' | 'cloud';
  fallbackUsed: boolean;
  attempts: RoutingAttempt[];
  reasons: string[];
}

interface ModelCall {
  stage: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalDurationNs?: number;
}

interface BudgetWarning {
  scope: 'daily' | 'monthly' | 'job';
  fraction: number;
  projectedUsd: number;
  limitUsd: number;
}

interface UsageSummary {
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

interface BudgetSnapshot {
  projectId: string;
  jobId: string;
  jobKnownCostUsd: number;
  jobUnknownCostEvents: number;
  jobReservedUpperBoundUsd: number;
  dailyReservedUpperBoundUsd: number;
  monthlyReservedUpperBoundUsd: number;
  daily: UsageSummary;
  monthly: UsageSummary;
  warnings: BudgetWarning[];
}

interface ProjectExecution {
  projectId: string;
  organizationId: string;
  agentHost: 'control-plane';
  localInference: 'mac-ollama' | 'windows-worker' | 'windows-worker-with-mac-fallback';
  repoMemoryScopeKey: string;
  routingTrace: RoutingTrace[];
  budget: BudgetSnapshot;
}

interface RunJob {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  input: { projectId?: string; workspace: string; goal: string; context?: string };
  result?: {
    status: string;
    phase: string;
    summary: string;
    changedFiles: string[];
    repairRounds: number;
    modelCalls?: ModelCall[];
    quality?: { score: number; band: string; passed: boolean };
    projectExecution?: ProjectExecution;
  };
  error?: string;
}

async function loadJobs(): Promise<RunJob[]> {
  const response = await fetch('/api/jobs', { headers: { accept: 'application/json' } });
  const body = (await response.json()) as { jobs?: RunJob[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.jobs ?? [];
}

function usd(value?: number): string {
  if (value === undefined) return '—';
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function time(value?: string): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function durationNs(value?: number): string {
  if (!Number.isFinite(value)) return '—';
  const ms = (value ?? 0) / 1_000_000;
  return ms < 1_000 ? `${ms.toFixed(0)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function statusTone(status?: string): string {
  if (status === 'success') return 'good';
  if (status === 'error') return 'bad';
  if (status?.startsWith('waiting')) return 'warn';
  return 'live';
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function RunInspector() {
  const [jobs, setJobs] = useState<RunJob[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();
  const projectRuns = useMemo(
    () => jobs.filter((job) => Boolean(job.input.projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [jobs]
  );
  const active = projectRuns.find((job) => job.id === activeId) ?? projectRuns[0];
  const execution = active?.result?.projectExecution;
  const budget = execution?.budget;
  const routedCalls = execution?.routingTrace ?? [];
  const legacyLocalCalls = active?.result?.modelCalls ?? [];
  const cognitiveCallCount = routedCalls.length || legacyLocalCalls.length;

  useEffect(() => {
    void loadJobs()
      .then((next) => {
        setJobs(next);
        const first = next.find((job) => job.input.projectId);
        if (first) setActiveId(first.id);
      })
      .catch((next) => setError(next instanceof Error ? next.message : String(next)));

    const events = new EventSource('/api/events');
    events.addEventListener('jobs', (event) => {
      setJobs(JSON.parse((event as MessageEvent<string>).data) as RunJob[]);
    });
    events.addEventListener('job', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { job: RunJob };
      setJobs((current) => [payload.job, ...current.filter((job) => job.id !== payload.job.id)]);
    });
    events.onerror = () => setError('Live run stream reconnecting.');
    events.onopen = () => setError(undefined);
    return () => events.close();
  }, []);

  return <div className="runs-shell">
    <header className="runs-header">
      <div><span className="eyebrow">PROJECT EXECUTION</span><h1>Run Inspector</h1><p>Routing decisions, provider fallbacks and spend evidence captured by the control plane.</p></div>
      <div className="runs-header-metrics"><span className="metric-mini">{projectRuns.length} Project runs</span><span className={`status-pill ${active ? statusTone(active.status) : 'live'}`}>{active?.status ?? 'idle'}</span></div>
    </header>

    {error ? <div className="error-banner">{error}</div> : null}

    <div className="runs-layout">
      <aside className="runs-list panel">
        <div className="panel-heading"><span className="eyebrow">RUNS</span><strong>{projectRuns.length}</strong></div>
        {projectRuns.length === 0 ? <p className="muted small">Project-aware jobs will appear here after you start them from Projects.</p> : projectRuns.map((job) => (
          <button className={`run-row ${active?.id === job.id ? 'active' : ''}`} key={job.id} onClick={() => setActiveId(job.id)}>
            <div className="run-row-top"><span className={`status-pill ${statusTone(job.status)}`}>{job.status}</span><small>{time(job.updatedAt)}</small></div>
            <strong>{job.input.goal}</strong>
            <span>{job.input.projectId} · round {job.rounds}</span>
          </button>
        ))}
      </aside>

      <main className="runs-main">
        {!active ? <section className="panel empty"><p>No Project runs yet.</p></section> : <>
          <section className="panel run-hero">
            <div><span className="eyebrow">{active.input.projectId}</span><h2>{active.input.goal}</h2><p>{active.result?.summary ?? active.error ?? `Run is ${active.status}.`}</p></div>
            <div className="run-hero-meta"><span className={`status-pill ${statusTone(active.status)}`}>{active.status}</span><span>{time(active.updatedAt)}</span></div>
          </section>

          <div className="cards four runs-metrics">
            <section className="panel metric-card"><span>Job spend</span><strong>{usd(budget?.jobKnownCostUsd)}</strong><small>{budget?.jobUnknownCostEvents ?? 0} unpriced events</small></section>
            <section className="panel metric-card"><span>Reserved</span><strong>{usd(budget?.jobReservedUpperBoundUsd)}</strong><small>active upper bound</small></section>
            <section className="panel metric-card"><span>Cognitive calls</span><strong>{cognitiveCallCount}</strong><small>{routedCalls.filter((trace) => trace.fallbackUsed).length} fallbacks</small></section>
            <section className="panel metric-card"><span>Quality</span><strong>{active.result?.quality ? `${active.result.quality.score}/100` : '—'}</strong><small>{active.result?.quality?.band ?? active.result?.phase ?? 'pending'}</small></section>
          </div>

          {execution ? <section className="panel execution-boundary">
            <div className="panel-heading"><div><span className="eyebrow">EXECUTION BOUNDARY</span><strong>{execution.organizationId}</strong></div><span className="status-pill good">{execution.agentHost}</span></div>
            <div className="boundary-grid">
              <div><span>Local inference</span><strong>{execution.localInference}</strong></div>
              <div><span>Project</span><strong>{execution.projectId}</strong></div>
              <div><span>Budget job</span><strong>{execution.budget.jobId}</strong></div>
              <div><span>Repo memory scope</span><code>{execution.repoMemoryScopeKey.slice(0, 18)}…</code></div>
            </div>
          </section> : null}

          <section className="panel route-panel">
            <div className="panel-heading"><div><span className="eyebrow">ROUTING TRACE</span><strong>{routedCalls.length} routed calls</strong></div></div>
            {routedCalls.length ? <div className="route-list">{routedCalls.map((trace, index) => (
              <article className="route-entry" key={`${trace.stage}-${index}-${trace.providerId}-${trace.modelId}`}>
                <div className="route-head">
                  <div className="route-stage"><span>{index + 1}</span><div><strong>{trace.stage}</strong><small>{trace.requestedPolicy} → {trace.effectivePolicy}</small></div></div>
                  <div className="route-selected"><span className={`status-pill ${trace.providerKind === 'local' ? 'good' : 'live'}`}>{trace.providerKind}</span><strong>{trace.providerId} / {trace.modelId}</strong>{trace.fallbackUsed ? <span className="status-pill warn">fallback</span> : null}</div>
                </div>
                <div className="route-body">
                  <div><span className="route-label">Why</span>{trace.reasons.length ? <ul>{trace.reasons.map((reason, reasonIndex) => <li key={`${reason}-${reasonIndex}`}>{reason}</li>)}</ul> : <p className="muted small">No routing reasons recorded.</p>}</div>
                  <div><span className="route-label">Attempts</span><div className="attempt-list">{trace.attempts.map((attempt, attemptIndex) => <div className={`attempt ${attempt.status}`} key={`${attempt.providerId}-${attempt.modelId}-${attemptIndex}`}><i className={`dot ${attempt.status === 'success' ? 'good' : 'bad'}`} /><span><strong>{attempt.providerId} / {attempt.modelId}</strong><small>{attempt.status}{attempt.rateLimited ? ' · rate limited' : ''}{attempt.admissionDenied ? ' · admission denied' : ''}{attempt.retryable ? ' · retryable' : ''}</small>{attempt.error ? <em>{attempt.error}</em> : null}</span></div>)}</div></div>
                </div>
              </article>
            ))}</div> : legacyLocalCalls.length ? <div className="legacy-call-list">
              <p className="muted small">Strict local-only Projects intentionally bypass the multi-provider router. These are the model calls reported by the preserved legacy local path; no synthetic routing decision is inferred.</p>
              {legacyLocalCalls.map((call, index) => <div className="legacy-call" key={`${call.stage}-${call.model}-${index}`}><i className="dot good" /><div><strong>{call.stage} · {call.model}</strong><span>{call.promptTokens ?? 0} in · {call.completionTokens ?? 0} out · {durationNs(call.totalDurationNs)}</span></div></div>)}
            </div> : <p className="muted small">Routing evidence will appear after the Project agent completes a cognitive call.</p>}
          </section>

          <section className="panel budget-panel">
            <div className="panel-heading"><div><span className="eyebrow">BUDGET EVIDENCE</span><strong>Persisted ledger snapshot</strong></div>{budget?.warnings.length ? <span className="status-pill warn">{budget.warnings.length} warnings</span> : <span className="status-pill good">within limits</span>}</div>
            <div className="budget-grid">
              <div><span>Today known spend</span><strong>{usd(budget?.daily.knownCostUsd)}</strong><small>{budget?.daily.cloudEvents ?? 0} cloud · {budget?.daily.localEvents ?? 0} local</small></div>
              <div><span>Month known spend</span><strong>{usd(budget?.monthly.knownCostUsd)}</strong><small>{budget?.monthly.events ?? 0} events</small></div>
              <div><span>Today reserved</span><strong>{usd(budget?.dailyReservedUpperBoundUsd)}</strong><small>concurrent admissions</small></div>
              <div><span>Input / output tokens</span><strong>{(budget?.daily.inputTokens ?? 0).toLocaleString()} / {(budget?.daily.outputTokens ?? 0).toLocaleString()}</strong><small>daily ledger</small></div>
            </div>
            {budget?.warnings.length ? <div className="warning-list">{budget.warnings.map((warning, index) => <div key={`${warning.scope}-${warning.fraction}-${index}`}><span className="status-pill warn">{warning.scope} {pct(warning.fraction)}</span><strong>{usd(warning.projectedUsd)} projected</strong><small>limit {usd(warning.limitUsd)}</small></div>)}</div> : null}
          </section>
        </>}
      </main>
    </div>
  </div>;
}
