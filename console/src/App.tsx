import { useEffect, useMemo, useState } from 'react';

interface DecisionOption { id: string; label: string; tradeoff: string }
interface DecisionQuestion {
  id: string;
  question: string;
  rationale: string;
  options: DecisionOption[];
  recommendedOptionId?: string;
}
interface DecisionRequest { message: string; questions: DecisionQuestion[] }
interface QualitySignal { name: string; delta: number; detail: string }
interface Quality {
  score: number;
  band: string;
  threshold: number;
  passed: boolean;
  signals: QualitySignal[];
}
interface Preflight {
  summary: string;
  confidence: number;
  impactAreas: string[];
  affectedContracts: string[];
  testStrategy: string[];
  risks: string[];
  approach: string[];
  researchProviders?: string[];
  cognitive?: {
    effort: string;
    score: number;
    reasons: string[];
    deliberationPasses: number;
    reviewPasses: number;
    independentAudit: boolean;
  };
  deliberation?: {
    summary: string;
    selectedProposalId: string;
    confidence: number;
    principles: string[];
    rejectedAlternatives: string[];
    passes: number;
  };
}
interface Validation { command: string; args: string[]; ok: boolean; durationMs: number; output?: string }
interface PlanTask { id: string; task: string; dependsOn: string[]; editableFiles: string[] }
interface EngineerResult {
  status: string;
  phase: string;
  summary: string;
  changedFiles: string[];
  diff: string;
  validation: Validation[];
  repairRounds: number;
  decisionRequest?: DecisionRequest;
  preflight?: Preflight;
  quality?: Quality;
  plan?: { confidence: number; tasks: PlanTask[]; riskTags: string[] };
  investigation?: { researchRequests?: string[]; evidenceFiles?: string[]; searchQueries?: string[] };
  escalation?: { kind: string; questions: string[]; researchRequests: string[]; reason: string };
  modelCalls?: Array<{ stage: string; model: string; promptTokens?: number; completionTokens?: number; totalDurationNs?: number }>;
}
interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  timestamp: string;
  title: string;
  data?: Record<string, unknown>;
}
interface Job {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  input: { workspace: string; goal: string; context?: string };
  decisionRequest?: DecisionRequest;
  result?: EngineerResult;
  error?: string;
  events: JobEvent[];
}
interface WorkerStatus {
  ok?: boolean;
  hostname?: string;
  scheduler?: { running?: number; queued?: number; activeJobs?: Array<Record<string, unknown>> };
  inference?: {
    current?: {
      stage?: string;
      model?: string;
      runningMs?: number;
      streamState?: string;
      streamChunks?: number;
      thinkingChars?: number;
      outputChars?: number;
      silentForMs?: number;
    } | null;
  };
  ollama?: { configuredModel?: string; numCtx?: number; stageBudgets?: Record<string, { maxDurationMs?: number; maxTokens?: number }> };
  machine?: {
    cpu?: { usagePercent?: number };
    memory?: { usagePercent?: number; usedGb?: number; totalGb?: number };
    gpu?: { name?: string; utilizationPercent?: number; memoryUsedMb?: number; memoryTotalMb?: number } | null;
  };
}

type Tab = 'overview' | 'plan' | 'diff' | 'validation' | 'research' | 'model';

