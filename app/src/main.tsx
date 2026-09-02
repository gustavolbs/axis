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

installRuntimeTransport();
installChatPlatformEnhancements();

const storedTheme = localStorage.getItem('local-coder.theme');
const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system';
document.documentElement.dataset.lcTheme = theme;
void window.localCoder?.setTheme(theme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRoot />
    <style>{'.sidebar-collapsed .lc-shell-version { display: none !important; }'}</style>
    <SidebarVersion />
  </React.StrictMode>
);
