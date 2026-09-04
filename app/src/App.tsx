import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { AdminProject } from './app-types.js';
import { AgentSurfaceV2 } from './AgentSurfaceV2.js';

interface BreadcrumbJob {
  id: string;
  title?: string;
  input: { goal: string; projectId?: string };
}

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/**
 * Project scope is selected by shell navigation, never by a second selector in
 * the composer. AgentSurfaceV2 still owns the conversation runtime, while this
 * adapter keeps its transitional project picker out of the product surface and
 * projects the shell-owned scope as a breadcrumb.
 */
export function App() {
  const projectId = localStorage.getItem('local-coder.project')?.trim() ?? '';
  const openJobId = localStorage.getItem('local-coder.open-job')?.trim() ?? '';
  const [project, setProject] = useState<AdminProject>();
  const [job, setJob] = useState<BreadcrumbJob>();
  const [breadcrumbTarget, setBreadcrumbTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let disposed = false;
    setProject(undefined);
    setJob(undefined);
    if (projectId) {
      void api<{ project: AdminProject }>(`/api/projects/${encodeURIComponent(projectId)}`)
        .then(({ project: next }) => { if (!disposed) setProject(next); })
        .catch(() => undefined);
    }
    if (openJobId) {
      void api<{ job: BreadcrumbJob }>(`/api/jobs/${encodeURIComponent(openJobId)}`)
        .then(({ job: next }) => { if (!disposed) setJob(next); })
        .catch(() => undefined);
    }
    return () => { disposed = true; };
  }, [openJobId, projectId]);

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;

    const reconcile = () => {
      const threadPane = document.querySelector<HTMLElement>('.lc-agent-thread-pane');
      setBreadcrumbTarget((current) => current === threadPane ? current : threadPane);

      for (const picker of document.querySelectorAll<HTMLElement>('.project-menu-anchor')) {
        picker.hidden = true;
      }
      if (project?.name) {
        for (const chip of document.querySelectorAll<HTMLElement>('.composer-context-chips > span')) {
          if (chip.textContent?.trim() === project.name) chip.hidden = true;
        }
      }
    };

    reconcile();
    const observer = new MutationObserver(reconcile);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [project?.name]);

  useEffect(() => {
    if (projectId) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('.composer-mode-switch button');
      if (!button || button.textContent?.trim() !== 'Cowork') return;
      window.setTimeout(() => {
        const add = document.querySelector<HTMLButtonElement>('.composer-add-anchor > button');
        if (add && add.getAttribute('aria-expanded') !== 'true') add.click();
      }, 0);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [projectId]);

  const companyName = project?.companyName ?? project?.organizationName ?? project?.companyId ?? project?.organizationId;
  const chatTitle = job?.title?.trim() || job?.input.goal || 'New chat';
  const breadcrumb = project && breadcrumbTarget ? createPortal(
    <div
      className="project-detail-breadcrumb"
      aria-label={`${companyName} / ${project.name} / ${chatTitle}`}
      style={{
        position: 'absolute',
        zIndex: 3,
        top: 'calc(var(--lc-titlebar-h) + 8px)',
        left: '50%',
        width: 'min(760px, calc(100% - 44px))',
        transform: 'translateX(-50%)',
        pointerEvents: 'none'
      }}
    >
      <strong>{companyName}</strong><span>/</span><strong>{project.name}</strong><span>/</span>{chatTitle}
    </div>,
    breadcrumbTarget
  ) : null;

  return <>
    <AgentSurfaceV2 />
    {breadcrumb}
  </>;
}