function time(value?: string) {
  return value ? new Date(value).toLocaleTimeString() : '—';
}
function duration(ms?: number) {
  if (!Number.isFinite(ms)) return '—';
  if ((ms ?? 0) < 60_000) return `${((ms ?? 0) / 1000).toFixed(1)}s`;
  const minutes = Math.floor((ms ?? 0) / 60_000);
  const seconds = Math.floor(((ms ?? 0) % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
function statusTone(status?: string) {
  if (status === 'success') return 'good';
  if (status === 'error') return 'bad';
  if (status?.startsWith('waiting')) return 'warn';
  return 'live';
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [worker, setWorker] = useState<WorkerStatus>();
  const [streamOk, setStreamOk] = useState(false);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('overview');
  const [workspace, setWorkspace] = useState(() => localStorage.getItem('local-coder.workspace') ?? '');
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [decisionSelections, setDecisionSelections] = useState<Record<string, string>>({});
  const [guidance, setGuidance] = useState('');

  const active = jobs.find((job) => job.id === activeId) ?? jobs[0];
  const result = active?.result;
  const currentInference = worker?.inference?.current ?? undefined;

  useEffect(() => {
    void api<{ jobs: Job[] }>('/api/jobs')
      .then(({ jobs: initial }) => {
        setJobs(initial);
        if (initial[0]) setActiveId(initial[0].id);
      })
      .catch((next) => setError(next instanceof Error ? next.message : String(next)));

    const events = new EventSource('/api/events');
    events.onopen = () => setStreamOk(true);
    events.onerror = () => setStreamOk(false);
    events.addEventListener('jobs', (event) => {
      setJobs(JSON.parse((event as MessageEvent<string>).data) as Job[]);
    });
    events.addEventListener('job', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { job: Job };
      setJobs((current) => {
        const next = current.filter((job) => job.id !== payload.job.id);
        return [payload.job, ...next].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
    });
    events.addEventListener('worker', (event) => {
      setWorker(JSON.parse((event as MessageEvent<string>).data) as WorkerStatus);
      setError(undefined);
    });
    events.addEventListener('worker-error', (event) => {
      const body = JSON.parse((event as MessageEvent<string>).data) as { error?: string };
      setError(body.error ?? 'Worker status unavailable.');
    });
    return () => events.close();
  }, []);

  useEffect(() => {
    if (!active?.decisionRequest) return;
    const recommended: Record<string, string> = {};
    for (const question of active.decisionRequest.questions) {
      if (question.recommendedOptionId) recommended[question.id] = question.recommendedOptionId;
    }
    setDecisionSelections(recommended);
  }, [active?.id, active?.decisionRequest]);

  const tokenTotals = useMemo(() => {
    const calls = result?.modelCalls ?? [];
    return {
      prompt: calls.reduce((sum, call) => sum + (call.promptTokens ?? 0), 0),
      completion: calls.reduce((sum, call) => sum + (call.completionTokens ?? 0), 0)
    };
  }, [result?.modelCalls]);

  async function createJob() {
    if (!workspace.trim() || !goal.trim()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const { job } = await api<{ job: Job }>('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ workspace, goal, context: context || undefined, maxRepairRounds: 1 })
      });
      localStorage.setItem('local-coder.workspace', workspace.trim());
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setActiveId(job.id);
      setGoal('');
      setContext('');
      setTab('overview');
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setSubmitting(false);
    }
  }

  async function sendDecision() {
    if (!active) return;
    try {
      await api(`/api/jobs/${active.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ selections: decisionSelections })
      });
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  async function sendGuidance() {
    if (!active || !guidance.trim()) return;
    try {
      await api(`/api/jobs/${active.id}/guidance`, {
        method: 'POST',
        body: JSON.stringify({ guidance })
      });
      setGuidance('');
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">LC</div>
          <div><strong>Local Coder</strong><span>Agent Console</span></div>
        </div>
        <div className="worker-chip">
          <i className={worker?.ok === false ? 'dot bad' : 'dot good'} />
          <div><strong>{worker?.hostname ?? 'Windows worker'}</strong><span>{streamOk ? 'live stream' : 'reconnecting'}</span></div>
        </div>
        <div className="side-title">Sessions</div>
        <div className="session-list">
          {jobs.length === 0 ? <p className="muted small">No sessions yet.</p> : jobs.map((job) => (
            <button key={job.id} className={`session ${active?.id === job.id ? 'active' : ''}`} onClick={() => setActiveId(job.id)}>
              <span className={`status-pill ${statusTone(job.status)}`}>{job.status}</span>
              <strong>{job.input.goal}</strong>
              <small>{time(job.updatedAt)} · round {job.rounds}</small>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><span className="eyebrow">LOCAL-FIRST ENGINEERING</span><h1>{active ? active.input.goal : 'What should we build?'}</h1></div>
          <div className="top-metrics">
            <span className={`status-pill ${streamOk ? 'good' : 'warn'}`}>{streamOk ? 'SSE live' : 'fallback'}</span>
            <span className="metric-mini">GPU {worker?.machine?.gpu?.utilizationPercent ?? '—'}%</span>
            <span className="metric-mini">RAM {worker?.machine?.memory?.usagePercent ?? '—'}%</span>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        {!active ? (
          <section className="welcome panel">
            <div className="hero-copy">
              <span className="eyebrow">CLAUDE 2 · LOCAL AGENT</span>
              <h2>Give it a goal, not a prompt recipe.</h2>
              <p>It analyzes impact, researches, deliberates when needed, decomposes the work, executes, validates, reviews and asks you only for material decisions.</p>
            </div>
            <div className="composer large">
              <label>Workspace on this Mac<input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="/Users/you/WORK/project" /></label>
              <label>Goal<textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Implement a dashboard for..." rows={5} /></label>
              <label>Context / constraints<textarea value={context} onChange={(e) => setContext(e.target.value)} placeholder="Optional product or project context" rows={3} /></label>
              <button className="primary" disabled={submitting || !workspace.trim() || !goal.trim()} onClick={() => void createJob()}>{submitting ? 'Starting…' : 'Start agent'}</button>
            </div>
          </section>
        ) : (
          <>
            <section className="live-strip panel">
              <div>
                <span className="eyebrow">CURRENT ACTIVITY</span>
                <h2>{currentInference ? `${currentInference.stage} · ${currentInference.streamState ?? 'waiting'}` : active.status}</h2>
                <p>{currentInference ? `${currentInference.streamChunks ?? 0} chunks · last activity ${duration(currentInference.silentForMs)} ago` : `Updated ${time(active.updatedAt)}`}</p>
              </div>
              <div className="live-stats">
                <div><span>Elapsed</span><strong>{duration(currentInference?.runningMs)}</strong></div>
                <div><span>Reasoning signal</span><strong>{currentInference?.thinkingChars?.toLocaleString() ?? '—'}</strong></div>
                <div><span>Output chars</span><strong>{currentInference?.outputChars?.toLocaleString() ?? '—'}</strong></div>
                <div><span>Model</span><strong>{currentInference?.model ?? worker?.ollama?.configuredModel ?? '—'}</strong></div>
              </div>
            </section>

            {active.status === 'waiting-decision' && active.decisionRequest ? (
              <section className="decision panel accent">
                <span className="eyebrow">YOUR DECISION</span>
                <h2>{active.decisionRequest.message}</h2>
                {active.decisionRequest.questions.map((question) => (
                  <div className="decision-question" key={question.id}>
                    <h3>{question.question}</h3><p>{question.rationale}</p>
                    <div className="choice-grid">{question.options.map((option) => (
                      <button key={option.id} className={`choice ${decisionSelections[question.id] === option.id ? 'selected' : ''}`} onClick={() => setDecisionSelections((current) => ({ ...current, [question.id]: option.id }))}>
                        <div><strong>{option.label}</strong>{option.id === question.recommendedOptionId ? <span className="recommended">recommended</span> : null}</div>
                        <p>{option.tradeoff}</p>
                      </button>
                    ))}</div>
                  </div>
                ))}
                <button className="primary" onClick={() => void sendDecision()}>Continue with my choice</button>
              </section>
            ) : null}

            {active.status === 'waiting-guidance' && result?.escalation ? (
              <section className="decision panel warn-panel">
                <span className="eyebrow">BOUNDED GUIDANCE REQUIRED</span>
                <h2>{result.escalation.reason}</h2>
                {result.escalation.questions.map((item) => <p key={item}>• {item}</p>)}
                {result.escalation.researchRequests.map((item) => <p key={item}>Research: {item}</p>)}
                <textarea value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={4} placeholder="Provide only the missing decision/evidence…" />
                <button className="primary" onClick={() => void sendGuidance()}>Resume locally</button>
              </section>
            ) : null}

            <nav className="tabs">
              {(['overview', 'plan', 'diff', 'validation', 'research', 'model'] as Tab[]).map((item) => (
                <button className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)}>{item}</button>
              ))}
            </nav>

            <section className="content-grid">
              <div className="content-main">
                {tab === 'overview' ? <Overview job={active} /> : null}
                {tab === 'plan' ? <Plan result={result} /> : null}
                {tab === 'diff' ? <CodePanel title="Aggregate diff" text={result?.diff || 'No diff yet.'} /> : null}
                {tab === 'validation' ? <ValidationPanel result={result} /> : null}
                {tab === 'research' ? <ResearchPanel result={result} /> : null}
                {tab === 'model' ? <ModelPanel result={result} worker={worker} tokenTotals={tokenTotals} /> : null}
              </div>
              <aside className="timeline panel">
                <div className="panel-heading"><span className="eyebrow">TIMELINE</span><strong>{active.events.length} events</strong></div>
                {[...active.events].reverse().map((event) => (
                  <div className="timeline-row" key={event.id}><i className={`dot ${event.type === 'error' ? 'bad' : event.type === 'decision' ? 'warn' : 'good'}`} /><div><strong>{event.title}</strong><span>{time(event.timestamp)}</span></div></div>
                ))}
              </aside>
            </section>

            <section className="composer compact panel">
              <label>New goal in <strong>{workspace || active.input.workspace}</strong><textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder="Start another engineering goal…" /></label>
              <button className="primary" disabled={submitting || !goal.trim()} onClick={() => { if (!workspace) setWorkspace(active.input.workspace); void createJob(); }}>New session</button>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function Overview({ job }: { job: Job }) {
  const result = job.result;
  const quality = result?.quality;
  const preflight = result?.preflight;
  return <div className="stack">
    <section className="panel"><span className="eyebrow">RESULT</span><h2>{result?.summary ?? 'Agent is still working.'}</h2><p className="muted">{job.input.workspace}</p></section>
    <div className="cards three">
      <section className="panel metric-card"><span>Quality</span><strong>{quality ? `${quality.score}/100` : '—'}</strong><small>{quality?.band ?? 'pending'}</small></section>
      <section className="panel metric-card"><span>Cognitive effort</span><strong>{preflight?.cognitive?.effort ?? '—'}</strong><small>{preflight?.cognitive ? `${preflight.cognitive.score}/100 complexity` : 'pending'}</small></section>
      <section className="panel metric-card"><span>Changes</span><strong>{result?.changedFiles.length ?? 0}</strong><small>{result?.repairRounds ?? 0} repair rounds</small></section>
    </div>
    {preflight ? <section className="panel"><span className="eyebrow">IMPACT ANALYSIS</span><h3>{preflight.summary}</h3><div className="two-col"><List title="Impact" values={preflight.impactAreas} /><List title="Risks" values={preflight.risks} /><List title="Contracts" values={preflight.affectedContracts} /><List title="Test strategy" values={preflight.testStrategy} /></div>{preflight.deliberation ? <div className="deliberation-box"><strong>Deliberation · {preflight.deliberation.passes} passes</strong><p>{preflight.deliberation.summary}</p><List title="Principles" values={preflight.deliberation.principles} /></div> : null}</section> : null}
    {quality ? <section className="panel"><span className="eyebrow">QUALITY GATE</span><div className="quality-head"><strong>{quality.score}/100</strong><span className={`status-pill ${quality.passed ? 'good' : 'warn'}`}>{quality.passed ? 'passed' : 'inspect'}</span></div><div className="signal-list">{quality.signals.map((signal) => <div key={signal.name}><b className={signal.delta >= 0 ? 'positive' : 'negative'}>{signal.delta >= 0 ? '+' : ''}{signal.delta}</b><span><strong>{signal.name}</strong>{signal.detail}</span></div>)}</div></section> : null}
  </div>;
}

function Plan({ result }: { result?: EngineerResult }) {
  if (!result?.plan) return <Empty text="Plan not available yet." />;
  return <section className="panel"><span className="eyebrow">EXECUTION DAG</span><h2>{result.plan.tasks.length} bounded tasks · confidence {(result.plan.confidence * 100).toFixed(0)}%</h2><div className="task-list">{result.plan.tasks.map((task, index) => <div className="task" key={task.id}><div className="task-index">{index + 1}</div><div><strong>{task.id}</strong><p>{task.task}</p><small>depends on: {task.dependsOn.join(', ') || 'none'}</small><small>files: {task.editableFiles.join(', ')}</small></div></div>)}</div></section>;
}

function ValidationPanel({ result }: { result?: EngineerResult }) {
  if (!result?.validation?.length) return <Empty text="No validation evidence yet." />;
  return <div className="stack">{result.validation.map((check, index) => <section className="panel" key={`${check.command}-${index}`}><div className="panel-heading"><strong>$ {check.command} {check.args.join(' ')}</strong><span className={`status-pill ${check.ok ? 'good' : 'bad'}`}>{check.ok ? 'pass' : 'fail'}</span></div><p className="muted">{duration(check.durationMs)}</p>{check.output ? <pre>{check.output}</pre> : null}</section>)}</div>;
}

function ResearchPanel({ result }: { result?: EngineerResult }) {
  return <section className="panel"><span className="eyebrow">RESEARCH & EVIDENCE</span><h2>Local-first evidence</h2><List title="Providers" values={result?.preflight?.researchProviders ?? []} /><List title="Repository evidence" values={result?.investigation?.evidenceFiles ?? []} /><List title="Search queries" values={result?.investigation?.searchQueries ?? []} /><List title="Unresolved research" values={result?.investigation?.researchRequests ?? []} /></section>;
}

function ModelPanel({ result, worker, tokenTotals }: { result?: EngineerResult; worker?: WorkerStatus; tokenTotals: { prompt: number; completion: number } }) {
  const current = worker?.inference?.current;
  return <div className="stack"><div className="cards three"><section className="panel metric-card"><span>Prompt tokens</span><strong>{tokenTotals.prompt.toLocaleString()}</strong><small>structured local calls</small></section><section className="panel metric-card"><span>Completion tokens</span><strong>{tokenTotals.completion.toLocaleString()}</strong><small>local Qwen</small></section><section className="panel metric-card"><span>Context</span><strong>{worker?.ollama?.numCtx?.toLocaleString() ?? '—'}</strong><small>{worker?.ollama?.configuredModel ?? 'model'}</small></section></div><section className="panel"><span className="eyebrow">LIVE MODEL</span><h2>{current ? `${current.stage} · ${current.streamState}` : 'Idle'}</h2><div className="two-col"><List title="Stream" values={current ? [`${current.streamChunks ?? 0} chunks`, `${current.thinkingChars ?? 0} hidden reasoning chars`, `${current.outputChars ?? 0} result chars`, `${duration(current.silentForMs)} silence`] : ['No active inference']} /><List title="Recent model calls" values={(result?.modelCalls ?? []).map((call) => `${call.stage} · ${call.model} · ${call.completionTokens ?? 0} out`)} /></div></section></div>;
}

function List({ title, values }: { title: string; values: string[] }) {
  return <div className="list-block"><strong>{title}</strong>{values.length ? <ul>{values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}</ul> : <span className="muted small">None</span>}</div>;
}
function CodePanel({ title, text }: { title: string; text: string }) { return <section className="panel"><span className="eyebrow">{title}</span><pre className="code-block">{text}</pre></section>; }
function Empty({ text }: { text: string }) { return <section className="panel empty"><p>{text}</p></section>; }
