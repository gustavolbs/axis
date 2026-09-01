import { useState } from 'react';

import { AdminPanel, type AdminProject } from './AdminPanel.js';
import { App } from './App.js';
import { RunCancellationControl } from './RunCancellationControl.js';
import { RunInspector } from './RunInspector.js';

type Surface = 'agent' | 'projects' | 'runs';

function storedSurface(): Surface {
  const value = localStorage.getItem('local-coder.surface');
  return value === 'projects' || value === 'runs' ? value : 'agent';
}

export function ConsoleRoot() {
  const [surface, setSurface] = useState<Surface>(storedSurface);

  function selectSurface(next: Surface) {
    localStorage.setItem('local-coder.surface', next);
    setSurface(next);
  }

  function runProject(project: AdminProject) {
    localStorage.setItem('local-coder.project', project.id);
    selectSurface('agent');
  }

  return <div className={`console-root surface-${surface}`}>
    <header className="desktop-titlebar">
      <div className="desktop-titlebar-brand" aria-label="Local Coder">
        <span className="local-coder-mark" aria-hidden="true">LC</span>
        <strong>Local Coder</strong>
      </div>
      <nav className="surface-switcher" aria-label="Standalone console section">
        <button className={surface === 'agent' ? 'active' : ''} onClick={() => selectSurface('agent')}>Agent</button>
        <button className={surface === 'projects' ? 'active' : ''} onClick={() => selectSurface('projects')}>Projects</button>
        <button className={surface === 'runs' ? 'active' : ''} onClick={() => selectSurface('runs')}>Runs</button>
      </nav>
      <div className="desktop-titlebar-actions">
        {surface === 'runs' ? <RunCancellationControl /> : null}
      </div>
    </header>

    <div className="surface-viewport">
      {surface === 'agent' ? <App /> : null}
      {surface === 'projects' ? <AdminPanel onRunProject={runProject} /> : null}
      {surface === 'runs' ? <RunInspector /> : null}
    </div>
  </div>;
}
