import updaterPackage from 'update-electron-app';

const { updateElectronApp } = updaterPackage;

// The official updater is deliberately initialized before the desktop main
// module. It is a no-op for unpackaged development builds and unsupported
// platforms, so local development keeps the same behavior.
updateElectronApp({
  repo: 'gustavolbs/local-coder-mcp',
  updateInterval: '30 minutes',
  notifyUser: true,
  logger: console
});

await import('./main.mjs');
