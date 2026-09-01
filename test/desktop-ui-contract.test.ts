import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const shell = fs.readFileSync(path.join(root, 'console/src/claude-shell.css'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'console/src/claude-agent.css'), 'utf8');
const fidelity = fs.readFileSync(path.join(root, 'console/src/claude-fidelity.css'), 'utf8');
const agentSurface = fs.readFileSync(path.join(root, 'console/src/AgentSurface.tsx'), 'utf8');
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

test('standalone shell uses an internal desktop viewport rather than page-level scrolling', () => {
  assert.match(shell, /height:\s*100dvh/);
  assert.match(shell, /\.surface-viewport\s*\{[\s\S]*?height:\s*calc\(100dvh - var\(--lc-titlebar-h\)\)/);
  assert.match(agent, /\.claude-agent-shell\s*\{[\s\S]*?height:\s*100%/);
  assert.match(agent, /\.claude-thread\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(agent, /\.claude-session-list\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('Agent surface is thread-first with Claude-like message and composer hierarchy', () => {
  for (const required of [
    'claude-sidebar',
    'new-task-button',
    'claude-thread-pane',
    'thread-user-turn',
    'user-message',
    'thread-assistant-turn',
    'assistant-body',
    'claude-composer',
    'claude-prompt-input',
    'claude-send-button',
    'claude-stop-button',
    'claude-progress-rail'
  ]) {
    assert.equal(agentSurface.includes(required), true, `missing Claude-like Agent primitive: ${required}`);
  }
  assert.match(agentSurface, /'Working'/);
  assert.match(agentSurface, /'Thinking'/);
  assert.match(agentSurface, /'Writing'/);
  assert.doesNotMatch(agentSurface, /thinkingChars/);
});

test('model menu exposes Auto, explicit models, Effort and Thinking next to Send', () => {
  assert.match(agentSurface, /className="model-effort-trigger"/);
  assert.match(agentSurface, /<strong>Auto<\/strong>/);
  assert.match(agentSurface, /<strong>Effort<\/strong>/);
  assert.match(agentSurface, /<strong>Thinking<\/strong>/);
  assert.match(agentSurface, /label: 'Low'/);
  assert.match(agentSurface, /label: 'Medium'/);
  assert.match(agentSurface, /label: 'High'/);
  assert.match(agentSurface, /label: 'Extra high'/);
  assert.match(agentSurface, /label: 'Max'/);
  assert.match(agentSurface, /reasoningEffort:\s*selectedProject \? \(thinkingEnabled \? effort : 'none'\)/);
  assert.match(fidelity, /\.claude-switch\.on/);
});

test('new task state does not silently reopen the most recent task', () => {
  assert.match(agentSurface, /const NEW_TASK_ID = '__new__'/);
  assert.match(agentSurface, /activeId === NEW_TASK_ID[\s\S]*?\? undefined/);
  assert.match(agentSurface, /setActiveId\(NEW_TASK_ID\)/);
});

test('responsive layout covers progress rail collapse and narrow desktop fallback widths', () => {
  assert.match(agent, /@media \(max-width: 1180px\)/);
  assert.match(agent, /@media \(max-width: 980px\)/);
  assert.match(agent, /@media \(max-width: 760px\)/);
  assert.match(agent, /@media \(max-height: 640px\)/);
  assert.match(agent, /\.claude-progress-rail\s*\{[\s\S]*?display:\s*none/);
  assert.match(agent, /grid-template-columns:\s*1fr/);
  assert.match(fidelity, /max-width:\s*calc\(100vw - 20px\)/);
});

test('final Claude fidelity styles load after all legacy console styles', () => {
  const imports = main
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("import './"));
  assert.equal(imports.at(-1), "import './claude-fidelity.css';");
  assert.match(shell, /--lc-accent:\s*#c86442/);
  assert.match(shell, /--lc-bg:\s*#f7f6f2/);
  assert.doesNotMatch(agent, /radial-gradient/);
  assert.doesNotMatch(fidelity, /radial-gradient/);
});

test('accessibility preferences preserve focus while reducing optional motion', () => {
  assert.match(shell, /@media \(prefers-color-scheme: dark\)/);
  assert.match(agent, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(fidelity, /button:focus-visible/);
  assert.match(fidelity, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(desktop, /setZoomFactor\(/);
});
