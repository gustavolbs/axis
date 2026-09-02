import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const desktopBootstrap = fs.readFileSync('desktop/bootstrap.mjs', 'utf8');
const desktopMain = fs.readFileSync('desktop/main.mjs', 'utf8');
const desktopPreload = fs.readFileSync('desktop/preload.cjs', 'utf8');
const desktopLauncher = fs.readFileSync('scripts/run-desktop.mjs', 'utf8');
const appHtml = fs.readFileSync('app/index.html', 'utf8');
const appRuntime = fs.readFileSync('src/app-runtime.ts', 'utf8');
const builder = fs.readFileSync('electron-builder.yml', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  main?: string;
  productName?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test('desktop launcher strips Node-mode variables before spawning Electron GUI', () => {
  assert.match(packageJson.scripts?.desktop ?? '', /node scripts\/run-desktop\.mjs/);
  assert.match(desktopLauncher, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(desktopLauncher, /delete env\.ELECTRON_NO_ATTACH_CONSOLE/);
  assert.match(desktopLauncher, /spawn\(electronPath, args/);
  assert.match(desktopLauncher, /stdio:\s*'inherit'/);
});

test('desktop uses a narrow macOS updater bootstrap before the existing main process', () => {
  assert.equal(packageJson.main, 'desktop/bootstrap.mjs');
  assert.equal(packageJson.productName, 'Axis');
  assert.equal(packageJson.dependencies?.['update-electron-app'], '^3.3.0');
  assert.match(desktopBootstrap, /from 'update-electron-app'/);
  assert.match(desktopBootstrap, /process\.platform === 'darwin'/);
  assert.match(desktopBootstrap, /repo:\s*'gustavolbs\/local-coder-mcp'/);
  assert.match(desktopBootstrap, /updateInterval:\s*'30 minutes'/);
  assert.match(desktopBootstrap, /await import\('\.\/main\.mjs'\)/);
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
});

test('desktop renderer remains sandboxed behind a narrow preload bridge', () => {
  assert.match(desktopMain, /preload:\s*preloadScript\(\)/);
  assert.match(desktopMain, /nodeIntegration:\s*false/);
  assert.match(desktopMain, /contextIsolation:\s*true/);
  assert.match(desktopMain, /sandbox:\s*true/);
  assert.match(desktopMain, /webSecurity:\s*true/);
  assert.doesNotMatch(desktopMain, /nodeIntegration:\s*true/);
  assert.match(desktopPreload, /contextBridge\.exposeInMainWorld\('lc'/);
  assert.match(desktopPreload, /request:\s*\(request\) => ipcRenderer\.invoke\('local-coder:runtime-request'/);
  assert.match(desktopPreload, /pickDirectory/);
  assert.match(desktopPreload, /setTheme/);
  assert.match(desktopPreload, /onCommand/);
});

test('standalone app talks to the in-process runtime instead of a localhost control server', () => {
  assert.match(desktopMain, /import\('\.\.\/dist\/app-runtime\.js'\)/);
  assert.match(desktopMain, /DesktopAppRuntime\.create\(\)/);
  assert.match(desktopMain, /ipcMain\.handle\('local-coder:runtime-request'/);
  assert.match(appRuntime, /export class DesktopAppRuntime/);
  assert.match(appRuntime, /async request\(request: AppRuntimeRequest\)/);
  assert.doesNotMatch(desktopMain, /standalone-console/);
  assert.doesNotMatch(desktopMain, /child_process|spawn\(/);
  assert.equal(fs.existsSync('src/project-admin-http.ts'), false);
  assert.equal(fs.existsSync('src/control-plane-config.ts'), false);
});

test('desktop denies in-app external navigation and opens safe https links externally', () => {
  assert.match(desktopMain, /setWindowOpenHandler/);
  assert.match(desktopMain, /will-navigate/);
  assert.match(desktopMain, /shell\.openExternal/);
  assert.match(desktopMain, /url\.protocol !== 'https:'/);
  assert.match(desktopMain, /setPermissionRequestHandler/);
  assert.match(desktopMain, /setPermissionCheckHandler/);
});

test('desktop startup avoids white flash without returning to silent invisible startup', () => {
  assert.match(desktopMain, /show:\s*false/);
  assert.match(desktopMain, /backgroundColor:\s*'#151515'/);
  assert.match(desktopMain, /once\('ready-to-show'/);
  assert.match(desktopMain, /ready-to-show fallback fired/);
  assert.match(desktopMain, /did-fail-load/);
  assert.match(desktopMain, /render-process-gone/);
  assert.match(desktopMain, /unresponsive/);
  assert.match(desktopMain, /loadFile\(rendererEntry\(\)\)\.catch/);
});

test('native bridge provides folder picker theme profile login settings and app menu shortcuts', () => {
  assert.match(desktopMain, /ipcMain\.handle\('local-coder:pick-directory'/);
  assert.match(desktopMain, /openDirectory/);
  assert.match(desktopMain, /ipcMain\.handle\('local-coder:set-theme'/);
  assert.match(desktopMain, /nativeTheme\.themeSource/);
  assert.match(desktopMain, /getLoginItemSettings/);
  assert.match(desktopMain, /setLoginItemSettings/);
  // ⌘1 Projects, ⌘2 Runs. There is no third surface: conversations live in the
  // sidebar tree, not on a Chats screen.
  for (const accelerator of ['CommandOrControl+N', 'CommandOrControl+\\\\', 'CommandOrControl+,', 'CommandOrControl+1', 'CommandOrControl+2']) {
    assert.equal(desktopMain.includes(accelerator), true, `missing shortcut ${accelerator}`);
  }
  assert.equal(desktopMain.includes('CommandOrControl+3'), false);
});

test('standalone document has a restrictive CSP', () => {
  assert.match(appHtml, /Content-Security-Policy/);
  assert.match(appHtml, /default-src 'self'/);
  assert.match(appHtml, /script-src 'self'/);
  assert.match(appHtml, /connect-src 'self'/);
  assert.match(appHtml, /object-src 'none'/);
});

test('macOS package includes updater bootstrap runtime app preload and production assets only', () => {
  assert.equal(packageJson.main, 'desktop/bootstrap.mjs');
  assert.equal(packageJson.devDependencies?.electron, '44.1.0');
  assert.equal(packageJson.devDependencies?.['electron-builder'], '26.15.7');
  assert.match(packageJson.scripts?.['desktop:pack:mac'] ?? '', /electron-builder --mac dmg zip/);
  assert.match(builder, /appId: dev\.axis\.desktop/);
  assert.match(builder, /icon: build\/icon\.png/);
  assert.match(builder, /desktop\/\*\*\/\*/);
  assert.match(builder, /dist\/\*\*\/\*/);
  assert.match(builder, /app-dist\/\*\*\/\*/);
  assert.doesNotMatch(builder, /console-dist/);
  assert.match(builder, /hardenedRuntime: true/);
});