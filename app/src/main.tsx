import React from 'react';
import ReactDOM from 'react-dom/client';

import { AppRoot } from './AppRoot.js';
import { GlobalWorkHubLauncher } from './GlobalWorkHubLauncher.js';
import { installChatPlatformEnhancements } from './chat-platform.js';
import { installRuntimeTransport } from './runtime-shim.js';
// Import order is the cascade. Keep it: tokens/base, then components, then the
// corrections layer. Do not add a fifth stylesheet — fold changes into these.
import './lc-base.css';
import './lc-app.css';
import './lc-fixes.css';

installRuntimeTransport();
installChatPlatformEnhancements();

const storedTheme = localStorage.getItem('local-coder.theme');
const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system';
document.documentElement.dataset.lcTheme = theme;
void window.localCoder?.setTheme(theme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRoot />
    <GlobalWorkHubLauncher />
  </React.StrictMode>
);
