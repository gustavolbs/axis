import React from 'react';
import ReactDOM from 'react-dom/client';

import { AppRoot } from './AppRoot.js';
import { installRuntimeTransport } from './runtime-shim.js';
import './styles.css';
import './runs.css';
import './runs-fixes.css';
import './cancellation.css';
import './lc-agent-shell.css';
import './lc-agent.css';
import './lc-agent-fidelity.css';
import './lc-shell-fidelity.css';
import './lc-layout-overrides.css';
import './ui-select.css';
import './settings-panels.css';
import './chat-history.css';
import './audit-v2.css';
import './audit-v2-components.css';

installRuntimeTransport();

const storedTheme = localStorage.getItem('local-coder.theme');
const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system';
document.documentElement.dataset.lcTheme = theme;
void window.localCoder?.setTheme(theme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
);
