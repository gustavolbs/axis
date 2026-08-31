import {
  AlertTriangle,
  Bot,
  Braces,
  CheckCircle2,
  Clock3,
  FileText,
  History,
  MessageSquareText,
  TerminalSquare
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type RunSummary = {
  id: string;
  kind: string;
  isolationKey: string;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt?: string;
  goal?: string;
  repositoryUrl?: string;
  phase?: string;
  action?: string;
  error?: string;
};

type ProgressValue = {
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

type HistoryEvent = {
  timestamp: string;
  type: 'job-start' | 'request' | 'progress' | 'model-input' | 'model-output' | 'result' | 'error' | 'job-finish';
  title?: string;
  stage?: string;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  output?: string;
  promptTruncated?: boolean;
  originalUserPromptChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  error?: string;
  progress?: ProgressValue;
  data?: Record<string, unknown>;
};

type RunDetail = { summary: RunSummary; events: HistoryEvent[] };

function shortTime(value?: string) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortDate(value?: string) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString([], { month: 'short', day: '2-digit' });
}

function duration(ms?: number) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms! / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function runLabel(run: RunSummary) {
  return run.goal?.trim() || `${run.kind} · ${run.id.slice(0, 8)}`;
}

function eventTone(type: HistoryEvent['type']) {
  if (type === 'error') return 'border-rose-400/25 bg-rose-500/[.04]';
  if (type === 'model-input') return 'border-cyan-400/20 bg-cyan-400/[.035]';
  if (type === 'model-output') return 'border-violet-400/20 bg-violet-400/[.035]';
  if (type === 'job-finish') return 'border-emerald-400/15 bg-emerald-400/[.025]';
  return 'border-border bg-secondary/20';
}

function PromptBlock({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <details className="group rounded-xl border border-border bg-black/20">
      <summary className="cursor-pointer select-none px-4 py-3 text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground group-open:text-slate-200">
        {label}
      </summary>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-xs leading-5 text-slate-300 scrollbar-thin">{value}</pre>
    </details>
  );
}

function EventCard({ event }: { event: HistoryEvent }) {
  const isModelInput = event.type === 'model-input';
  const isModelOutput = event.type === 'model-output';
  const isError = event.type === 'error';
  const icon = isModelInput ? MessageSquareText : isModelOutput ? Bot : isError ? AlertTriangle : event.type === 'progress' ? TerminalSquare : event.type === 'request' ? FileText : CheckCircle2;
  const Icon = icon;
  const tokenCount = (event.promptTokens ?? 0) + (event.completionTokens ?? 0);

  return (
    <div className={cn('rounded-2xl border p-4', eventTone(event.type))}>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-lg border border-border bg-background/70 p-2">
            <Icon className="h-4 w-4 text-cyan-300" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{event.title ?? event.type}</span>
              {event.stage ? <Badge variant="outline" className="text-[10px]">{event.stage}</Badge> : null}
              {event.model ? <Badge variant="secondary" className="text-[10px]">{event.model}</Badge> : null}
              {event.promptTruncated ? <Badge variant="warning" className="text-[10px]">prompt bounded</Badge> : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span>{shortTime(event.timestamp)}</span>
              {event.durationMs !== undefined ? <span>{duration(event.durationMs)}</span> : null}
              {tokenCount > 0 ? <span>{tokenCount.toLocaleString()} tokens</span> : null}
            </div>
          </div>
        </div>
      </div>

      {event.progress ? (
        <div className="mt-4 space-y-2 text-sm text-slate-300">
          {event.progress.action ? <p className="font-medium text-slate-200">{event.progress.action}</p> : null}
          {event.progress.detail ? <p className="whitespace-pre-wrap leading-6">{event.progress.detail}</p> : null}
          {event.progress.reasoningSummary ? <p className="whitespace-pre-wrap rounded-xl border border-violet-400/10 bg-violet-400/[.025] p-3 leading-6">{event.progress.reasoningSummary}</p> : null}
          {event.progress.validation ? <pre className="overflow-auto rounded-xl border border-border bg-black/25 p-3 font-mono text-xs">{event.progress.validation}</pre> : null}
        </div>
      ) : null}

      {event.data ? (
        <pre className="mt-4 max-h-[320px] overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-black/20 p-3 font-mono text-xs leading-5 text-slate-300 scrollbar-thin">{JSON.stringify(event.data, null, 2)}</pre>
      ) : null}

      {isModelInput ? (
        <div className="mt-4 space-y-2">
          <PromptBlock label="System prompt sent to model" value={event.systemPrompt} />
          <PromptBlock label="User prompt sent to model" value={event.userPrompt} />
          {event.originalUserPromptChars ? <p className="text-[11px] text-muted-foreground">Original user-prompt size: {event.originalUserPromptChars.toLocaleString()} characters. The stored prompt above is the exact bounded prompt sent to Ollama.</p> : null}
        </div>
      ) : null}

      {isModelOutput && event.output ? (
        <div className="mt-4 rounded-xl border border-violet-400/10 bg-black/20">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground"><Braces className="h-3.5 w-3.5" />Model output</div>
          <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5 text-slate-300 scrollbar-thin">{event.output}</pre>
        </div>
      ) : null}

      {event.error ? <pre className="mt-4 whitespace-pre-wrap rounded-xl border border-rose-400/20 bg-rose-500/[.04] p-3 font-mono text-xs text-rose-200">{event.error}</pre> : null}
    </div>
  );
}

export function HistoryPanel() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const response = await fetch('/api/history?limit=80', { cache: 'no-store' });
        const body = (await response.json()) as { runs?: RunSummary[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!alive) return;
        const next = body.runs ?? [];
        setRuns(next);
        setSelectedId((current) => current ?? next[0]?.id ?? null);
        setError(null);
      } catch (nextError) {
        if (alive) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/history/${encodeURIComponent(selectedId)}`, { cache: 'no-store' });
        const body = (await response.json()) as { run?: RunDetail; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (alive) setDetail(body.run ?? null);
      } catch (nextError) {
        if (alive) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  const selected = useMemo(() => runs.find((run) => run.id === selectedId), [runs, selectedId]);

  return (
    <Card className="glass mt-4 overflow-hidden">
      <CardHeader className="border-b border-border/70">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4 text-cyan-300" />Execution history</CardTitle>
            <CardDescription className="mt-1">Read-only timeline of Local Coder requests, exact prompts sent to Ollama, stage outputs, progress and failures. Persisted on the Windows worker.</CardDescription>
          </div>
          <Badge variant="outline" className="w-fit">read only</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error ? <div className="border-b border-rose-400/20 bg-rose-500/[.04] px-5 py-3 text-sm text-rose-200">{error}</div> : null}
        <div className="grid min-h-[520px] lg:grid-cols-[320px_1fr]">
          <aside className="max-h-[760px] overflow-auto border-b border-border/70 p-3 scrollbar-thin lg:border-b-0 lg:border-r">
            {runs.length ? runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedId(run.id)}
                className={cn(
                  'mb-2 w-full rounded-xl border p-3 text-left transition-colors last:mb-0',
                  selectedId === run.id ? 'border-cyan-400/25 bg-cyan-400/[.055]' : 'border-border bg-secondary/20 hover:bg-secondary/40'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={run.status === 'error' ? 'destructive' : run.status === 'running' ? 'warning' : 'success'} className="text-[10px]">{run.status}</Badge>
                  <span className="text-[10px] text-muted-foreground">{shortDate(run.startedAt)} · {shortTime(run.startedAt)}</span>
                </div>
                <p className="mt-2 line-clamp-3 text-sm font-medium leading-5">{runLabel(run)}</p>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><Clock3 className="h-3 w-3" />{run.phase ?? run.kind} · {run.id.slice(0, 8)}</div>
              </button>
            )) : <div className="p-6 text-center text-sm text-muted-foreground">No persisted Local Coder runs yet.</div>}
          </aside>

          <div className="min-w-0 p-4 sm:p-5">
            {selected ? (
              <div className="mb-5 border-b border-border/70 pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={selected.status === 'error' ? 'destructive' : selected.status === 'running' ? 'warning' : 'success'}>{selected.status}</Badge>
                  <Badge variant="secondary">{selected.kind}</Badge>
                  {selected.phase ? <Badge variant="outline">{selected.phase}</Badge> : null}
                </div>
                <h3 className="mt-3 text-lg font-semibold leading-7">{runLabel(selected)}</h3>
                {selected.repositoryUrl ? <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{selected.repositoryUrl}</p> : null}
              </div>
            ) : null}

            <div className="max-h-[680px] space-y-3 overflow-auto pr-1 scrollbar-thin">
              {detail?.events.length ? detail.events.map((event, index) => <EventCard key={`${event.timestamp}-${event.type}-${index}`} event={event} />) : <div className="flex min-h-[360px] items-center justify-center rounded-2xl border border-dashed border-border text-sm text-muted-foreground">Select a run to inspect its timeline.</div>}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
