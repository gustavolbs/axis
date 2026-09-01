import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const desktopBootstrap = fs.readFileSync('desktop/bootstrap.mjs', 'utf8');
const desktopMain = fs.readFileSync('desktop/main.mjs', 'utf8');
const desktopLauncher = fs.readFileSync('scripts/run-desktop.mjs', 'utf8');
const consoleHtml = fs.readFileSync('console/index.html', 'utf8');
const builder = fs.readFileSync('electron-builder.yml', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  main?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test('desktop launcher strips Node-mode variables before spawning Electron GUI', () => {
  assert.match(packageJson.scripts?.desktop ?? '', /node scripts\/run-desktop\.mjs/);
  assert.match(desktopLauncher, /delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(desktopLauncher, /delete env\.ELECTRON_NO_ATTACH_CONSOLE/);
  assert.match(desktopLauncher, /spawn\(electronPath, \['\.'\]/);
  assert.match(desktopLauncher, /stdio:\s*'inherit'/);
});

test('desktop bootstrap establishes Local Coder identity before main import', () => {
  assert.equal(packageJson.main, 'desktop/bootstrap.mjs');
  assert.match(desktopBootstrap, /app\.setName\(APP_NAME\)/);
  assert.match(desktopBootstrap, /app\.setPath\('userData', userDataPath\)/);
  assert.match(desktopBootstrap, /bootstrap loaded/);
  assert.match(desktopBootstrap, /app ready event received/);
  assert.match(desktopBootstrap, /Electron did not emit app ready/);
  assert.match(desktopBootstrap, /await import\('\.\/main\.mjs'\)/);
});

test('desktop renderer is sandboxed and does not expose Node', () => {
  assert.match(desktopMain, /nodeIntegration:\s*false/);
  assert.match(desktopMain, /contextIsolation:\s*true/);
  assert.match(desktopMain, /sandbox:\s*true/);
  assert.match(desktopMain, /webSecurity:\s*true/);
  assert.doesNotMatch(desktopMain, /nodeIntegration:\s*true/);
});

test('desktop shell forces loopback and blocks navigation/window creation', () => {
  assert.match(desktopMain, /const HOST = '127\.0\.0\.1'/);
  assert.match(desktopMain, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(desktopMain, /will-navigate/);
  assert.match(desktopMain, /setPermissionRequestHandler/);
  assert.match(desktopMain, /setPermissionCheckHandler/);
});

test('desktop shell uses the same compiled standalone control plane', () => {
  assert.match(desktopMain, /dist', 'standalone-console\.js'/);
  assert.match(desktopMain, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(desktopMain, /\/api\/jobs/);
  assert.match(desktopMain, /requestSingleInstanceLock/);
});

test('desktop startup is immediately visible and diagnosable', () => {
  assert.match(desktopMain, /show:\s*true/);
  assert.doesNotMatch(desktopMain, /once\('ready-to-show'/);
  assert.match(desktopMain, /did-fail-load/);
  assert.match(desktopMain, /render-process-gone/);
  assert.match(desktopMain, /unresponsive/);
  assert.match(desktopMain, /loadURL\(url\)\.catch/);
  assert.match(desktopMain, /stdio:\s*app\.isPackaged \? 'ignore' : 'inherit'/);
});

test('standalone document has a restrictive CSP', () => {
  assert.match(consoleHtml, /Content-Security-Policy/);
  assert.match(consoleHtml, /default-src 'self'/);
  assert.match(consoleHtml, /script-src 'self'/);
  assert.match(consoleHtml, /connect-src 'self'/);
  assert.match(consoleHtml, /object-src 'none'/);
});

test('macOS package includes only runtime UI/control-plane sources plus production dependencies', () => {
  assert.equal(packageJson.main, 'desktop/bootstrap.mjs');
  assert.equal(packageJson.devDependencies?.electron, '44.1.0');
  assert.equal(packageJson.devDependencies?.['electron-builder'], '26.15.7');
  assert.match(packageJson.scripts?.['desktop:pack:mac'] ?? '', /electron-builder --mac dmg zip/);
  assert.match(builder, /appId: dev\.localcoder\.desktop/);
  assert.match(builder, /desktop\/\*\*\/\*/);
  assert.match(builder, /dist\/\*\*\/\*/);
  assert.match(builder, /console-dist\/\*\*\/\*/);
  assert.match(builder, /hardenedRuntime: true/);
});
