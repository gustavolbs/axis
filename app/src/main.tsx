import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactDOM from 'react-dom/client';

import type {
  AgentDecisionResolution,
  AgentLifecycleEvent
} from '../../src/agent-runtime/contracts.js';
import { AgentRuntimeTimeline } from './AgentRuntimeActivity.js';
import { AppRoot } from './AppRoot.js';
import { installChatPlatformEnhancements } from './chat-platform.js';
import { installDiffReviewEnhancements } from './diff-review.js';
import { installRuntimeTransport } from './runtime-shim.js';
// Import order is the cascade. Keep it: tokens/base, then components, then the
// corrections layer. Do not add a fifth stylesheet — fold changes into these.
import './lc-base.css';
import './lc-app.css';
import './lc-fixes.css';

declare const __AXIS_VERSION__: string;

interface LifecycleJob {
  id: string;
  status: string;
  updatedAt: string;
  lifecycleEvents?: readonly AgentLifecycleEvent[];
}

function SidebarVersion() {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.querySelector<HTMLElement>('.lc-shell-sidebar-footer'));
  }, []);

  if (!target) return null;
  return createPortal(
    <div
      className="lc-shell-version"
      aria-label={`Axis version ${__AXIS_VERSION__}`}
    >
      Axis v{__AXIS_VERSION__}
    </div>,
    target
  );
}

function lastElement(selector: string): HTMLElement | null {
  const matches = document.querySelectorAll<HTMLElement>(selector);
  return matches.item(matches.length - 1) || null;
}

/**
 * Transitional renderer composition: the conversation shell remains responsible
 * for navigation/persistence while this controller projects the canonical
 * AgentRuntime lifecycle into the existing assistant body. The shell does not
 * expose its selected job id to sibling controllers, so projection deliberately
 * fails closed when more than one runtime job is active or when the visible
 * conversation is not itself showing an active/approval state. This prevents a
 * background Company/Project run from leaking activity into another chat.
 */
function AgentRuntimeLifecycleController() {
  const [jobs, setJobs] = useState<LifecycleJob[]>([]);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const active = jobs.filter((candidate) =>
    (candidate.lifecycleEvents?.length ?? 0) > 0 &&
    ['queued', 'running', 'waiting-decision', 'waiting-guidance'].includes(candidate.status)
  );
  const job = active.length === 1 ? active[0] : undefined;

  useEffect(() => {
    let disposed = false;
    void fetch('/api/jobs', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        const payload = await response.json() as { jobs?: LifecycleJob[] };
        if (response.ok && !disposed) setJobs(payload.jobs ?? []);
      })
      .catch(() => undefined);

    const events = new EventSource('/api/events');
    events.addEventListener('jobs', (event) => {
      if (disposed) return;
      setJobs(JSON.parse((event as MessageEvent<string>).data) as LifecycleJob[]);
    });
    events.addEventListener('job', (event) => {
      if (disposed) return;
      const payload = JSON.parse((event as MessageEvent<string>).data) as { job: LifecycleJob };
      setJobs((current) => [
        payload.job,
        ...current.filter((candidate) => candidate.id !== payload.job.id)
      ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    });
    return () => {
      disposed = true;
      events.close();
    };
  }, []);

  useEffect(() => {
    const locate = () => {
      const visibleActiveState = document.querySelector(
        '.lc-agent-stop-button, .decision-picker-head'
      );
      const next = visibleActiveState
        ? lastElement('.lc-agent-thread .assistant-body')
        : null;
      setTarget((current) => current === next ? current : next);
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  async function submitDecision(resolution: AgentDecisionResolution) {
    if (!job) return;
    const value = resolution.optionId ?? resolution.text;
    if (!value?.trim()) return;
    const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/decision`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ selections: { [resolution.requestId]: value } })
    });
    const payload = await response.json() as { job?: LifecycleJob; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    if (payload.job) {
      setJobs((current) => [
        payload.job!,
        ...current.filter((candidate) => candidate.id !== payload.job!.id)
      ]);
    }
  }

  if (!job || !target || !(job.lifecycleEvents?.length)) return null;
  return createPortal(
    <AgentRuntimeTimeline
      events={job.lifecycleEvents}
      onDecision={(resolution) => void submitDecision(resolution).catch((error) =>
        console.error('Could not resolve AgentRuntime decision', error)
      )}
      onPermission={({ callId, allowed }) => void submitDecision({
        requestId: `permission-${callId}`,
        optionId: allowed ? 'approve' : 'deny'
      }).catch((error) => console.error('Could not resolve AgentRuntime permission', error))}
    />,
    target,
    `agent-runtime-${job.id}`
  );
}

const storedTheme = localStorage.getItem('local-coder.theme');
const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system';
document.documentElement.dataset.lcTheme = theme;
void window.localCoder?.setTheme(theme);

const root = ReactDOM.createRoot(document.getElementById('root')!);
const runtimeUiPreview = new URLSearchParams(window.location.search).has('runtime-ui-preview');

if (runtimeUiPreview) {
  void import('./RuntimeUiPreview.js').then(({ RuntimeUiPreview }) => {
    root.render(<React.StrictMode><RuntimeUiPreview /></React.StrictMode>);
  });
} else {
  installRuntimeTransport();
  installChatPlatformEnhancements();
  installDiffReviewEnhancements();
  root.render(
    <React.StrictMode>
      <AppRoot />
      <SidebarVersion />
      <AgentRuntimeLifecycleController />
    </React.StrictMode>
  );
}
