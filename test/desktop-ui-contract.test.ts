import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const agent = fs.readFileSync(path.join(root, 'console/src/claude-agent.css'), 'utf8');
const fidelity = fs.readFileSync(path.join(root, 'console/src/claude-fidelity.css'), 'utf8');
const reference = fs.readFileSync(path.join(root, 'console/src/reference-fidelity.css'), 'utf8');
const overrides = fs.readFileSync(path.join(root, 'console/src/claude-reference-overrides.css'), 'utf8');
const agentSurface = fs.readFileSync(path.join(root, 'console/src/AgentSurface.tsx'), 'utf8');
const consoleRoot = fs.readFileSync(path.join(root, 'console/src/ConsoleRoot.tsx'), 'utf8');
const projectGallery = fs.readFileSync(path.join(root, 'console/src/ProjectGallery.tsx'), 'utf8');
const settingsModal = fs.readFileSync(path.join(root, 'console/src/SettingsModal.tsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'console/src/main.tsx'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'desktop/main.mjs'), 'utf8');

test('desktop chrome uses persistent resizable sidebar, product mark and native drag region', () => {
  for (const required of [
    'reference-app-shell',
    'reference-sidebar',
    'reference-sidebar-titlebar',
    'reference-product-mark',
    'reference-sidebar-resizer',
    'New chat',
    'Search',
    'Chats',
    'Projects',
    'Runs',
    'Settings'
  ]) assert.equal(consoleRoot.includes(required), true, `missing global shell primitive: ${required}`);
  assert.match(reference, /\.reference-sidebar-titlebar\s*\{[\s\S]*?-webkit-app-region:\s*drag;/);
  assert.match(overrides, /\.reference-sidebar-resizer/);
  assert.match(consoleRoot, /local-coder\.sidebar-width/);
  assert.match(desktop, /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset'/);
  assert.doesNotMatch(consoleRoot, /surface-switcher/);
});

test('global search uses Cmd-K and Recents are grouped by date with context menus', () => {
  assert.match(consoleRoot, /event\.key\.toLowerCase\(\) === 'k'/);
  assert.match(consoleRoot, /global-search/);
  assert.match(consoleRoot, /Search chats and projects/);
  for (const label of ['Today', 'Yesterday', 'Previous 7 days', 'Older']) assert.match(consoleRoot, new RegExp(label));
  assert.match(consoleRoot, /reference-row-menu-button/);
  assert.match(consoleRoot, /View run details/);
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

test('Agent content does not reserve a dead right rail and thread pane fills its grid', () => {
  assert.match(overrides, /\.reference-content-shell \.claude-agent-shell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(overrides, /\.claude-agent-shell:has\(> \.claude-progress-rail\)/);
  assert.match(overrides, /\.reference-content-shell \.claude-thread-pane\s*\{[\s\S]*?height:\s*100%[\s\S]*?min-height:\s*0/);
  assert.match(reference, /\.reference-content-shell \.claude-sidebar\s*\{[\s\S]*?display:\s*none !important/);
  assert.match(agent, /\.claude-thread\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('Agent surface remains thread-first with lightweight streaming state', () => {
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

test('composer uses popover context, attachment chips and Claude-like geometry', () => {
  assert.match(agentSurface, /composer-add-popover/);
  assert.match(agentSurface, /composer-context-chips/);
  assert.doesNotMatch(agentSurface, /className="composer-extras"/);
  assert.match(agentSurface, /placeholder="How can I help you today\?"/);
  assert.doesNotMatch(agentSurface, /composer-hint/);
  assert.match(overrides, /\.reference-content-shell \.claude-composer\s*\{[\s\S]*?border-radius:\s*24px/);
  assert.match(overrides, /\.reference-content-shell \.claude-prompt-input\s*\{[\s\S]*?font-size:\s*15px/);
  assert.match(overrides, /\.reference-content-shell \.claude-send-button,[\s\S]*?border-radius:\s*999px/);
  assert.match(overrides, /\.reference-content-shell \.claude-send-button\s*\{[\s\S]*?background:\s*var\(--ref-accent\)/);
});

test('composer popovers anchor outside the textarea and model menu is always interactive', () => {
  assert.match(overrides, /\.reference-content-shell \.composer-menu-anchor\s*\{[\s\S]*?position:\s*static/);
  assert.match(overrides, /\.reference-content-shell \.project-popover,[\s\S]*?bottom:\s*calc\(100% \+ 9px\)/);
  assert.doesNotMatch(agentSurface, /className="model-effort-trigger" disabled=/);
  assert.match(agentSurface, /model-menu-note/);
});

test('model menu exposes Auto, explicit provider groups, Effort and Thinking', () => {
  assert.match(agentSurface, /className="model-effort-trigger"/);
  assert.match(agentSurface, /<strong>Auto<\/strong>/);
  assert.match(agentSurface, /model-provider-group/);
  assert.match(agentSurface, /<strong>Effort<\/strong>/);
  assert.match(agentSurface, /<strong>Thinking<\/strong>/);
  for (const label of ['Low', 'Medium', 'High', 'Extra high', 'Max']) assert.match(agentSurface, new RegExp(`label: '${label}'`));
  assert.match(agentSurface, /reasoningEffort:\s*selectedProject \? \(thinkingEnabled \? effort : 'none'\)/);
  assert.match(fidelity, /\.claude-switch\.on/);
});

test('empty state has project context and quick actions instead of an oversized hero', () => {
  assert.match(agentSurface, /How can I help you today\?/);
  assert.match(agentSurface, /claude-quick-actions/);
  for (const label of ['Review this code', 'Fix a bug', 'Improve the tests', 'Explain this project']) assert.match(agentSurface, new RegExp(label));
  assert.match(overrides, /font-size:\s*clamp\(29px, 3vw, 32px\)/);
});

test('Projects search stays usable and sort/new-project controls are real', () => {
  for (const required of [
    'reference-projects-page',
    'reference-project-grid',
    'reference-project-card',
    'reference-project-modal',
    'New project',
    'Last updated',
    'Create a project',
    'Search projects'
  ]) assert.equal(projectGallery.includes(required), true, `missing Projects primitive: ${required}`);
  assert.match(overrides, /\.reference-project-search\s*\{[\s\S]*?width:\s*220px !important[\s\S]*?min-width:\s*220px/);
  assert.match(projectGallery, /SortMode/);
  assert.match(projectGallery, /reference-sort-menu/);
  assert.match(reference, /\.reference-project-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2/);
});

test('Settings is a modal with appearance, model routing and API key tabs', () => {
  assert.match(consoleRoot, /<SettingsModal/);
  for (const label of ['General', 'Appearance', 'Model routing', 'API keys']) assert.match(settingsModal, new RegExp(label));
  assert.match(settingsModal, /local-coder\.theme/);
  assert.match(overrides, /\.settings-modal\s*\{/);
  assert.match(overrides, /\.settings-view-routing \.credentials-section/);
  assert.match(overrides, /\.settings-view-credentials \.admin-toolbar/);
});

test('reference palette uses consolidated tokens and supports system/light/dark appearance', () => {
  const imports = main.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("import './"));
  assert.equal(imports.at(-1), "import './claude-reference-overrides.css';");
  assert.match(overrides, /--ref-bg:\s*#1f1e1b/);
  assert.match(overrides, /--ref-sidebar:\s*#191815/);
  assert.match(overrides, /--ref-accent:\s*#d97757/);
  assert.match(overrides, /html\[data-lc-theme='light'\]/);
  assert.match(overrides, /prefers-color-scheme:\s*light/);
  assert.match(main, /dataset\.lcTheme/);
});

test('labels avoid the mixed Portuguese-English primary UI', () => {
  for (const portuguese of ['Novo', 'Projetos', 'Execuções', 'Configurações', 'Procurar', 'Criar um projeto']) {
    assert.equal(consoleRoot.includes(portuguese) || projectGallery.includes(portuguese), false, `mixed-language label remains: ${portuguese}`);
  }
});

test('advanced settings restyle raw form controls and avoid all-caps emphasis', () => {
  assert.match(overrides, /\.settings-admin-view select,[\s\S]*?appearance:\s*none/);
  assert.match(overrides, /\.settings-admin-view \.eyebrow[\s\S]*?text-transform:\s*none !important/);
});

test('errors render as non-layout-shifting toast and auto dismiss', () => {
  assert.match(overrides, /\.reference-content-shell \.claude-error-banner\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(agentSurface, /setTimeout\(\(\) => setError\(undefined\), 8_000\)/);
});

test('accessibility preferences preserve focus and renderer zoom is not forced by the app', () => {
  assert.match(fidelity, /button:focus-visible/);
  assert.match(overrides, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(desktop, /setZoomFactor\(/);
});
