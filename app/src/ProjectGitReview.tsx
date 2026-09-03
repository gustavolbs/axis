import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import type { AdminProject } from './app-types.js';

type GitScope = 'working' | 'staged';

interface ProjectGitReviewView {
  scope: GitScope;
  workspace: string;
  repositoryRoot: string;
  diff: string;
  status: string[];
  clean: boolean;
  generatedAt: string;
}

async function loadReview(projectId: string, scope: GitScope): Promise<ProjectGitReviewView> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/git-diff?scope=${encodeURIComponent(scope)}`, {
    headers: { accept: 'application/json' }
  });
  const body = await response.json() as { review?: ProjectGitReviewView; error?: string };
  if (!response.ok || !body.review) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.review;
}

export function ProjectGitReview({ project }: { project: AdminProject }) {
  const [scope, setScope] = useState<GitScope>('working');
  const [review, setReview] = useState<ProjectGitReviewView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!project.workspace) return;
    setLoading(true);
    setError(undefined);
    try {
      setReview(await loadReview(project.id, scope));
    } catch (next) {
      setReview(undefined);
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setLoading(false);
    }
  }, [project.id, project.workspace, scope]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!project.workspace) return null;

  const scopedStatus = review?.status.filter((line) => scope === 'staged' ? line[0] !== ' ' && line[0] !== '?' : line[1] !== ' ' || line.startsWith('??')) ?? [];

  return <section className="project-detail-recent project-git-review" data-company-id={project.companyId} data-project-id={project.id}>
    <header className="connection-section-heading">
      <div><h2>Changes</h2><p>Git state from this Project folder only.</p></div>
      <button type="button" className="btn-secondary" disabled={loading} onClick={() => void refresh()}><RefreshCw size={13} />{loading ? 'Refreshing…' : 'Refresh'}</button>
    </header>
    <div className="project-detail-mode" aria-label="Git diff scope">
      <button type="button" className={scope === 'working' ? 'active' : ''} onClick={() => setScope('working')}>Unstaged</button>
      <button type="button" className={scope === 'staged' ? 'active' : ''} onClick={() => setScope('staged')}>Staged</button>
    </div>
    {error ? <div className="lc-shell-inline-error project-detail-error">{error}</div> : null}
    {!error && review ? <>
      <p>{scopedStatus.length === 0 ? `No ${scope === 'staged' ? 'staged' : 'unstaged'} changes.` : `${scopedStatus.length} ${scope === 'staged' ? 'staged' : 'working-tree'} entr${scopedStatus.length === 1 ? 'y' : 'ies'}.`}</p>
      {scopedStatus.length > 0 ? <details className="assistant-details"><summary>Git status</summary><pre className="thread-diff">{scopedStatus.join('\n')}</pre></details> : null}
      {review.diff ? <details className="assistant-details" key={`${review.scope}:${review.generatedAt}`} open><summary>Diff</summary><pre className="thread-diff">{review.diff}</pre></details> : null}
    </> : loading ? <p>Reading Git state…</p> : null}
  </section>;
}
