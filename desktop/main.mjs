import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, dialog, nativeTheme, screen, session } from 'electron';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7557;
const STARTUP_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_200;
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 840;
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 560;
const WINDOW_STATE_FILE = 'window-state.json';
const SAVE_BOUNDS_DEBOUNCE_MS = 180;

let mainWindow;
let backendChild;
let ownsBackend = false;
let quitting = false;
let backendUrl;
let saveBoundsTimer;

function log(message, detail) {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[Local Coder desktop] ${message}${suffix}`);
}

// Register lifecycle diagnostics immediately, before any desktop setup. The Electron
// main module must finish evaluating before we wait for app readiness; using a
// top-level `await app.whenReady()` here can deadlock ESM main-process startup.
log('main module loaded', {
  pid: process.pid,
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron
});
app.once('will-finish-launching', () => log('will-finish-launching'));
app.once('ready', () => log('ready event received'));

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

function windowStatePath() {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

function finiteInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : undefined;
}

function readWindowState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    return {
      x: finiteInteger(parsed?.x),
      y: finiteInteger(parsed?.y),
      width: finiteInteger(parsed?.width),
      height: finiteInteger(parsed?.height),
      maximized: parsed?.maximized === true
    };
  } catch {
    return {};
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizedWindowState(saved) {
  const primary = screen.getPrimaryDisplay();
  const requested = {
    x: saved.x ?? primary.workArea.x,
    y: saved.y ?? primary.workArea.y,
    width: Math.max(saved.width ?? DEFAULT_WINDOW_WIDTH, MIN_WINDOW_WIDTH),
    height: Math.max(saved.height ?? DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT)
  };

  const displays = screen.getAllDisplays();
  const intersectsDisplay = displays.some(({ workArea }) => {
    const overlapWidth = Math.max(
      0,
      Math.min(requested.x + requested.width, workArea.x + workArea.width) - Math.max(requested.x, workArea.x)
    );
    const overlapHeight = Math.max(
      0,
      Math.min(requested.y + requested.height, workArea.y + workArea.height) - Math.max(requested.y, workArea.y)
    );
    return overlapWidth >= 80 && overlapHeight >= 80;
  });

  const target = intersectsDisplay ? screen.getDisplayMatching(requested) : primary;
  const work = target.workArea;
  const width = Math.min(Math.max(requested.width, MIN_WINDOW_WIDTH), work.width);
  const height = Math.min(Math.max(requested.height, MIN_WINDOW_HEIGHT), work.height);
  const fallbackX = work.x + Math.round((work.width - width) / 2);
  const fallbackY = work.y + Math.round((work.height - height) / 2);
  const x = clamp(intersectsDisplay ? requested.x : fallbackX, work.x, work.x + work.width - width);
  const y = clamp(intersectsDisplay ? requested.y : fallbackY, work.y, work.y + work.height - height);

  return { x, y, width, height, maximized: saved.maximized === true };
}

function persistWindowState(window) {
  if (!window || window.isDestroyed()) return;
  const bounds = window.getNormalBounds();
  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: window.isMaximized()
  };
  const target = windowStatePath();
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Window state persistence is best-effort only.
    }
  }
}

function scheduleWindowStateSave(window) {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = undefined;
    persistWindowState(window);
  }, SAVE_BOUNDS_DEBOUNCE_MS);
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
    log('using existing control plane', url);
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
    stdio: app.isPackaged ? 'ignore' : 'inherit',
    windowsHide: true
  });
  backendChild = child;
  ownsBackend = true;
  log('starting control plane', { pid: child.pid, url });

  let exit;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
    log('control plane exited', exit);
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeLocalCoder(url)) {
      backendUrl = url;
      log('control plane ready', url);
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

function installRendererDiagnostics(window, url) {
  window.webContents.on('did-start-loading', () => log('renderer loading', url));
  window.webContents.on('did-finish-load', () => log('renderer loaded', window.webContents.getURL()));
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const detail = `${errorDescription} (${errorCode}) while loading ${validatedURL || url}`;
    console.error(`[Local Coder desktop] renderer load failed: ${detail}`);
    if (!window.isDestroyed()) {
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'Local Coder could not load',
        message: 'The desktop window could not load the Local Coder interface.',
        detail,
        buttons: ['OK'],
        noLink: true
      });
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Local Coder desktop] renderer process gone', details);
    if (!window.isDestroyed()) {
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'Local Coder renderer stopped',
        message: 'The desktop renderer exited unexpectedly.',
        detail: `Reason: ${details.reason}. Exit code: ${details.exitCode}.`,
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }).then(({ response }) => {
        if (response === 0 && !window.isDestroyed()) window.reload();
        else app.quit();
      });
    }
  });
  window.on('unresponsive', () => {
    console.error('[Local Coder desktop] window became unresponsive');
  });
  window.on('responsive', () => log('window responsive'));
}

function createMainWindow(url) {
  const restored = normalizedWindowState(readWindowState());
  const window = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1e1b' : '#f7f6f2',
    title: 'Local Coder',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });

  restrictRenderer(window, url);
  installRendererDiagnostics(window, url);
  window.on('resize', () => scheduleWindowStateSave(window));
  window.on('move', () => scheduleWindowStateSave(window));
  window.on('maximize', () => scheduleWindowStateSave(window));
  window.on('unmaximize', () => scheduleWindowStateSave(window));

  if (restored.maximized) window.maximize();
  window.show();
  window.focus();
  log('window created', window.getBounds());

  window.loadURL(url).catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[Local Coder desktop] loadURL rejected', message);
    if (!window.isDestroyed()) {
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'Local Coder could not load',
        message: 'The desktop window failed to load the Local Coder interface.',
        detail: message,
        buttons: ['Retry', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }).then(({ response }) => {
        if (response === 0 && !window.isDestroyed()) void window.loadURL(url);
        else app.quit();
      });
    }
  });
  return window;
}

async function startWithRecovery() {
  while (!quitting) {
    try {
      return await startControlPlane();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Local Coder desktop] control plane startup failed', message);
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

function configureSingleInstanceBehavior() {
  if (process.platform === 'darwin') {
    log('macOS startup: relying on Launch Services for normal app single-instance behavior');
    return true;
  }

  log('requesting explicit single-instance lock');
  const acquired = app.requestSingleInstanceLock();
  log('single-instance lock result', { acquired });
  if (!acquired) {
    log('another Local Coder desktop instance already owns the single-instance lock');
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    log('second instance requested; focusing existing window');
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  return true;
}

async function initializeDesktop() {
  app.setName('Local Coder');
  log('Electron ready', { packaged: app.isPackaged, version: process.versions.electron });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  if (!configureSingleInstanceBehavior()) return;

  const url = await startWithRecovery();
  if (!url) {
    app.quit();
    return;
  }

  backendUrl = url;
  mainWindow = createMainWindow(url);
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = undefined;
  }
  persistWindowState(mainWindow);
  void stopOwnedBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow && backendUrl) mainWindow = createMainWindow(backendUrl);
});

// Important: do not top-level await this promise. Electron can only progress to
// `will-finish-launching` / `ready` after the ESM main module has finished
// evaluating. This callback form mirrors the minimal Electron startup test.
void app.whenReady()
  .then(initializeDesktop)
  .catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[Local Coder desktop] fatal startup error', message);
    app.exit(1);
  });
