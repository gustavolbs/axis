import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const desktopMain = fs.readFileSync('desktop/main.mjs', 'utf8');
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
  assert.match(desktopLauncher, /const forwarded = process\.argv\.slice\(2\)/);
  assert.match(desktopLauncher, /const args = forwarded\.length > 0 \? forwarded : \['\.'\]/);
  assert.match(desktopLauncher, /entry:/);
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
  assert.match(desktopMain, /void app\.whenReady\(\)\s*\n\s*\.then\(initializeDesktop\)/);
  assert.match(desktopMain, /app\.once\('will-finish-launching'/);
  assert.match(desktopMain, /app\.once\('ready'/);
  assert.match(desktopMain, /main module loaded/);
});

test('explicit single-instance lock is kept out of the macOS pre-ready path', () => {
  assert.match(desktopMain, /function configureSingleInstanceBehavior\(\)/);
  assert.match(desktopMain, /if \(process\.platform === 'darwin'\) \{[\s\S]*?return true;/);
  assert.match(desktopMain, /app\.requestSingleInstanceLock\(\)/);
  assert.match(desktopMain, /macOS startup: relying on Launch Services/);
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
