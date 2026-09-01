import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const agent = fs.readFileSync(path.join(root, 'console/src/claude-agent.css'), 'utf8');
const fidelity = fs.readFileSync(path.join(root, 'console/src/claude-fidelity.css'), 'utf8');
const reference = fs.readFileSync(path.join(root, 'console/src/reference-fidelity.css'), 'utf8');
const agentSurface = fs.readFileSync(path.join(root, 'console/src/AgentSurface.tsx'), 'utf8');
const consoleRoot = fs.readFileSync(path.join(root, 'console/src/ConsoleRoot.tsx'), 'utf8');
const projectGallery = fs.readFileSync(path.join(root, 'console/src/ProjectGallery.tsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'console/src/main.tsx'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'desktop/main.mjs'), 'utf8');

test('desktop chrome uses a persistent Claude-like sidebar and native drag region', () => {
  for (const required of [
    'reference-app-shell',
    'reference-sidebar',
    'reference-sidebar-titlebar',
    'reference-primary-nav',
    'Conversas e tarefas',
    'Projetos',
    'Configurações'
  ]) assert.equal(consoleRoot.includes(required), true, `missing global shell primitive: ${required}`);
  assert.match(reference, /\.reference-sidebar-titlebar\s*\{[\s\S]*?-webkit-app-region:\s*drag;/);
  assert.match(reference, /reference-sidebar button,[\s\S]*?-webkit-app-region:\s*no-drag/);
  assert.match(desktop, /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset'/);
  assert.match(desktop, /trafficLightPosition:\s*\{ x: 18, y: 18 \}/);
  assert.doesNotMatch(consoleRoot, /surface-switcher/);
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
  ]) assert.equal(desktop.includes(required), true, `missing desktop bounds behavior: ${required}`);
  assert.match(desktop, /MIN_WINDOW_WIDTH = 760/);
  assert.match(desktop, /MIN_WINDOW_HEIGHT = 560/);
});

test('standalone shell keeps scrolling internal and removes duplicate Agent sidebar', () => {
  assert.match(reference, /height:\s*100dvh/);
  assert.match(reference, /\.reference-sidebar-scroll\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(reference, /\.reference-content-shell \.claude-sidebar\s*\{[\s\S]*?display:\s*none !important/);
  assert.match(agent, /\.claude-thread\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('Agent surface remains thread-first with Claude-like message and composer hierarchy', () => {
  for (const required of [
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
  ]) assert.equal(agentSurface.includes(required), true, `missing Agent primitive: ${required}`);
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
  for (const label of ['Low', 'Medium', 'High', 'Extra high', 'Max']) assert.match(agentSurface, new RegExp(`label: '${label}'`));
  assert.match(agentSurface, /reasoningEffort:\s*selectedProject \? \(thinkingEnabled \? effort : 'none'\)/);
  assert.match(fidelity, /\.claude-switch\.on/);
});

test('Projects surface mirrors the familiar card grid and modal interaction', () => {
  for (const required of [
    'reference-projects-page',
    'reference-project-grid',
    'reference-project-card',
    'reference-project-modal',
    'Novo projeto',
    'Última atualização',
    'Criar um projeto'
  ]) assert.equal(projectGallery.includes(required), true, `missing Projects primitive: ${required}`);
  assert.match(reference, /\.reference-project-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2/);
  assert.match(reference, /\.reference-modal-backdrop/);
});

test('reference palette and composer geometry load after legacy styles', () => {
  const imports = main.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("import './"));
  assert.equal(imports.at(-1), "import './reference-fidelity.css';");
  assert.match(reference, /--ref-bg:\s*#171716/);
  assert.match(reference, /--ref-sidebar:\s*#111110/);
  assert.match(reference, /--ref-accent:\s*#d97757/);
  assert.match(reference, /\.reference-content-shell \.claude-composer\s*\{[\s\S]*?border-radius:\s*15px/);
  assert.doesNotMatch(reference, /radial-gradient/);
});

test('responsive layout covers progress collapse and narrow desktop widths', () => {
  assert.match(reference, /@media \(max-width: 1120px\)/);
  assert.match(reference, /@media \(max-width: 820px\)/);
  assert.match(reference, /sidebar-collapsed/);
  assert.match(reference, /grid-template-columns:\s*1fr/);
});

test('accessibility preferences preserve focus and renderer zoom is not forced by the app', () => {
  assert.match(fidelity, /button:focus-visible/);
  assert.match(fidelity, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(desktop, /setZoomFactor\(/);
});
