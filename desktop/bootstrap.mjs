import updaterPackage from 'update-electron-app';

const { updateElectronApp } = updaterPackage;

// Axis currently publishes an automatic-update channel only for macOS.
// update-electron-app itself is a no-op for unpackaged development builds.
if (process.platform === 'darwin') {
  updateElectronApp({
    repo: 'gustavolbs/local-coder-mcp',
    updateInterval: '30 minutes',
    notifyUser: true,
    logger: console
  });
}

await import('./main.mjs');
