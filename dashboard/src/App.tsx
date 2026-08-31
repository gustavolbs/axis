import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Radio,
  ServerCog,
  Sparkles,
  TerminalSquare,
  Workflow
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { HistoryPanel } from '@/HistoryPanel';
import { cn } from '@/lib/utils';

type JobProgress = {
  phase?: string;
  action?: string;
  detail?: string;
  reasoningSummary?: string;
  taskId?: string;
  files?: string[];
  validation?: string;
  completedSteps?: string[];
  updatedAt?: string;
};

type Job = {
  id: string;
  kind: string;
  isolationKey: string;
  runningMs?: number;
  waitingMs?: number;
  progress?: JobProgress;
};

type Inference = {
  id: string;
  stage: string;
  model: string;
  startedAt: string;
  runningMs?: number;
  finishedAt?: string;
  durationMs?: number;
  status?: string;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
  streamState?: 'waiting' | 'thinking' | 'generating';
  streamChunks?: number;
  thinkingChars?: number;
  outputChars?: number;
  lastActivityAt?: string;
  silentForMs?: number;
  error?: string;
};

type StageBudget = { maxDurationMs?: number; maxTokens?: number };

type StatusPayload = {
  ok: boolean;
  hostname?: string;
  platform?: string;
  workerVersion?: string;
  model?: string;
  collectedAt?: string;
  scheduler?: {
    activeJobs: number;
    queuedJobs: number;
    maxConcurrentJobs: number;
    active: Job[];
    queued: Job[];
  };
  inference?: { current: Inference | null; recent: Inference[] };
  ollama?: {
    ok: boolean;
    numCtx?: number;
    configuredModel?: string;
    availableModels?: string[];
    stageBudgets?: Record<string, StageBudget>;
  };
  machine?: {
    uptimeSeconds?: number;
    cpu?: { usagePercent?: number; logicalCores?: number; model?: string };
    memory?: { usedPercent?: number; usedBytes?: number; totalBytes?: number; freeBytes?: number };
    process?: { rssBytes?: number; heapUsedBytes?: number };
    gpu?: {
      name?: string;
      utilizationPercent?: number;
      memoryUsedMiB?: number;
      memoryTotalMiB?: number;
      temperatureC?: number;
    } | null;
  };
  controlPlane?: {
    hostname?: string;
    platform?: string;
    workerUrl?: string;
    transport?: string;
  };
};

type Stage = { key: string; label: string };

const pipeline: Stage[] = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'impact-analysis', label: 'Impact' },
  { key: 'deliberation', label: 'Deliberation' },
  { key: 'investigation', label: 'Investigation' },
  { key: 'research', label: 'Research' },
  { key: 'decision', label: 'Decision' },
  { key: 'planning', label: 'Planning' },
  { key: 'implementation', label: 'Implementation' },
  { key: 'validation', label: 'Validation' },
  { key: 'review', label: 'Review' },
  { key: 'repair', label: 'Repair' },
  { key: 'quality-gate', label: 'Quality' },
  { key: 'repo-learning', label: 'Learning' },
  { key: 'complete', label: 'Complete' }
];

function bytes(value?: number) {
  if (!Number.isFinite(value)) return '—';
  let number = value!;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (number >= 1024 && index < units.length - 1) {
    number /= 1024;
    index += 1;
  }
  return `${number.toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

function duration(ms?: number) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms! / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const tail = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${String(tail).padStart(2, '0')}s`;
}

function compactDuration(ms?: number) {
  if (!Number.isFinite(ms)) return '—';
  if (ms! < 1000) return `${Math.round(ms!)}ms`;
  if (ms! < 60_000) return `${(ms! / 1000).toFixed(ms! < 10_000 ? 1 : 0)}s`;
  return duration(ms);
}

function shortTime(value?: string) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function normalizePhase(phase?: string) {
  const value = phase?.toLowerCase() ?? '';
  if (value.includes('architect') || value.includes('critic') || value.includes('judge')) return 'deliberation';
  if (value.includes('report')) return 'investigation';
  if (value.includes('quality')) return 'quality-gate';
  if (value.includes('repo') && value.includes('learn')) return 'repo-learning';
  return pipeline.find((stage) => value.includes(stage.key))?.key ?? value;
}

function stageIndex(phase?: string) {
  const normalized = normalizePhase(phase);
  return pipeline.findIndex((stage) => stage.key === normalized);
}

