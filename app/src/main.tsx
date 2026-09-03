import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactDOM from 'react-dom/client';

import { AppRoot } from './AppRoot.js';
import { installChatPlatformEnhancements } from './chat-platform.js';
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
      style={{
        padding: '1px 8px 0',
        color: 'var(--lc-faint)',
        fontSize: '10px',
        lineHeight: 1.4,
        letterSpacing: '0.01em'
      }}
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
    <span className="axis-company-scope-dot" style={{ background: props.snapshot.company.color }} aria-hidden="true" />
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
      setTargets((current) => Object.keys(next).every((key) => current[key as ScopePlacement] === next[key as ScopePlacement]) ? current : next);
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
    {(Object.entries(targets) as Array<[ScopePlacement, HTMLElement | null]>).map(([placement, target]) => target
      ? createPortal(<CompanyScopeSelector snapshot={snapshot} placement={placement} switching={switching} onSwitch={switchCompany} />, target, placement)
      : null)}
  </>;
}

installRuntimeTransport();
installChatPlatformEnhancements();

const storedTheme = localStorage.getItem('local-coder.theme');
const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system';
document.documentElement.dataset.lcTheme = theme;
void window.localCoder?.setTheme(theme);

const runtimeStyles = `
.sidebar-collapsed .lc-shell-version { display: none !important; }
.axis-company-scope {
  display: inline-flex;
  min-width: 0;
  max-width: 190px;
  height: 26px;
  align-items: center;
  gap: 5px;
  padding: 0 7px;
  border: 1px solid var(--lc-border);
  border-radius: 7px;
  background: var(--lc-surface-2);
  color: var(--lc-muted);
  font-size: 10px;
  line-height: 1;
  -webkit-app-region: no-drag;
}
.axis-company-scope-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; box-shadow: 0 0 0 1px rgba(255,255,255,.15); }
.axis-company-scope-label { color: var(--lc-faint); }
.axis-company-scope select {
  min-width: 0;
  max-width: 112px;
  height: 22px;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--lc-text-soft);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.axis-company-scope select:disabled { cursor: wait; opacity: .65; }
.axis-company-scope[data-placement="chrome"] { margin-left: auto; margin-right: 9px; }
.axis-company-scope[data-placement="composer"] { max-width: 170px; }
.decision-picker-head > .axis-company-scope[data-placement="approval"] { order: 2; margin-left: auto; }
.decision-picker-head > button { order: 3; }
.assistant-result-message > .axis-company-scope[data-placement="result"] { margin-top: 9px; }
@media (max-width: 820px) {
  .axis-company-scope-label { display: none; }
  .axis-company-scope { max-width: 145px; }
  .axis-company-scope select { max-width: 118px; }
}
`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRoot />
    <style>{runtimeStyles}</style>
    <SidebarVersion />
    <CompanyScopeController />
  </React.StrictMode>
);
