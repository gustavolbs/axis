import { useEffect, useState } from 'react';
import { KeyRound, Palette, Route, Settings2, X } from 'lucide-react';

import type { AdminProject } from './AdminPanel.js';
import { FolderField } from './FolderField.js';
import { ApiKeySettings, ModelRoutingSettings } from './SettingsPanels.js';
import type { ThemeMode } from './native.js';

type SettingsTab = 'general' | 'appearance' | 'routing' | 'keys';

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.dataset.lcTheme = mode;
  localStorage.setItem('local-coder.theme', mode);
  void window.lc?.setTheme(mode);
}

export function SettingsModal({
  open,
  onClose,
  onRunProject: _onRunProject
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
  const [defaultWorkspace, setDefaultWorkspace] = useState(() => localStorage.getItem('local-coder.workspace') ?? '');
  const [openAtLogin, setOpenAtLogin] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    void window.lc?.getLoginItemSettings().then((value) => setOpenAtLogin(value.openAtLogin));
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  function chooseTheme(next: ThemeMode) {
    setTheme(next);
    applyTheme(next);
  }

  function updateDefaultWorkspace(value: string) {
    setDefaultWorkspace(value);
    if (value.trim()) localStorage.setItem('local-coder.workspace', value.trim());
    else localStorage.removeItem('local-coder.workspace');
  }

  async function toggleOpenAtLogin() {
    const next = !openAtLogin;
    setOpenAtLogin(next);
    try {
      const actual = await window.lc?.setOpenAtLogin(next);
      if (actual) setOpenAtLogin(actual.openAtLogin);
    } catch {
      setOpenAtLogin(!next);
    }
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
          <h1 className="page-title">General</h1>
          <div className="settings-card settings-card-column">
            <div><strong>Default workspace</strong><p>Used for a chat when you do not choose a configured Project.</p></div>
            <FolderField value={defaultWorkspace} onChange={updateDefaultWorkspace} placeholder="/Users/you/code/project" />
          </div>
          {window.lc ? <div className="settings-card">
            <div><strong>Start on login</strong><p>Open Local Coder automatically when you sign in to macOS.</p></div>
            <button className={`claude-switch ${openAtLogin ? 'on' : ''}`} aria-pressed={openAtLogin} onClick={() => void toggleOpenAtLogin()}><i /></button>
          </div> : null}
          <div className="settings-card">
            <div><strong>Control plane</strong><p>{window.location.origin}</p></div>
            <span className="settings-status">Ready</span>
          </div>
        </div> : null}

        {tab === 'appearance' ? <div className="settings-simple-page">
          <h1 className="page-title">Appearance</h1>
          <div className="settings-option-group" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => <button key={mode} className={theme === mode ? 'selected' : ''} role="radio" aria-checked={theme === mode} onClick={() => chooseTheme(mode)}>
              <span className={`theme-preview theme-${mode}`}><i /><i /></span>
              <span><strong>{mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'}</strong><small>{mode === 'system' ? 'Follow macOS appearance' : `Always use ${mode} mode`}</small></span>
            </button>)}
          </div>
        </div> : null}

        {tab === 'routing' ? <ModelRoutingSettings /> : null}
        {tab === 'keys' ? <ApiKeySettings /> : null}
      </div>
    </section>
  </div>;
}
