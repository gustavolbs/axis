import { spawn } from 'node:child_process';
import path from 'node:path';

import { app, BrowserWindow, dialog, session } from 'electron';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7557;
const STARTUP_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_200;

let mainWindow;
let backendChild;
let ownsBackend = false;
let quitting = false;
let backendUrl;

function configuredPort() {
  const raw = process.env.LOCAL_CODER_CONSOLE_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeLocalCoder(url) {
  try {
    const response = await fetch(`${url}/api/jobs`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body && typeof body === 'object' && Array.isArray(body.jobs));
  } catch {
    return false;
  }
}

function backendScript() {
  return path.join(app.getAppPath(), 'dist', 'standalone-console.js');
}

async function stopOwnedBackend() {
  const child = backendChild;
  backendChild = undefined;
  if (!child || !ownsBackend || child.killed) return;
  ownsBackend = false;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2_000)
  ]);
  if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
}

async function startControlPlane() {
  const port = configuredPort();
  const url = `http://${HOST}:${port}`;

  if (await probeLocalCoder(url)) {
    ownsBackend = false;
    backendUrl = url;
    return url;
  }

  const child = spawn(process.execPath, [backendScript()], {
    cwd: app.getPath('home'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LOCAL_CODER_CONSOLE_HOST: HOST,
      LOCAL_CODER_CONSOLE_PORT: String(port)
    },
    stdio: 'ignore',
    windowsHide: true
  });
  backendChild = child;
  ownsBackend = true;

  let exit;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeLocalCoder(url)) {
      backendUrl = url;
      child.once('exit', () => {
        if (!quitting && ownsBackend) void recoverBackendAfterExit();
      });
      return url;
    }
    if (exit) {
      ownsBackend = false;
      backendChild = undefined;
      throw new Error(
        `Local Coder control plane exited before startup (code ${exit.code ?? 'unknown'}, signal ${exit.signal ?? 'none'}).`
      );
    }
    await delay(180);
  }

  await stopOwnedBackend();
  throw new Error(
    `Local Coder control plane did not become ready on ${url}. The port may be occupied by another process.`
  );
}

function restrictRenderer(window, baseUrl) {
  const allowedOrigin = new URL(baseUrl).origin;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin === allowedOrigin) return;
    } catch {
      // Deny malformed/non-URL navigation below.
    }
    event.preventDefault();
  });
}

function createMainWindow(url) {
  const window = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 980,
    minHeight: 700,
    show: false,
    backgroundColor: '#07090d',
    title: 'Local Coder',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });
  restrictRenderer(window, url);
  window.once('ready-to-show', () => window.show());
  void window.loadURL(url);
  return window;
}

async function startWithRecovery() {
  while (!quitting) {
    try {
      return await startControlPlane();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Local Coder could not start',
        message: 'The local control plane is unavailable.',
        detail: `${message}\n\nResolve the port/control-plane issue and choose Retry.`,
        buttons: ['Retry', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (response !== 0) return undefined;
    }
  }
  return undefined;
}

async function recoverBackendAfterExit() {
  if (quitting) return;
  ownsBackend = false;
  backendChild = undefined;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'Local Coder control plane stopped',
    message: 'The Local Coder backend exited unexpectedly.',
    detail: 'Restart the local control plane and reload this session?',
    buttons: ['Restart', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (response !== 0) {
    app.quit();
    return;
  }
  const url = await startWithRecovery();
  if (!url) {
    app.quit();
    return;
  }
  backendUrl = url;
  if (mainWindow && !mainWindow.isDestroyed()) {
    restrictRenderer(mainWindow, url);
    await mainWindow.loadURL(url);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('before-quit', () => {
    quitting = true;
    void stopOwnedBackend();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow && backendUrl) mainWindow = createMainWindow(backendUrl);
  });

  await app.whenReady();
  app.setName('Local Coder');
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const url = await startWithRecovery();
  if (!url) {
    app.quit();
  } else {
    backendUrl = url;
    mainWindow = createMainWindow(url);
    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
  }
}
