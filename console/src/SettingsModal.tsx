import { useEffect, useState } from 'react';
import { KeyRound, Palette, Route, Settings2, X } from 'lucide-react';

import { AdminPanel, type AdminProject } from './AdminPanel.js';

type SettingsTab = 'general' | 'appearance' | 'routing' | 'keys';
type ThemeMode = 'system' | 'dark' | 'light';

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.dataset.lcTheme = mode;
  localStorage.setItem('local-coder.theme', mode);
}

export function SettingsModal({
  open,
  onClose,
  onRunProject
}: {
  open: boolean;
  onClose: () => void;
  onRunProject: (project: AdminProject) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>('general');
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem('local-coder.theme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  function chooseTheme(next: ThemeMode) {
    setTheme(next);
    applyTheme(next);
  }

  return <div className="settings-modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="settings-rail">
        <div className="settings-rail-title">Settings</div>
        <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}><Settings2 size={15} /><span>General</span></button>
        <button className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}><Palette size={15} /><span>Appearance</span></button>
        <button className={tab === 'routing' ? 'active' : ''} onClick={() => setTab('routing')}><Route size={15} /><span>Model routing</span></button>
        <button className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}><KeyRound size={15} /><span>API keys</span></button>
      </aside>

      <div className="settings-content">
        <button className="settings-close" onClick={onClose} aria-label="Close settings"><X size={17} /></button>

        {tab === 'general' ? <div className="settings-simple-page">
          <h1>General</h1>
          <div className="settings-card">
            <div><strong>Local Coder</strong><p>Agent runtime, project isolation and provider routing run on your control plane.</p></div>
            <span className="settings-status">Ready</span>
          </div>
          <div className="settings-card">
            <div><strong>Run inspector</strong><p>Routing decisions, fallbacks, token usage and cost stay available from Runs in the sidebar.</p></div>
          </div>
        </div> : null}

        {tab === 'appearance' ? <div className="settings-simple-page">
          <h1>Appearance</h1>
          <div className="settings-option-group" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => <button key={mode} className={theme === mode ? 'selected' : ''} role="radio" aria-checked={theme === mode} onClick={() => chooseTheme(mode)}>
              <span className={`theme-preview theme-${mode}`}><i /><i /></span>
              <span><strong>{mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'}</strong><small>{mode === 'system' ? 'Follow macOS appearance' : `Always use ${mode} mode`}</small></span>
            </button>)}
          </div>
        </div> : null}

        {tab === 'routing' ? <div className="settings-admin-view settings-view-routing"><AdminPanel onRunProject={onRunProject} /></div> : null}
        {tab === 'keys' ? <div className="settings-admin-view settings-view-credentials"><AdminPanel onRunProject={onRunProject} /></div> : null}
      </div>
    </section>
  </div>;
}
