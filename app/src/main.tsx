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

interface CompanyScopeOption {
  id: string;
  name: string;
  color: string;
  kind: 'personal' | 'company';
}

interface CompanyScopeSnapshot {
  activeCompanyId: string;
  company: CompanyScopeOption;
  companies: CompanyScopeOption[];
}

interface LifecycleJob {
  id: string;
  status: string;
  updatedAt: string;
  lifecycleEvents?: readonly AgentLifecycleEvent[];
}

type ScopePlacement = 'chrome' | 'composer' | 'approval' | 'result';

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

function CompanyScopeSelector(props: {
  snapshot: CompanyScopeSnapshot;
  placement: ScopePlacement;
  switching: boolean;
  onSwitch: (companyId: string) => Promise<void>;
}) {
  return <label className="axis-company-scope" data-placement={props.placement} title={`Active Company: ${props.snapshot.company.name}`}>
    <svg className="axis-company-scope-dot" viewBox="0 0 8 8" aria-hidden="true">
      <circle cx="4" cy="4" r="4" fill={props.snapshot.company.color} />
    </svg>
    <span className="axis-company-scope-label">Company</span>
    <select
      aria-label={`Active Company in ${props.placement}`}
      value={props.snapshot.activeCompanyId}
      disabled={props.switching}
      onChange={(event) => void props.onSwitch(event.target.value)}
    >
      {props.snapshot.companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
    </select>
  </label>;
}

function CompanyScopeController() {
  const [snapshot, setSnapshot] = useState<CompanyScopeSnapshot>();
  const [switching, setSwitching] = useState(false);
  const [targets, setTargets] = useState<Record<ScopePlacement, HTMLElement | null>>({
    chrome: null,
    composer: null,
    approval: null,
    result: null
  });

  useEffect(() => {
    let disposed = false;
    fetch('/api/companies/active', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        const payload = await response.json() as { scope?: CompanyScopeSnapshot; error?: string };
        if (!response.ok || !payload.scope) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (!disposed) setSnapshot(payload.scope);
      })
      .catch((error) => console.error('Could not load active Company scope', error));
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const locate = () => {
      const next = {
        chrome: document.querySelector<HTMLElement>('.lc-shell-window-chrome'),
        composer: document.querySelector<HTMLElement>('.composer-toolbar-left'),
        approval: document.querySelector<HTMLElement>('.decision-picker-head'),
        result: lastElement('.lc-agent-thread .assistant-result-message')
      };
      setTargets((current) => Object.keys(next).every((key) =>
        current[key as ScopePlacement] === next[key as ScopePlacement]
      ) ? current : next);
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  async function switchCompany(companyId: string) {
    if (!snapshot || companyId === snapshot.activeCompanyId || switching) return;
    setSwitching(true);
    try {
      const response = await fetch('/api/companies/active', {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ companyId })
      });
      const payload = await response.json() as { scope?: CompanyScopeSnapshot; error?: string };
      if (!response.ok || !payload.scope) throw new Error(payload.error ?? `HTTP ${response.status}`);
      localStorage.removeItem('local-coder.open-job');
      localStorage.removeItem('local-coder.project');
      localStorage.removeItem('local-coder.settings-project');
      window.location.reload();
    } catch (error) {
      setSwitching(false);
      console.error('Could not switch active Company', error);
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  if (!snapshot) return null;
  return <>
    {(Object.entries(targets) as Array<[ScopePlacement, HTMLElement | null]>).map(
      ([placement, target]) => target
        ? createPortal(
            <CompanyScopeSelector
              snapshot={snapshot}
              placement={placement}
              switching={switching}
              onSwitch={switchCompany}
            />,
            target,
            placement
          )
        : null
    )}
  </>;
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
    const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/decision`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ selections: { [resolution.requestId]: resolution.optionId } })
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
      <CompanyScopeController />
      <AgentRuntimeLifecycleController />
    </React.StrictMode>
  );
}
