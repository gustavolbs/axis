import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

const APP_NAME = 'Local Coder';
const READY_TIMEOUT_MS = 10_000;
const userDataPath = path.join(os.homedir(), '.local-coder-mcp', 'desktop');

app.setName(APP_NAME);
app.setPath('userData', userDataPath);

console.log('[Local Coder desktop] bootstrap loaded', {
  pid: process.pid,
  electron: process.versions.electron,
  userData: userDataPath
});

let ready = false;
app.once('ready', () => {
  ready = true;
  console.log('[Local Coder desktop] app ready event received');
});

const readyWatchdog = setTimeout(() => {
  if (ready) return;
  console.error(
    `[Local Coder desktop] Electron did not emit app ready within ${READY_TIMEOUT_MS}ms. ` +
    'The process will exit instead of remaining as a bouncing Dock icon.'
  );
  app.exit(1);
}, READY_TIMEOUT_MS);
readyWatchdog.unref?.();

try {
  await import('./main.mjs');
} finally {
  clearTimeout(readyWatchdog);
}
