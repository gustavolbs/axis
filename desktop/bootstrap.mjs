import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import updaterPackage from 'update-electron-app';
import { installDesktopExecutablePath } from './user-executable-path.mjs';

const { updateElectronApp } = updaterPackage;

function installDesktopRuntimeCwd() {
  const runtimeCwd = path.join(os.homedir(), '.local-coder', 'runtime-cwd');
  fs.mkdirSync(runtimeCwd, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(runtimeCwd, 0o700); } catch { /* best effort on non-POSIX */ }
  process.chdir(runtimeCwd);
  return runtimeCwd;
}

// Finder/Dock-launched macOS apps do not inherit the user's interactive-shell
// PATH. Enrich it before the desktop runtime creates Claude/Codex subprocesses.
// Also pin the process cwd to an Axis-owned directory so provider CLIs never
// inherit an arbitrary Finder/app launch directory and accidentally traverse
// protected user folders merely because no explicit project cwd was supplied.
if (process.platform === 'darwin') {
  installDesktopExecutablePath(process.env);
  installDesktopRuntimeCwd();

  updateElectronApp({
    repo: 'gustavolbs/axis',
    updateInterval: '30 minutes',
    notifyUser: true,
    logger: console
  });
}

// Canonicalize every provider connection through the stable Company graph
// before AppRuntime, ProjectProviderRuntime or account IPC instantiate their
// connection runtimes. Account labels remain display metadata only.
const { installCompanyConnectionOwnership } = await import('../dist/company-connection-ownership.js');
installCompanyConnectionOwnership();

// API endpoint selection is connection-scoped, not provider-scoped. Install it
// after Company canonicalization so every API-key view can carry independent
// transport metadata without changing Account/Ollama behavior.
const { installApiConnectionEndpointRouting } = await import('../dist/api-connection-endpoints.js');
installApiConnectionEndpointRouting();

// Install the standalone active-Company decorator before main.mjs asks the
// compiled runtime class to create its singleton. The decorator keeps Company
// scope server-owned while the existing app runtime remains the implementation
// of jobs, Projects, settings and provider execution.
const { installCompanyScopedDesktopRuntime } = await import('../dist/company-scoped-desktop-runtime.js');
installCompanyScopedDesktopRuntime();

// main.mjs owns the legacy Account/MCP bridge. Schedule the Connection Center
// override one macrotask after Electron becomes ready: initializeDesktop first
// installs the legacy handlers, then this replaces only connection inventory
// and creation while leaving login/status/MCP handlers provider-owned.
const { app } = await import('electron');
const { installConnectionCenterBridge } = await import('./connection-center.mjs');
void app.whenReady().then(() => setImmediate(installConnectionCenterBridge));

await import('./main.mjs');