function streamStateLabel(value?: Inference['streamState']) {
  if (value === 'thinking') return 'actively reasoning';
  if (value === 'generating') return 'generating structured result';
  return 'waiting for model activity';
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <Card className="glass overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
            <div className="metric-glow mt-2 truncate text-2xl font-semibold tracking-tight">{value}</div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
          </div>
          <div className="rounded-xl border border-border bg-secondary/60 p-2.5">
            <Icon className="h-4 w-4 text-cyan-300" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ResourceBar({ label, value, detail }: { label: string; value?: number; detail?: string }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value!)) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{Number.isFinite(value) ? `${safe.toFixed(1)}%` : '—'}</span>
      </div>
      <Progress value={safe} />
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function Pipeline({ phase, completed = [] }: { phase?: string; completed?: string[] }) {
  const normalized = normalizePhase(phase);
  const current = stageIndex(normalized);
  const completedSet = new Set(completed.map(normalizePhase));
  const readOnly = Boolean(phase?.toLowerCase().includes('report'));

  return (
    <div className="space-y-3">
      {readOnly ? (
        <div className="flex items-center gap-2 rounded-lg border border-cyan-400/15 bg-cyan-400/[.035] px-3 py-2 text-xs text-cyan-100">
          <Radio className="h-3.5 w-3.5" />
          Read-only path: Investigation → local evidence/research → Report → Complete. Mutation stages are intentionally skipped.
        </div>
      ) : null}
      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-[1220px] grid-cols-14 gap-2">
          {pipeline.map((stage, index) => {
            const explicitlyDone = completedSet.has(stage.key);
            const done = explicitlyDone || (!readOnly && current >= 0 && index < current) || (stage.key === 'complete' && normalized === 'complete');
            const active = stage.key === normalized && normalized !== 'complete';
            return (
              <div key={stage.key} className="min-w-0 text-center">
                <div
                  className={cn(
                    'mx-auto flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-bold transition-all',
                    done && 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300',
                    active && 'border-cyan-300/70 bg-cyan-300/15 text-cyan-200 shadow-[0_0_25px_rgba(34,211,238,.18)]',
                    !done && !active && 'border-border bg-secondary/50 text-muted-foreground'
                  )}
                >
                  {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
                </div>
                <div className={cn('mt-2 truncate text-[11px]', active ? 'text-cyan-200' : done ? 'text-emerald-300' : 'text-muted-foreground')}>
                  {stage.label}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<Date | null>(null);
  const [liveTransport, setLiveTransport] = useState<'connecting' | 'sse' | 'fallback'>('connecting');

  useEffect(() => {
    let alive = true;
    const apply = (body: StatusPayload) => {
      if (!alive) return;
      setData(body);
      setError(null);
      setLastOkAt(new Date());
    };
    const snapshot = async () => {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        const body = (await response.json()) as StatusPayload & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        apply(body);
      } catch (nextError) {
        if (alive) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    };

    void snapshot();
    const events = new EventSource('/api/events');
    events.addEventListener('status', (event) => {
      try {
        apply(JSON.parse((event as MessageEvent<string>).data) as StatusPayload);
        setLiveTransport('sse');
      } catch (nextError) {
        if (alive) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    });
    events.addEventListener('status-error', (event) => {
      try {
        const body = JSON.parse((event as MessageEvent<string>).data) as { error?: string };
        if (alive) setError(body.error ?? 'Live status stream failed.');
      } catch {
        if (alive) setError('Live status stream failed.');
      }
    });
    events.onopen = () => alive && setLiveTransport('sse');
    events.onerror = () => {
      if (!alive) return;
      setLiveTransport('fallback');
      void snapshot();
    };
    const fallbackTimer = window.setInterval(() => {
      if (events.readyState !== EventSource.OPEN) void snapshot();
    }, 10_000);
    return () => {
      alive = false;
      events.close();
      window.clearInterval(fallbackTimer);
    };
  }, []);

  const scheduler = data?.scheduler;
  const activeJob = scheduler?.active?.[0];
  const progress = activeJob?.progress;
  const currentInference = data?.inference?.current;
  const phase = progress?.phase ?? currentInference?.stage ?? (activeJob ? 'workspace' : undefined);
  const normalizedPhase = normalizePhase(phase);
  const currentBudget = currentInference ? data?.ollama?.stageBudgets?.[currentInference.stage] : undefined;
  const phaseProgress = useMemo(() => {
    const index = stageIndex(normalizedPhase);
    return index < 0 ? 0 : ((index + 1) / pipeline.length) * 100;
  }, [normalizedPhase]);
  const online = Boolean(data?.ok && !error);
  const gpu = data?.machine?.gpu;
  const memory = data?.machine?.memory;
  const cpu = data?.machine?.cpu;
  const headline = progress?.action ?? (currentInference ? `Qwen is running ${currentInference.stage}` : activeJob ? 'Preparing workspace' : 'Idle');

  return (
    <div className="min-h-screen">
      <div className="grid-glow" />
      <main className="relative mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10">
              <BrainCircuit className="h-6 w-6 text-cyan-300" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Local Coder</h1>
                <Badge variant="outline" className="border-cyan-400/20 text-cyan-300">Premium Agent Runtime</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Impact → deliberation → evidence → plan → execution → validation → review · live via SSE</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={online ? 'success' : 'destructive'} className="gap-2 px-3 py-1.5">
              <span className={cn('h-2 w-2 rounded-full', online ? 'pulse-dot bg-emerald-400' : 'bg-rose-400')} />
              {online ? 'Worker online' : 'Worker unavailable'}
            </Badge>
            <Badge variant={liveTransport === 'sse' ? 'success' : 'secondary'} className="gap-2 px-3 py-1.5">
              <Radio className="h-3.5 w-3.5" />
              {liveTransport === 'sse' ? 'SSE live' : liveTransport === 'fallback' ? 'HTTP fallback' : 'connecting'}
            </Badge>
            <Badge variant="secondary" className="gap-2 px-3 py-1.5"><Clock3 className="h-3.5 w-3.5" />{lastOkAt ? shortTime(lastOkAt.toISOString()) : '—'}</Badge>
          </div>
        </header>

        {error ? <div className="mb-5 rounded-xl border border-rose-400/20 bg-rose-500/[.05] px-4 py-3 text-sm text-rose-200">{error}</div> : null}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Agent state" value={activeJob ? normalizedPhase || 'running' : 'idle'} detail={headline} icon={Workflow} />
          <MetricCard label="Scheduler" value={`${scheduler?.activeJobs ?? 0} / ${scheduler?.queuedJobs ?? 0}`} detail="active / queued jobs" icon={ServerCog} />
          <MetricCard label="Model" value={currentInference?.model ?? data?.model ?? '—'} detail={currentInference ? `${streamStateLabel(currentInference.streamState)} · ${duration(currentInference.runningMs)}` : 'no active inference'} icon={BrainCircuit} />
          <MetricCard label="Context" value={data?.ollama?.numCtx?.toLocaleString() ?? '—'} detail="configured model context" icon={MemoryStick} />
        </div>

        <Card className="glass mt-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4 text-cyan-300" />Agent lifecycle</CardTitle>
            <CardDescription>{headline}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Pipeline phase={phase} completed={progress?.completedSteps} />
            <Progress value={phaseProgress} />
            {progress?.detail ? <p className="whitespace-pre-wrap text-sm leading-6 text-slate-300">{progress.detail}</p> : null}
            {progress?.reasoningSummary ? (
              <div className="rounded-xl border border-violet-400/15 bg-violet-400/[.035] p-4 text-sm leading-6 text-slate-300">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.14em] text-violet-300">Operational reasoning summary</div>
                {progress.reasoningSummary}
              </div>
            ) : null}
            {progress?.validation ? <pre className="overflow-auto rounded-xl border border-border bg-black/25 p-4 font-mono text-xs text-slate-300">{progress.validation}</pre> : null}
          </CardContent>
        </Card>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4 text-cyan-300" />Model activity</CardTitle>
              <CardDescription>Safe liveness signals only; hidden chain-of-thought content is never displayed.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {currentInference ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="warning">LIVE</Badge>
                    <Badge variant="outline">{currentInference.stage}</Badge>
                    <Badge variant="secondary">{streamStateLabel(currentInference.streamState)}</Badge>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <MetricCard label="Elapsed" value={duration(currentInference.runningMs)} detail={`started ${shortTime(currentInference.startedAt)}`} icon={Clock3} />
                    <MetricCard label="Stream chunks" value={currentInference.streamChunks ?? 0} detail={`silent ${compactDuration(currentInference.silentForMs)}`} icon={Activity} />
                    <MetricCard label="Reasoning activity" value={(currentInference.thinkingChars ?? 0).toLocaleString()} detail="hidden reasoning chars counted" icon={BrainCircuit} />
                    <MetricCard label="Output" value={(currentInference.outputChars ?? 0).toLocaleString()} detail="structured output characters" icon={TerminalSquare} />
                  </div>
                  <div className="rounded-xl border border-border bg-secondary/20 p-4 text-sm text-muted-foreground">
                    Stage budget: {currentBudget?.maxDurationMs ? duration(currentBudget.maxDurationMs) : '—'} wall clock · {currentBudget?.maxTokens?.toLocaleString() ?? '—'} generated-token budget.
                  </div>
                </>
              ) : (
                <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">No active model inference.</div>
              )}
            </CardContent>
          </Card>

          <Card className="glass">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Gauge className="h-4 w-4 text-cyan-300" />Machine</CardTitle>
              <CardDescription>{data?.hostname ?? 'Windows worker'} · {gpu?.name ?? 'GPU telemetry unavailable'}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <ResourceBar label="GPU" value={gpu?.utilizationPercent} detail={gpu ? `${gpu.memoryUsedMiB ?? 0} / ${gpu.memoryTotalMiB ?? 0} MiB · ${gpu.temperatureC ?? '—'}°C` : undefined} />
              <ResourceBar label="Memory" value={memory?.usedPercent} detail={memory ? `${bytes(memory.usedBytes)} / ${bytes(memory.totalBytes)}` : undefined} />
              <ResourceBar label="CPU" value={cpu?.usagePercent} detail={cpu ? `${cpu.logicalCores ?? '—'} logical cores` : undefined} />
              <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                <div className="rounded-xl border border-border bg-secondary/20 p-3"><Cpu className="mb-2 h-4 w-4 text-cyan-300" />{cpu?.model ?? 'CPU'}</div>
                <div className="rounded-xl border border-border bg-secondary/20 p-3"><HardDrive className="mb-2 h-4 w-4 text-cyan-300" />RSS {bytes(data?.machine?.process?.rssBytes)}</div>
              </div>
            </CardContent>
          </Card>
        </div>

        <HistoryPanel />
      </main>
    </div>
  );
}
