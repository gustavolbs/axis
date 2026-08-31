import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const shell = fs.readFileSync(path.join(root, 'console/src/claude-shell.css'), 'utf8');
const consoleRoot = fs.readFileSync(path.join(root, 'console/src/ConsoleRoot.tsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'console/src/main.tsx'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'desktop/main.mjs'), 'utf8');

test('desktop chrome exposes a real draggable titlebar with interactive no-drag controls', () => {
  assert.match(consoleRoot, /className="desktop-titlebar"/);
  assert.match(shell, /\.desktop-titlebar\s*\{[\s\S]*?-webkit-app-region:\s*drag;/);
  assert.match(shell, /\.surface-switcher,[\s\S]*?-webkit-app-region:\s*no-drag;/);
  assert.match(desktop, /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset'/);
  assert.match(desktop, /trafficLightPosition:\s*\{ x: 18, y: 18 \}/);
});

test('desktop restores window bounds safely across display changes', () => {
  for (const required of [
    'window-state.json',
    'screen.getAllDisplays()',
    'screen.getDisplayMatching(requested)',
    'screen.getPrimaryDisplay()',
    'window.getNormalBounds()',
    'window.isMaximized()',
    "window.on('resize'",
    "window.on('move'"
  ]) {
    assert.equal(desktop.includes(required), true, `missing desktop bounds behavior: ${required}`);
  }
  assert.match(desktop, /MIN_WINDOW_WIDTH = 760/);
  assert.match(desktop, /MIN_WINDOW_HEIGHT = 560/);
});

test('standalone shell uses internal viewport scrolling instead of fragile 100vh pages', () => {
  assert.match(shell, /height:\s*100dvh/);
  assert.match(shell, /\.surface-viewport\s*\{[\s\S]*?height:\s*calc\(100dvh - var\(--lc-titlebar-h\)\)/);
  assert.match(shell, /\.app-shell\s*\{[\s\S]*?height:\s*100%/);
  assert.match(shell, /\.main\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(shell, /\.sidebar\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('responsive layout covers desktop, compact desktop and narrow fallback widths', () => {
  assert.match(shell, /@media \(max-width: 1120px\)/);
  assert.match(shell, /@media \(max-width: 900px\)/);
  assert.match(shell, /@media \(max-width: 720px\)/);
  assert.match(shell, /@media \(max-height: 640px\)/);
  assert.match(shell, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(shell, /max-width:\s*100%/);
});

test('Claude-like visual overrides load after all legacy console styles', () => {
  const imports = main
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import './"));
  assert.equal(imports.at(-1), "import './claude-shell.css';");
  assert.match(shell, /--lc-accent:\s*#c86442/);
  assert.match(shell, /--lc-bg:\s*#f7f6f2/);
  assert.doesNotMatch(shell, /radial-gradient/);
});

test('accessibility preferences are preserved while motion is reduced when requested', () => {
  assert.match(shell, /@media \(prefers-color-scheme: dark\)/);
  assert.match(shell, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(desktop, /setZoomFactor\(/);
});
