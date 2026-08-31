import { useEffect, useMemo, useState } from 'react';

type CancellableStatus = 'queued' | 'running' | 'waiting-decision' | 'waiting-guidance';

interface ActiveJob {
  id: string;
  status: string;
  createdAt: string;
  input: { projectId?: string; goal: string };
}

const cancellable = new Set<CancellableStatus>([
  'queued',
  'running',
  'waiting-decision',
  'waiting-guidance'
]);

function activeJobs(jobs: ActiveJob[]): ActiveJob[] {
  return jobs
    .filter((job) => cancellable.has(job.status as CancellableStatus))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function RunCancellationControl() {
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const active = useMemo(() => activeJobs(jobs), [jobs]);
  const selected = active.find((job) => job.id === selectedId) ?? active[0];

  useEffect(() => {
    void fetch('/api/jobs', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        const body = (await response.json()) as { jobs?: ActiveJob[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        setJobs(body.jobs ?? []);
      })
      .catch((next) => setError(next instanceof Error ? next.message : String(next)));

    const events = new EventSource('/api/events');
    events.addEventListener('jobs', (event) => {
      setJobs(JSON.parse((event as MessageEvent<string>).data) as ActiveJob[]);
    });
    events.addEventListener('job', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { job: ActiveJob };
      setJobs((current) => [payload.job, ...current.filter((job) => job.id !== payload.job.id)]);
    });
    return () => events.close();
  }, []);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
    if (!selected && selectedId) setSelectedId(undefined);
  }, [selected?.id, selectedId]);

  async function cancelSelected() {
    if (!selected || cancelling) return;
    if (!window.confirm(`Cancel “${selected.input.goal}”? Active provider/validation work will be aborted.`)) return;
    setCancelling(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(selected.id)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      });
      const body = (await response.json()) as { job?: ActiveJob; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (body.job) {
        setJobs((current) => [body.job!, ...current.filter((job) => job.id !== body.job!.id)]);
      }
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setCancelling(false);
    }
  }

  if (active.length === 0) return error ? <span className="run-cancel-error">{error}</span> : null;

  return <div className="run-cancel-control">
    <select
      aria-label="Active Local Coder run"
      value={selected?.id ?? ''}
      onChange={(event) => setSelectedId(event.target.value)}
    >
      {active.map((job) => <option key={job.id} value={job.id}>
        {job.status} · {job.input.projectId ? `${job.input.projectId} · ` : ''}{job.input.goal.slice(0, 64)}
      </option>)}
    </select>
    <button className="cancel-run-button" disabled={!selected || cancelling} onClick={() => void cancelSelected()}>
      {cancelling ? 'Cancelling…' : 'Cancel run'}
    </button>
    {error ? <span className="run-cancel-error">{error}</span> : null}
  </div>;
}
