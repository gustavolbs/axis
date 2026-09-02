import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  shell
} from 'electron';

import { installClaudeAccountBridge } from './claude-accounts.mjs';

const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 840;
const MIN_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 560;
const WINDOW_STATE_FILE = 'window-state.json';
const SAVE_BOUNDS_DEBOUNCE_MS = 180;

let mainWindow;
let appRuntime;
let unsubscribeRuntime;
let quitting = false;
let saveBoundsTimer;

function log(message, detail) {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`[Axis desktop] ${message}${suffix}`);
}

log('main module loaded', {
  pid: process.pid,
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron
});
app.once('will-finish-launching', () => log('will-finish-launching'));
app.once('ready', () => log('ready event received'));

function preloadScript() {
  return path.join(app.getAppPath(), 'desktop', 'preload.cjs');
}

function rendererEntry() {
  return path.join(app.getAppPath(), 'app-dist', 'index.html');
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
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

function scheduleWindowStateSave(window) {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = undefined;
    persistWindowState(window);
  }, SAVE_BOUNDS_DEBOUNCE_MS);
}

function openExternalIfSafe(target) {
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:') return false;
    void shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
}

function restrictRenderer(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('file:')) return;
    event.preventDefault();
    openExternalIfSafe(target);
  });
}

function installRendererDiagnostics(window) {
  window.webContents.on('did-start-loading', () => log('renderer loading'));
  window.webContents.on('did-finish-load', () => log('renderer loaded', window.webContents.getURL()));
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const detail = `${errorDescription} (${errorCode}) while loading ${validatedURL || rendererEntry()}`;
    console.error(`[Axis desktop] renderer load failed: ${detail}`);
    if (!window.isDestroyed()) {
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'Axis could not load',
        message: 'The desktop window could not load the Axis interface.',
        detail,
        buttons: ['OK'],
        noLink: true
      });
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Axis desktop] renderer process gone', details);
    if (!window.isDestroyed()) {
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'Axis renderer stopped',
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
  window.on('unresponsive', () => console.error('[Axis desktop] window became unresponsive'));
  window.on('responsive', () => log('window responsive'));
}

function emitCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('local-coder:command', command);
}

function installApplicationMenu() {
  const appMenu = process.platform === 'darwin'
    ? [{
        label: 'Axis',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => emitCommand('settings') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      }]
    : [];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...appMenu,
    {
      label: 'File',
      submenu: [
        { label: 'New chat', accelerator: 'CommandOrControl+N', click: () => emitCommand('new-chat') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Required, not cosmetic: on macOS the clipboard and selection accelerators
    // (Cmd+A/C/V/X/Z) are delivered through these menu roles. A custom
    // application menu without an Edit menu disables all of them, with no error.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle sidebar', accelerator: 'CommandOrControl+\\', click: () => emitCommand('toggle-sidebar') },
        { type: 'separator' },
        { label: 'Projects', accelerator: 'CommandOrControl+1', click: () => emitCommand('projects') },
        { label: 'Runs', accelerator: 'CommandOrControl+2', click: () => emitCommand('runs') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]));
}

function installNativeBridge(runtime) {
  for (const channel of [
    'local-coder:runtime-request',
    'local-coder:pick-directory',
    'local-coder:copy-text',
    'local-coder:set-theme',
    'local-coder:get-profile',
    'local-coder:get-login-item-settings',
    'local-coder:set-open-at-login'
  ]) ipcMain.removeHandler(channel);

  ipcMain.handle('local-coder:runtime-request', async (_event, request) => await runtime.request(request));
  ipcMain.handle('local-coder:pick-directory', async (event, defaultPath) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = await dialog.showOpenDialog(owner, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath.trim() ? defaultPath : app.getPath('home'),
      buttonLabel: 'Use this folder'
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('local-coder:copy-text', (_event, text) => {
    if (typeof text !== 'string') throw new Error('copy text must be a string.');
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('local-coder:set-theme', (_event, source) => {
    const next = source === 'light' || source === 'dark' ? source : 'system';
    nativeTheme.themeSource = next;
    return nativeTheme.shouldUseDarkColors;
  });
  ipcMain.handle('local-coder:get-profile', () => ({
    userName: process.env.LOCAL_CODER_PROFILE_NAME?.trim() || os.userInfo().username,
    home: app.getPath('home')
  }));
  ipcMain.handle('local-coder:get-login-item-settings', () => ({
    openAtLogin: app.getLoginItemSettings().openAtLogin
  }));
  ipcMain.handle('local-coder:set-open-at-login', (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return { openAtLogin: app.getLoginItemSettings().openAtLogin };
  });

  unsubscribeRuntime?.();
  unsubscribeRuntime = runtime.subscribe((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('local-coder:runtime-event', event);
    }
  });

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('local-coder:theme-changed', nativeTheme.shouldUseDarkColors);
    }
  });
}

function createMainWindow() {
  const restored = normalizedWindowState(readWindowState());
  const window = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    backgroundColor: '#151515',
    title: 'Axis',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: preloadScript(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  });

  restrictRenderer(window);
  installRendererDiagnostics(window);
  window.on('resize', () => scheduleWindowStateSave(window));
  window.on('move', () => scheduleWindowStateSave(window));
  window.on('maximize', () => scheduleWindowStateSave(window));
  window.on('unmaximize', () => scheduleWindowStateSave(window));

  let shown = false;
  const showWindow = () => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    window.show();
    window.focus();
  };
  window.once('ready-to-show', showWindow);
  const visibleFallback = setTimeout(() => {
    log('ready-to-show fallback fired');
    showWindow();
  }, 1_500);
  window.once('closed', () => clearTimeout(visibleFallback));

  if (restored.maximized) window.maximize();
  log('window created', window.getBounds());

  window.loadFile(rendererEntry()).catch((error) => {
    showWindow();
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[Axis desktop] loadFile rejected', message);
    if (!window.isDestroyed()) {
      void dialog.showMessageBox(window, {
        type: 'error',
        title: 'Axis could not load',
        message: 'The desktop window failed to load the Axis interface.',
        detail: message,
        buttons: ['Retry', 'Quit'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }).then(({ response }) => {
        if (response === 0 && !window.isDestroyed()) void window.loadFile(rendererEntry());
        else app.quit();
      });
    }
  });
  return window;
}

async function createRuntime() {
  const runtimeModule = await import('../dist/app-runtime.js');
  return await runtimeModule.DesktopAppRuntime.create();
}

app.on('before-quit', () => {
  quitting = true;
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = undefined;
  }
  persistWindowState(mainWindow);
  unsubscribeRuntime?.();
  unsubscribeRuntime = undefined;
  void appRuntime?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow && appRuntime && !quitting) mainWindow = createMainWindow();
});

async function initializeDesktop() {
  app.setName('Axis');
  log('Electron ready', { packaged: app.isPackaged, version: process.versions.electron });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  installClaudeAccountBridge();

  if (process.platform !== 'darwin') {
    const hasSingleInstanceLock = app.requestSingleInstanceLock();
    if (!hasSingleInstanceLock) {
      app.quit();
      return;
    }
    app.on('second-instance', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }

  log('starting app runtime');
  appRuntime = await createRuntime();
  installNativeBridge(appRuntime);
  installApplicationMenu();
  log('app runtime ready');

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

app.whenReady()
  .then(initializeDesktop)
  .catch((error) => {
    console.error('[Axis desktop] fatal startup failure', error);
    app.exit(1);
  });
