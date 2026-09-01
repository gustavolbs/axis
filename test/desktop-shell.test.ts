import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const desktopMain = fs.readFileSync('desktop/main.mjs', 'utf8');
const desktopPreload = fs.readFileSync('desktop/preload.mjs', 'utf8');
const desktopLauncher = fs.readFileSync('scripts/run-desktop.mjs', 'utf8');
const consoleHtml = fs.readFileSync('console/index.html', 'utf8');
const builder = fs.readFileSync('electron-builder.yml', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  main?: string;
  productName?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test('desktop launcher strips Node-mode variables before spawning Electron GUI', () => {
  assert.match(packageJson.scripts?.desktop ?? '', /node scripts\/run-desktop\.mjs/);
  assert.match(desktopLauncher, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(desktopLauncher, /delete env\.ELECTRON_NO_ATTACH_CONSOLE/);
  assert.match(desktopLauncher, /spawn\(electronPath, args/);
  assert.match(desktopLauncher, /stdio:\s*'inherit'/);
});

test('desktop uses the direct Electron main entry without an intermediate bootstrap', () => {
  assert.equal(packageJson.main, 'desktop/main.mjs');
  assert.equal(packageJson.productName, 'Local Coder');
  assert.equal(fs.existsSync('desktop/bootstrap.mjs'), false);
});

test('desktop main finishes ESM evaluation before waiting for Electron readiness', () => {
  assert.doesNotMatch(desktopMain, /await\s+app\.whenReady\(\)/);
  assert.match(desktopMain, /app\.whenReady\(\)\s*\n\s*\.then\(initializeDesktop\)/);
  assert.match(desktopMain, /async function initializeDesktop\(\)/);
  assert.match(desktopMain, /app\.once\('will-finish-launching'/);
  assert.match(desktopMain, /app\.once\('ready'/);
  assert.match(desktopMain, /main module loaded/);
});

test('explicit single-instance lock stays out of the macOS pre-ready path', () => {
  const initializeIndex = desktopMain.indexOf('async function initializeDesktop()');
  const lockIndex = desktopMain.indexOf('app.requestSingleInstanceLock()');
  const readinessChainIndex = desktopMain.indexOf('app.whenReady()');
  assert.ok(initializeIndex >= 0);
  assert.ok(lockIndex > initializeIndex);
  assert.ok(readinessChainIndex > lockIndex);
  assert.match(desktopMain, /if \(process\.platform !== 'darwin'\) \{[\s\S]*?app\.requestSingleInstanceLock\(\)/);
  assert.match(desktopMain, /macOS startup: relying on Launch Services/);
});

test('desktop renderer remains sandboxed behind a narrow preload bridge', () => {
  assert.match(desktopMain, /preload:\s*preloadScript\(\)/);
  assert.match(desktopMain, /nodeIntegration:\s*false/);
  assert.match(desktopMain, /contextIsolation:\s*true/);
  assert.match(desktopMain, /sandbox:\s*true/);
  assert.match(desktopMain, /webSecurity:\s*true/);
  assert.doesNotMatch(desktopMain, /nodeIntegration:\s*true/);
  assert.match(desktopPreload, /contextBridge\.exposeInMainWorld\('lc'/);
  assert.match(desktopPreload, /pickDirectory/);
  assert.match(desktopPreload, /setTheme/);
  assert.match(desktopPreload, /onCommand/);
});

test('desktop shell forces loopback, denies in-app external navigation and opens safe https links externally', () => {
  assert.match(desktopMain, /const HOST = '127\.0\.0\.1'/);
  assert.match(desktopMain, /setWindowOpenHandler/);
  assert.match(desktopMain, /will-navigate/);
  assert.match(desktopMain, /shell\.openExternal/);
  assert.match(desktopMain, /url\.protocol !== 'https:'/);
  assert.match(desktopMain, /setPermissionRequestHandler/);
  assert.match(desktopMain, /setPermissionCheckHandler/);
});

test('desktop shell uses the same compiled standalone control plane', () => {
  assert.match(desktopMain, /dist', 'standalone-console\.js'/);
  assert.match(desktopMain, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(desktopMain, /\/api\/jobs/);
});

test('desktop startup avoids white flash without returning to silent invisible startup', () => {
  assert.match(desktopMain, /show:\s*false/);
  assert.match(desktopMain, /backgroundColor:\s*'#1f1e1b'/);
  assert.match(desktopMain, /once\('ready-to-show'/);
  assert.match(desktopMain, /ready-to-show fallback fired/);
  assert.match(desktopMain, /did-fail-load/);
  assert.match(desktopMain, /render-process-gone/);
  assert.match(desktopMain, /unresponsive/);
  assert.match(desktopMain, /loadURL\(url\)\.catch/);
  assert.match(desktopMain, /stdio:\s*app\.isPackaged \? 'ignore' : 'inherit'/);
});

test('native bridge provides folder picker theme profile login settings and app menu shortcuts', () => {
  assert.match(desktopMain, /ipcMain\.handle\('local-coder:pick-directory'/);
  assert.match(desktopMain, /openDirectory/);
  assert.match(desktopMain, /ipcMain\.handle\('local-coder:set-theme'/);
  assert.match(desktopMain, /nativeTheme\.themeSource/);
  assert.match(desktopMain, /getLoginItemSettings/);
  assert.match(desktopMain, /setLoginItemSettings/);
  for (const accelerator of ['CommandOrControl+N', 'CommandOrControl+\\\\', 'CommandOrControl+,', 'CommandOrControl+1', 'CommandOrControl+2', 'CommandOrControl+3']) {
    assert.equal(desktopMain.includes(accelerator), true, `missing shortcut ${accelerator}`);
  }
});

test('standalone document has a restrictive CSP', () => {
  assert.match(consoleHtml, /Content-Security-Policy/);
  assert.match(consoleHtml, /default-src 'self'/);
  assert.match(consoleHtml, /script-src 'self'/);
  assert.match(consoleHtml, /connect-src 'self'/);
  assert.match(consoleHtml, /object-src 'none'/);
});

test('macOS package includes runtime UI/control-plane/preload sources plus production dependencies', () => {
  assert.equal(packageJson.main, 'desktop/main.mjs');
  assert.equal(packageJson.devDependencies?.electron, '44.1.0');
  assert.equal(packageJson.devDependencies?.['electron-builder'], '26.15.7');
  assert.match(packageJson.scripts?.['desktop:pack:mac'] ?? '', /electron-builder --mac dmg zip/);
  assert.match(builder, /appId: dev\.localcoder\.desktop/);
  assert.match(builder, /desktop\/\*\*\/\*/);
  assert.match(builder, /dist\/\*\*\/\*/);
  assert.match(builder, /console-dist\/\*\*\/\*/);
  assert.match(builder, /hardenedRuntime: true/);
});
