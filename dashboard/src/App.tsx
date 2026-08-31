import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Cpu,
  FileCode2,
  Gauge,
  GitBranch,
  HardDrive,
  ListTree,
  MemoryStick,
  MonitorCog,
  Network,
  ServerCog,
  Sparkles,
  TerminalSquare,
  Workflow,
  Zap
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
  error?: string;
};

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
  inference?: {
    current: Inference | null;
    recent: Inference[];
  };
  ollama?: {
    ok: boolean;
    numCtx?: number;
    configuredModel?: string;
    availableModels?: string[];
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
  controlPlane?: { hostname?: string; platform?: string; workerUrl?: string };
  recentTelemetry?: Array<Record<string, unknown>>;
};

const pipeline = [
  ['workspace', 'Workspace'],
  ['investigation', 'Investigation'],
  ['planning', 'Planning'],
  ['implementation', 'Implementation'],
  ['validation', 'Validation'],
  ['review', 'Review'],
  ['repair', 'Repair'],
  ['repo-learning', 'Repo learning'],
  ['complete', 'Complete']
] as const;

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

function shortTime(value?: string) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function stageIndex(phase?: string) {
  if (!phase) return -1;
  const normalized = phase.toLowerCase();
  const index = pipeline.findIndex(([key]) => normalized.includes(key));
  return index;
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  accent
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof Activity;
  accent?: string;
}) {
  return (
    <Card className="glass overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
            <div className={cn('metric-glow mt-2 text-2xl font-semibold tracking-tight', accent)}>{value}</div>
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
    <div className="space-y-2.5">
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
  const current = stageIndex(phase);
  const completedSet = new Set(completed.map((item) => item.toLowerCase()));
  return (
    <div className="grid gap-1.5 md:grid-cols-9">
      {pipeline.map(([key, label], index) => {
        const explicitlyDone = [...completedSet].some((item) => item.includes(key));
        const done = explicitlyDone || (current >= 0 && index < current) || key === 'complete' && phase === 'complete';
        const active = index === current && phase !== 'complete';
        return (
          <div key={key} className="relative flex min-w-0 items-center gap-2 md:block">
            <div
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold transition-all md:mx-auto',
                done && 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300',
                active && 'border-cyan-300/70 bg-cyan-300/15 text-cyan-200 shadow-[0_0_25px_rgba(34,211,238,.18)]',
                !done && !active && 'border-border bg-secondary/50 text-muted-foreground'
              )}
            >
              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
            </div>
            <div className={cn('truncate text-xs md:mt-2 md:text-center', active ? 'text-cyan-200' : done ? 'text-emerald-300' : 'text-muted-foreground')}>{label}</div>
            {index < pipeline.length - 1 ? <ChevronRight className="hidden h-3 w-3 text-border md:absolute md:-right-2 md:top-2 md:block" /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        const body = (await response.json()) as StatusPayload & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!alive) return;
        setData(body);
        setError(null);
        setLastOkAt(new Date());
      } catch (nextError) {
        if (!alive) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    };
    void poll();
    const timer = window.setInterval(poll, 800);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const scheduler = data?.scheduler;
  const activeJob = scheduler?.active?.[0];
  const progress = activeJob?.progress;
  const currentInference = data?.inference?.current;
  const recentInferences = data?.inference?.recent ?? [];
  const telemetry = data?.recentTelemetry ?? [];
  const cpu = data?.machine?.cpu;
  const memory = data?.machine?.memory;
  const gpu = data?.machine?.gpu;

  const phase = progress?.phase ?? currentInference?.stage ?? (activeJob ? 'workspace' : undefined);
  const headline = progress?.action ?? (currentInference ? `Qwen is running ${currentInference.stage}` : activeJob ? 'Preparing remote workspace' : 'Idle');
  const phaseProgress = useMemo(() => {
    const index = stageIndex(phase);
    return index < 0 ? 0 : ((index + 1) / pipeline.length) * 100;
  }, [phase]);

  const online = Boolean(data?.ok && !error);

  return (
    <div className="min-h-screen">
      <div className="grid-glow" />
      <main className="relative mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 shadow-[0_0_35px_rgba(34,211,238,.09)]">
              <BrainCircuit className="h-6 w-6 text-cyan-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Local Coder</h1>
                <Badge variant="outline" className="border-cyan-400/20 text-cyan-300">Control Plane</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Mac → Meshnet → Windows → Ollama / Qwen · live engineering observability</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={online ? 'success' : 'destructive'} className="gap-2 px-3 py-1.5">
              <span className={cn('h-2 w-2 rounded-full', online ? 'pulse-dot bg-emerald-400' : 'bg-rose-400')} />
              {online ? 'Worker online' : 'Worker unavailable'}
            </Badge>
            <Badge variant="secondary" className="gap-2 px-3 py-1.5"><Clock3 className="h-3.5 w-3.5" />{lastOkAt ? `updated ${lastOkAt.toLocaleTimeString()}` : 'connecting'}</Badge>
          </div>
        </header>

        {error ? (
          <Card className="mb-5 border-rose-400/25 bg-rose-500/5">
            <CardContent className="flex items-center gap-3 p-4 text-sm text-rose-200"><Network className="h-4 w-4" />{error}</CardContent>
          </Card>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Worker" value={data?.hostname ?? '—'} detail={`${data?.platform ?? '—'} · v${data?.workerVersion ?? '—'}`} icon={ServerCog} />
          <MetricCard label="Model" value={data?.model ?? '—'} detail={data?.ollama?.ok ? `Ollama healthy · ${data.ollama.numCtx ?? '—'} ctx` : 'Ollama unavailable'} icon={Sparkles} accent="text-cyan-100" />
          <MetricCard label="Execution" value={`${scheduler?.activeJobs ?? 0} active`} detail={`${scheduler?.queuedJobs ?? 0} queued · concurrency ${scheduler?.maxConcurrentJobs ?? '—'}`} icon={Workflow} />
          <MetricCard label="GPU" value={gpu ? `${gpu.utilizationPercent ?? 0}%` : '—'} detail={gpu ? `${gpu.name ?? 'NVIDIA'} · ${gpu.memoryUsedMiB ?? 0}/${gpu.memoryTotalMiB ?? 0} MiB` : 'nvidia-smi unavailable'} icon={Zap} accent="text-violet-200" />
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.55fr_.85fr]">
          <Card className="glass min-w-0 overflow-hidden border-cyan-400/10">
            <CardHeader className="border-b border-border/70 pb-5">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={activeJob ? 'success' : 'secondary'}>{activeJob ? activeJob.kind.toUpperCase() : 'IDLE'}</Badge>
                    {phase ? <Badge variant="outline" className="border-cyan-400/20 text-cyan-300">{phase}</Badge> : null}
                    {currentInference ? <Badge variant="warning">model inference</Badge> : null}
                  </div>
                  <CardTitle className="mt-3 text-xl sm:text-2xl">{headline}</CardTitle>
                  <CardDescription className="mt-2 max-w-4xl text-sm leading-6">{progress?.detail ?? (activeJob ? 'The worker is executing the current local engineering job.' : 'No active engineering job. The worker is ready.')}</CardDescription>
                </div>
                <div className="shrink-0 text-left sm:text-right">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Elapsed</div>
                  <div className="mt-1 font-mono text-xl font-semibold text-cyan-100">{duration(activeJob?.runningMs)}</div>
                </div>
              </div>
              <Progress className="mt-5 h-1.5" value={phaseProgress} />
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              <Pipeline phase={phase} completed={progress?.completedSteps} />

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-border bg-secondary/25 p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground"><TerminalSquare className="h-3.5 w-3.5" />Current action</div>
                  <p className="mt-2 text-sm font-medium leading-6">{progress?.action ?? (currentInference ? `${currentInference.stage} inference` : activeJob ? 'Workspace / orchestration' : 'Waiting')}</p>
                </div>
                <div className="rounded-xl border border-border bg-secondary/25 p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground"><ListTree className="h-3.5 w-3.5" />Task</div>
                  <p className="mt-2 break-words font-mono text-sm text-slate-200">{progress?.taskId ?? '—'}</p>
                </div>
                <div className="rounded-xl border border-border bg-secondary/25 p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground"><Gauge className="h-3.5 w-3.5" />Validation</div>
                  <p className="mt-2 break-words font-mono text-sm text-slate-200">{progress?.validation ?? '—'}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-violet-400/15 bg-violet-400/[.035] p-5">
                <div className="flex items-center gap-2"><BrainCircuit className="h-4 w-4 text-violet-300" /><h3 className="text-sm font-semibold">Reasoning / decision summary</h3></div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-300">{progress?.reasoningSummary ?? (currentInference ? `Qwen is currently ${currentInference.stage}. A concise decision summary appears here as soon as that stage produces a structured result.` : 'No active reasoning stage.')}</p>
                <p className="mt-3 text-[11px] text-muted-foreground">Shows structured decision summaries and exact execution state, not hidden chain-of-thought tokens.</p>
              </div>

              {progress?.files?.length ? (
                <div>
                  <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground"><FileCode2 className="h-3.5 w-3.5" />Files in current task</div>
                  <div className="flex flex-wrap gap-2">{progress.files.map((file) => <Badge key={file} variant="secondary" className="font-mono font-normal">{file}</Badge>)}</div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="grid gap-4">
            <Card className="glass">
              <CardHeader className="pb-4"><CardTitle className="flex items-center gap-2 text-base"><MonitorCog className="h-4 w-4 text-cyan-300" />Windows execution host</CardTitle><CardDescription>{cpu?.model ?? 'Remote workstation telemetry'}</CardDescription></CardHeader>
              <CardContent className="space-y-5">
                <ResourceBar label="CPU" value={cpu?.usagePercent} detail={`${cpu?.logicalCores ?? '—'} logical cores`} />
                <ResourceBar label="RAM" value={memory?.usedPercent} detail={`${bytes(memory?.usedBytes)} / ${bytes(memory?.totalBytes)}`} />
                {gpu ? <ResourceBar label="GPU" value={gpu.utilizationPercent} detail={`${gpu.memoryUsedMiB ?? 0}/${gpu.memoryTotalMiB ?? 0} MiB VRAM · ${gpu.temperatureC ?? '—'}°C`} /> : null}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="rounded-xl border border-border bg-secondary/25 p-3"><MemoryStick className="h-4 w-4 text-violet-300" /><div className="mt-2 text-xs text-muted-foreground">Worker RSS</div><div className="mt-1 font-semibold">{bytes(data?.machine?.process?.rssBytes)}</div></div>
                  <div className="rounded-xl border border-border bg-secondary/25 p-3"><HardDrive className="h-4 w-4 text-violet-300" /><div className="mt-2 text-xs text-muted-foreground">Uptime</div><div className="mt-1 font-semibold">{duration((data?.machine?.uptimeSeconds ?? 0) * 1000)}</div></div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader className="pb-4"><CardTitle className="flex items-center gap-2 text-base"><GitBranch className="h-4 w-4 text-cyan-300" />Connection</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between gap-4"><span className="text-muted-foreground">Mac</span><span className="truncate font-mono text-xs">{data?.controlPlane?.hostname ?? '—'}</span></div>
                <div className="flex justify-between gap-4"><span className="text-muted-foreground">Worker URL</span><span className="truncate font-mono text-xs">{data?.controlPlane?.workerUrl ?? '—'}</span></div>
                <div className="flex justify-between gap-4"><span className="text-muted-foreground">Collected</span><span className="font-mono text-xs">{shortTime(data?.collectedAt)}</span></div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-2">
          <Card className="glass min-w-0">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Cpu className="h-4 w-4 text-cyan-300" />Model activity</CardTitle><CardDescription>Current and recently completed Qwen inference stages</CardDescription></CardHeader>
            <CardContent>
              {currentInference ? (
                <div className="mb-4 rounded-xl border border-cyan-400/20 bg-cyan-400/[.04] p-4">
                  <div className="flex items-center justify-between gap-4"><div><Badge variant="warning">LIVE</Badge><span className="ml-2 font-semibold capitalize">{currentInference.stage}</span></div><span className="font-mono text-sm text-cyan-100">{duration(currentInference.runningMs)}</span></div>
                  <div className="mt-2 text-xs text-muted-foreground">{currentInference.model}</div>
                </div>
              ) : null}
              <div className="max-h-[340px] space-y-1 overflow-auto pr-1 scrollbar-thin">
                {recentInferences.length ? recentInferences.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-4 border-b border-border/60 py-3 last:border-0">
                    <div className="min-w-0"><div className="flex items-center gap-2"><Badge variant={item.status === 'error' ? 'destructive' : 'secondary'}>{item.stage}</Badge><span className="truncate text-xs text-muted-foreground">{item.model}</span></div><div className="mt-1 text-xs text-muted-foreground">{(item.promptTokens ?? 0) + (item.completionTokens ?? 0)} tokens</div></div>
                    <div className="shrink-0 text-right"><div className="font-mono text-sm">{duration(item.durationMs)}</div><div className="text-xs text-muted-foreground">{shortTime(item.finishedAt)}</div></div>
                  </div>
                )) : <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No inference history yet.</div>}
              </div>
            </CardContent>
          </Card>

          <Card className="glass min-w-0">
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4 text-cyan-300" />Completed engineering activity</CardTitle><CardDescription>Mac control-plane telemetry for completed calls</CardDescription></CardHeader>
            <CardContent>
              <div className="max-h-[420px] space-y-1 overflow-auto pr-1 scrollbar-thin">
                {telemetry.length ? telemetry.map((event, index) => {
                  const status = String(event.status ?? 'unknown');
                  const tokenCount = Number(event.promptTokens ?? 0) + Number(event.completionTokens ?? 0);
                  return (
                    <div key={`${String(event.timestamp)}-${index}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-border/60 py-3 last:border-0">
                      <div className={cn('h-2 w-2 rounded-full', status === 'success' ? 'bg-emerald-400' : status === 'error' ? 'bg-rose-400' : 'bg-amber-400')} />
                      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium capitalize">{String(event.kind ?? 'event')}</span><Badge variant="outline" className="text-[10px]">{status}</Badge></div><div className="mt-1 truncate text-xs text-muted-foreground">{String(event.model ?? '—')} · {tokenCount} tokens · {Number(event.changedFiles ?? 0)} files</div></div>
                      <div className="text-right text-xs text-muted-foreground">{shortTime(String(event.timestamp ?? ''))}</div>
                    </div>
                  );
                }) : <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No completed telemetry yet.</div>}
              </div>
            </CardContent>
          </Card>
        </section>

        <HistoryPanel />
      </main>
    </div>
  );
}
