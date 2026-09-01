import React from 'react';
import ReactDOM from 'react-dom/client';

import { ConsoleRoot } from './ConsoleRoot.js';
import './styles.css';
import './admin.css';
import './admin-fixes.css';
import './runs.css';
import './runs-fixes.css';
import './cancellation.css';
import './claude-shell.css';
import './claude-agent.css';
import './claude-fidelity.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConsoleRoot />
  </React.StrictMode>
);
