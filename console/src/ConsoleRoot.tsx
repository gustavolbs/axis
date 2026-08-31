import { useState, type FormEvent } from 'react';

import { AdminPanel, type AdminProject } from './AdminPanel.js';
import { App } from './App.js';
import { RunInspector } from './RunInspector.js';

type Surface = 'agent' | 'projects' | 'runs';

interface RunDraft {
  project: AdminProject;
  goal: string;
  context: string;
}

async function createProjectJob(projectId: string, goal: string, context: string): Promise<void> {
  const response = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      goal,
      context: context.trim() || undefined,
      maxRepairRounds: 1
    })
  });
  const body = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
}

function storedSurface(): Surface {
  const value = localStorage.getItem('local-coder.surface');
  return value === 'projects' || value === 'runs' ? value : 'agent';
}

export function ConsoleRoot() {
  const [surface, setSurface] = useState<Surface>(storedSurface);
  const [runDraft, setRunDraft] = useState<RunDraft>();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string>();

  function selectSurface(next: Surface) {
    localStorage.setItem('local-coder.surface', next);
    setSurface(next);
  }

  function prepareProjectRun(project: AdminProject) {
    setRunError(undefined);
    setRunDraft({ project, goal: '', context: '' });
  }

  async function submitProjectRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runDraft?.goal.trim()) return;
    setRunning(true);
    setRunError(undefined);
    try {
      await createProjectJob(runDraft.project.id, runDraft.goal.trim(), runDraft.context);
      setRunDraft(undefined);
      selectSurface('agent');
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  return <div className="console-root">
    <nav className="surface-switcher" aria-label="Standalone console section">
      <button className={surface === 'agent' ? 'active' : ''} onClick={() => selectSurface('agent')}>Agent</button>
      <button className={surface === 'projects' ? 'active' : ''} onClick={() => selectSurface('projects')}>Projects</button>
      <button className={surface === 'runs' ? 'active' : ''} onClick={() => selectSurface('runs')}>Runs</button>
    </nav>

    {surface === 'agent' ? <App /> : null}
    {surface === 'projects' ? <AdminPanel onRunProject={prepareProjectRun} /> : null}
    {surface === 'runs' ? <RunInspector /> : null}

    {runDraft ? <div className="modal-backdrop" role="presentation" onMouseDown={() => !running && setRunDraft(undefined)}>
      <form className="run-project-modal panel" onSubmit={(event) => void submitProjectRun(event)} onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-heading">
          <div><span className="eyebrow">RUN PROJECT</span><strong>{runDraft.project.name}</strong></div>
          <button type="button" className="secondary small-button" disabled={running} onClick={() => setRunDraft(undefined)}>Close</button>
        </div>
        <div className="project-run-context">
          <span>{runDraft.project.organizationName ?? runDraft.project.organizationId}</span>
          <code>{runDraft.project.workspace}</code>
          <span className={`status-pill ${runDraft.project.privacy.cloudAllowed ? 'live' : 'good'}`}>{runDraft.project.defaultRoutingPolicy}</span>
        </div>
        {runError ? <div className="error-banner">{runError}</div> : null}
        <label>Goal<textarea autoFocus required rows={5} value={runDraft.goal} onChange={(event) => setRunDraft((current) => current ? { ...current, goal: event.target.value } : current)} placeholder="Describe the engineering outcome…" /></label>
        <label>Context / constraints<textarea rows={3} value={runDraft.context} onChange={(event) => setRunDraft((current) => current ? { ...current, context: event.target.value } : current)} placeholder="Optional project-specific context" /></label>
        <p className="muted small">The server resolves the workspace, routing policy, credentials and budget from this Project. The browser sends only the Project ID and goal.</p>
        <button className="primary" disabled={running || !runDraft.goal.trim()}>{running ? 'Starting…' : 'Start Project agent'}</button>
      </form>
    </div> : null}
  </div>;
}
