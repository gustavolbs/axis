import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';

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
  jobKnownCostUsd: number;
  jobUnknownCostEvents: number;
  daily: UsageSummary;
  monthly: UsageSummary;
  warnings: Array<{ scope: string; fraction: number; projectedUsd: number; limitUsd: number }>;
}
interface ProjectExecution {
  projectId: string;
  organizationId: string;
  localInference: string;
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

function usd(value?: number) {
  if (value === undefined) return '—';
  if (value === 0) return '$0';
  return Math.abs(value) < .01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
function relative(value: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
function durationNs(value?: number) {
  if (!Number.isFinite(value)) return '—';
  const ms = (value ?? 0) / 1_000_000;
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}
function statusTone(status: string) {
  if (status === 'success') return 'good';
  if (status === 'error' || status === 'cancelled') return 'bad';
  if (status.startsWith('waiting')) return 'warn';
  return 'live';
}

export function RunInspectorV2() {
  const [jobs, setJobs] = useState<RunJob[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [filter, setFilter] = useState<'all' | 'active' | 'finished'>('all');
  const [error, setError] = useState<string>();

  useEffect(() => {
    void loadJobs().then(setJobs).catch((next) => setError(next instanceof Error ? next.message : String(next)));
    const events = new EventSource('/api/events');
    events.addEventListener('jobs', (event) => setJobs(JSON.parse((event as MessageEvent<string>).data) as RunJob[]));
    events.addEventListener('job', (event) => {
      const { job } = JSON.parse((event as MessageEvent<string>).data) as { job: RunJob };
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    });
    events.onerror = () => setError('Live run stream reconnecting.');
    events.onopen = () => setError(undefined);
    return () => events.close();
  }, []);

  const projectRuns = useMemo(() => jobs
    .filter((job) => Boolean(job.input.projectId))
    .filter((job) => filter === 'all' || filter === 'active'
      ? filter === 'all' || !['success', 'error', 'cancelled'].includes(job.status)
      : ['success', 'error', 'cancelled'].includes(job.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [jobs, filter]);
  const active = projectRuns.find((job) => job.id === activeId) ?? projectRuns[0];

  return <section className="runs-shell runs-v2 page-shell">
    <header className="runs-header page-header">
      <div><h1 className="page-title">Runs</h1><p>Model choices, spend, latency and execution evidence from Project-aware jobs.</p></div>
      <div className="runs-filter" role="group" aria-label="Filter runs">
        {(['all', 'active', 'finished'] as const).map((item) => <button className={filter === item ? 'active' : ''} key={item} onClick={() => setFilter(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
      </div>
    </header>

    {error ? <div className="reference-inline-error">{error}</div> : null}

    <div className="runs-table-wrap">
      <table className="runs-table">
        <thead><tr><th>When</th><th>Project / task</th><th>Provider / model</th><th>Tokens</th><th>Cost</th><th>Latency</th><th>Status</th></tr></thead>
        <tbody>{projectRuns.map((job) => {
          const execution = job.result?.projectExecution;
          const lastRoute = execution?.routingTrace.at(-1);
          const calls = job.result?.modelCalls ?? [];
          const lastCall = calls.at(-1);
          const input = calls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0);
          const output = calls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0);
          const latency = calls.reduce((sum, call) => sum + (call.totalDurationNs ?? 0), 0);
          const tokensKnown = calls.some((call) => call.promptTokens !== undefined || call.completionTokens !== undefined);
          return <tr key={job.id} className={active?.id === job.id ? 'active' : ''} onClick={() => setActiveId(job.id)}>
            <td><span className="runs-when">{relative(job.updatedAt)}</span></td>
            <td><strong>{job.input.projectId}</strong><small>{job.input.goal}</small></td>
            <td><strong>{lastRoute?.providerId ?? 'local'}</strong><small>{lastRoute?.modelId ?? lastCall?.model ?? '—'}</small></td>
            <td><strong>{tokensKnown ? `${input.toLocaleString()} / ${output.toLocaleString()}` : '—'}</strong><small>{tokensKnown ? 'in / out' : 'not reported'}</small></td>
            <td><strong>{usd(execution?.budget.jobKnownCostUsd)}</strong>{execution?.budget.jobUnknownCostEvents ? <small>{execution.budget.jobUnknownCostEvents} unpriced</small> : null}</td>
            <td><strong>{durationNs(latency || undefined)}</strong></td>
            <td><span className={`status-pill ${statusTone(job.status)}`}><i />{job.status.replace('-', ' ')}</span></td>
          </tr>;
        })}</tbody>
      </table>
      {projectRuns.length === 0 ? <div className="runs-empty">No Project runs yet.</div> : null}
    </div>

    {active ? <RunDetail job={active} /> : null}
  </section>;
}

function RunDetail({ job }: { job: RunJob }) {
  const execution = job.result?.projectExecution;
  const routes = execution?.routingTrace ?? [];
  return <details className="runs-detail" open>
    <summary><span><strong>{job.input.goal}</strong><small>{job.result?.summary ?? job.error ?? `Run is ${job.status}.`}</small></span><ChevronDown size={15} /></summary>
    <div className="runs-detail-grid">
      <div><span>Workspace</span><code>{job.input.workspace}</code></div>
      <div><span>Quality</span><strong>{job.result?.quality ? `${job.result.quality.score}/100 · ${job.result.quality.band}` : '—'}</strong></div>
      <div><span>Changed files</span><strong>{job.result?.changedFiles.length ?? 0}</strong></div>
      <div><span>Repair rounds</span><strong>{job.result?.repairRounds ?? 0}</strong></div>
    </div>
    {routes.length ? <div className="runs-route-list">{routes.map((route, index) => <article key={`${route.stage}-${index}`}>
      <header><span>{index + 1}</span><div><strong>{route.stage}</strong><small>{route.providerId} / {route.modelId} · {route.effectivePolicy}{route.fallbackUsed ? ' · fallback' : ''}</small></div></header>
      {route.reasons.length ? <p>{route.reasons.join(' · ')}</p> : null}
      <div className="runs-attempts">{route.attempts.map((attempt, attemptIndex) => <span className={attempt.status} key={`${attempt.providerId}-${attempt.modelId}-${attemptIndex}`}>{attempt.providerId}/{attempt.modelId}: {attempt.status}</span>)}</div>
    </article>)}</div> : null}
  </details>;
}
