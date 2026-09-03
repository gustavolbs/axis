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

// Install the standalone active-Company decorator before main.mjs asks the
// compiled runtime class to create its singleton. The decorator keeps Company
// scope server-owned while the existing app runtime remains the implementation
// of jobs, Projects, settings and provider execution.
const { installCompanyScopedDesktopRuntime } = await import('../dist/company-scoped-desktop-runtime.js');
installCompanyScopedDesktopRuntime();

await import('./main.mjs');
