import updaterPackage from 'update-electron-app';
import { installDesktopExecutablePath } from './user-executable-path.mjs';

const { updateElectronApp } = updaterPackage;

// Finder/Dock-launched macOS apps do not inherit the user's interactive-shell
// PATH. Enrich it before the desktop runtime creates Claude/Codex subprocesses.
if (process.platform === 'darwin') {
  installDesktopExecutablePath(process.env);

  updateElectronApp({
    repo: 'gustavolbs/axis',
    updateInterval: '30 minutes',
    notifyUser: true,
    logger: console
  });
}

await import('./main.mjs');
