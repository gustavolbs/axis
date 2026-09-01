import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const agent = fs.readFileSync(path.join(root, 'console/src/claude-agent.css'), 'utf8');
const fidelity = fs.readFileSync(path.join(root, 'console/src/claude-fidelity.css'), 'utf8');
const reference = fs.readFileSync(path.join(root, 'console/src/reference-fidelity.css'), 'utf8');
const overrides = fs.readFileSync(path.join(root, 'console/src/claude-reference-overrides.css'), 'utf8');
const audit = fs.readFileSync(path.join(root, 'console/src/audit-v2.css'), 'utf8');
const auditComponents = fs.readFileSync(path.join(root, 'console/src/audit-v2-components.css'), 'utf8');
const agentSurface = fs.readFileSync(path.join(root, 'console/src/AgentSurfaceV2.tsx'), 'utf8');
const consoleRoot = fs.readFileSync(path.join(root, 'console/src/ConsoleRoot.tsx'), 'utf8');
const projectGallery = fs.readFileSync(path.join(root, 'console/src/ProjectGallery.tsx'), 'utf8');
const folderField = fs.readFileSync(path.join(root, 'console/src/FolderField.tsx'), 'utf8');
const settingsModal = fs.readFileSync(path.join(root, 'console/src/SettingsModal.tsx'), 'utf8');
const settingsPanels = fs.readFileSync(path.join(root, 'console/src/SettingsPanels.tsx'), 'utf8');
const uiSelect = fs.readFileSync(path.join(root, 'console/src/UiSelect.tsx'), 'utf8');
const uiSelectCss = fs.readFileSync(path.join(root, 'console/src/ui-select.css'), 'utf8');
const runInspector = fs.readFileSync(path.join(root, 'console/src/RunInspectorV2.tsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'console/src/main.tsx'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'desktop/main.mjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'desktop/preload.mjs'), 'utf8');

test('desktop chrome uses persistent responsive sidebar and safe native drag regions', () => {
  for (const required of ['reference-app-shell', 'reference-sidebar', 'reference-sidebar-titlebar', 'reference-sidebar-resizer', 'New chat', 'Search', 'Chats', 'Projects', 'Runs', 'Settings']) {
    assert.equal(consoleRoot.includes(required), true, `missing global shell primitive: ${required}`);
  }
  assert.match(consoleRoot, /data-shell=/);
  assert.match(consoleRoot, /data-platform=/);
  assert.match(consoleRoot, /local-coder\.sidebar-width/);
  assert.match(consoleRoot, /autoCollapsed/);
  assert.match(consoleRoot, /window\.innerWidth < 900/);
  assert.match(audit, /-webkit-app-region:\s*drag/);
  assert.match(audit, /-webkit-app-region:\s*no-drag/);
  assert.match(audit, /overflow-x:\s*clip/);
  assert.match(audit, /margin-top:\s*auto/);
  assert.match(audit, /data-platform='darwin'/);
  assert.match(desktop, /trafficLightPosition/);
});

test('collapsed rail has accessible names, delayed tooltips and persistent profile footer', () => {
  for (const label of ['New chat', 'Search', 'Chats', 'Projects', 'Runs', 'Settings']) {
    assert.match(consoleRoot, new RegExp(`aria-label=\\"${label}\\"`));
  }
  assert.match(consoleRoot, /data-tooltip=/);
  assert.match(audit, /transition:\s*opacity 120ms ease 400ms/);
  assert.match(consoleRoot, /reference-account-avatar/);
  assert.match(audit, /sidebar-collapsed \.reference-account-avatar/);
});

test('global and native shortcuts cover core Claude-like navigation', () => {
  for (const token of ["key === 'k'", "key === 'n'", "key === '\\\\'", "key === ','", "key === '1'", "key === '2'", "key === '3'"]) assert.match(consoleRoot, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const accelerator of ['CommandOrControl+N', 'CommandOrControl+\\\\', 'CommandOrControl+,', 'CommandOrControl+1', 'CommandOrControl+2', 'CommandOrControl+3']) assert.equal(desktop.includes(accelerator), true, `missing native shortcut: ${accelerator}`);
  assert.match(preload, /local-coder:command/);
});

test('desktop restores window bounds and avoids white boot flash', () => {
  for (const required of ['window-state.json', 'screen.getAllDisplays()', 'screen.getDisplayMatching(requested)', 'screen.getPrimaryDisplay()', 'window.getNormalBounds()', 'window.isMaximized()']) assert.equal(desktop.includes(required), true, `missing desktop bounds behavior: ${required}`);
  assert.match(desktop, /MIN_WINDOW_WIDTH = 760/);
  assert.match(desktop, /MIN_WINDOW_HEIGHT = 560/);
  assert.match(desktop, /backgroundColor:\s*'#1f1e1b'/);
  assert.match(desktop, /show:\s*false/);
  assert.match(desktop, /once\('ready-to-show'/);
  assert.match(desktop, /ready-to-show fallback fired/);
});

test('native bridge exposes only narrow folder theme profile login and command capabilities', () => {
  assert.match(desktop, /ipcMain\.handle\('local-coder:pick-directory'/);
  assert.match(desktop, /properties:\s*\['openDirectory', 'createDirectory'\]/);
  assert.match(desktop, /ipcMain\.handle\('local-coder:set-theme'/);
  assert.match(desktop, /nativeTheme\.themeSource/);
  assert.match(desktop, /ipcMain\.handle\('local-coder:get-profile'/);
  assert.match(desktop, /setLoginItemSettings/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('lc'/);
  assert.doesNotMatch(preload, /nodeIntegration/);
});

test('external https links are delegated to the system browser and renderer remains sandboxed', () => {
  assert.match(desktop, /shell\.openExternal/);
  assert.match(desktop, /url\.protocol !== 'https:'/);
  assert.match(desktop, /nodeIntegration:\s*false/);
  assert.match(desktop, /contextIsolation:\s*true/);
  assert.match(desktop, /sandbox:\s*true/);
  assert.match(desktop, /preload:\s*preloadScript\(\)/);
});

test('Agent v2 remains thread-first with lightweight streaming state', () => {
  for (const required of ['claude-thread-pane', 'thread-user-turn', 'user-message', 'thread-assistant-turn', 'assistant-body', 'claude-composer', 'claude-prompt-input', 'claude-send-button', 'claude-stop-button', 'claude-progress-rail']) {
    assert.equal(agentSurface.includes(required), true, `missing Agent primitive: ${required}`);
  }
  for (const state of ['Working', 'Thinking', 'Writing']) assert.match(agentSurface, new RegExp(state));
  assert.doesNotMatch(agentSurface, /thinkingChars/);
});

test('send affordance is text-driven and missing workspace opens context instead of silently disabling', () => {
  assert.match(agentSurface, /canSubmit=\{Boolean\(goal\.trim\(\)\)\}/);
  assert.match(agentSurface, /if \(!goal\.trim\(\)\) return/);
  assert.match(agentSurface, /if \(!effectiveWorkspace\)/);
  assert.match(agentSurface, /setProjectMenu\(true\)/);
  assert.match(agentSurface, /setExtrasOpen\(true\)/);
});

test('composer autogrows, uses outer focus ring and keeps bounded popovers', () => {
  assert.match(agentSurface, /useRef<HTMLTextAreaElement>/);
  assert.match(agentSurface, /element\.style\.height = 'auto'/);
  assert.match(agentSurface, /Math\.min\(element\.scrollHeight/);
  assert.match(agentSurface, /rows=\{1\}/);
  assert.match(audit, /\.claude-prompt-input:focus[\s\S]*?outline:\s*none/);
  assert.match(audit, /\.claude-composer:focus-within/);
  assert.match(audit, /max-height:\s*min\(360px/);
  assert.match(audit, /\.project-popover,[\s\S]*?left:\s*0/);
});

test('workspace entry has native Browse and browser recent-folder fallback', () => {
  assert.match(projectGallery, /<FolderField/);
  assert.match(agentSurface, /<FolderField/);
  assert.match(folderField, /window\.lc\?\.pickDirectory/);
  assert.match(folderField, /<datalist/);
  assert.match(folderField, /local-coder\.recent-workspaces/);
  assert.match(folderField, /Folder not found/);
});

test('model menu exposes real provider groups plus Effort and Thinking', () => {
  assert.match(agentSurface, /className="model-effort-trigger"/);
  assert.match(agentSurface, /model-provider-group/);
  assert.match(agentSurface, /<strong>Auto<\/strong>/);
  assert.match(agentSurface, /<strong>Effort<\/strong>/);
  assert.match(agentSurface, /<strong>Thinking<\/strong>/);
  for (const label of ['Low', 'Medium', 'High', 'Extra high', 'Max']) assert.match(agentSurface, new RegExp(`label: '${label}'`));
  assert.match(agentSurface, /reasoningEffort:\s*selectedProject \? \(thinkingEnabled \? effort : 'none'\)/);
  assert.match(fidelity, /\.claude-switch\.on/);
});

test('empty state is personalized and quick actions remain available', () => {
  assert.match(agentSurface, /function greeting/);
  assert.match(agentSurface, /getProfile\(\)/);
  assert.match(agentSurface, /claude-quick-actions/);
  for (const label of ['Review this code', 'Fix a bug', 'Improve the tests', 'Explain this project']) assert.match(agentSurface, new RegExp(label));
  assert.match(audit, /justify-content:\s*center/);
  assert.match(audit, /padding-top:\s*var\(--lc-titlebar-h\)/);
});

test('Projects uses real folder picker and consistent primary-secondary hierarchy', () => {
  for (const required of ['reference-projects-page', 'reference-project-grid', 'reference-project-card', 'reference-project-modal', 'New project', 'Last updated', 'Create a project', 'Search projects']) assert.equal(projectGallery.includes(required), true, `missing Projects primitive: ${required}`);
  assert.match(projectGallery, /<Info size=\{14\}/);
  assert.match(projectGallery, /btn-secondary/);
  assert.match(projectGallery, /btn-primary/);
  assert.match(audit, /\.btn-primary/);
  assert.match(audit, /\.btn-secondary/);
});

test('Settings has only real General Appearance Model routing and API keys tabs', () => {
  for (const label of ['General', 'Appearance', 'Model routing', 'API keys']) assert.match(settingsModal, new RegExp(label));
  assert.doesNotMatch(settingsModal, /Advanced/);
  assert.doesNotMatch(settingsModal, /<AdminPanel/);
  assert.match(settingsModal, /Default workspace/);
  assert.match(settingsModal, /Start on login/);
  assert.match(settingsModal, /<ModelRoutingSettings/);
  assert.match(settingsModal, /<ApiKeySettings/);
  assert.match(settingsPanels, /<UiSelect/);
  assert.doesNotMatch(settingsPanels, /<select/);
  assert.match(uiSelect, /role="listbox"/);
  assert.match(uiSelectCss, /\.ui-select-popover/);
});

test('appearance syncs with Electron nativeTheme and System preview is a clean split', () => {
  assert.match(settingsModal, /window\.lc\?\.setTheme/);
  assert.match(desktop, /nativeTheme\.on\('updated'/);
  assert.match(preload, /local-coder:theme-changed/);
  assert.match(audit, /\.theme-preview\.theme-system::after/);
  assert.match(audit, /clip-path:\s*polygon/);
});

test('Runs is an operational table rather than asymmetric admin cards', () => {
  assert.match(runInspector, /<table className="runs-table">/);
  for (const column of ['When', 'Project / task', 'Provider / model', 'Tokens', 'Cost', 'Latency', 'Status']) assert.match(runInspector, new RegExp(column.replace('/', '\\/')));
  assert.match(runInspector, /runs-detail/);
  assert.doesNotMatch(runInspector, /PROJECT EXECUTION/);
  assert.doesNotMatch(runInspector, /font-weight:\s*580/);
  assert.match(auditComponents, /\.runs-table/);
});

test('hover active focus typography and scrollbar states stay distinct and consistent', () => {
  assert.match(audit, /button:hover[\s\S]*?surface-2/);
  assert.match(audit, /button\.active[\s\S]*?surface-3/);
  assert.match(audit, /outline:\s*2px solid var\(--lc-accent\)/);
  assert.match(audit, /font-size:\s*30px/);
  assert.match(audit, /text-transform:\s*none/);
  assert.match(audit, /scrollbar-color/);
});

test('errors auto-dismiss and expose Retry plus Settings actions while infra status persists in sidebar', () => {
  assert.match(agentSurface, /setTimeout\(\(\) => setError\(undefined\), 8_000\)/);
  assert.match(agentSurface, />Retry<\/button>/);
  assert.match(agentSurface, />Settings<\/button>/);
  assert.match(consoleRoot, /reference-runtime-status/);
});

test('final stylesheet ordering keeps audit fixes last and renderer zoom is not forced', () => {
  const imports = main.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("import './"));
  assert.equal(imports.at(-1), "import './audit-v2-components.css';");
  assert.match(main, /dataset\.lcTheme/);
  assert.doesNotMatch(desktop, /setZoomFactor\(/);
  assert.match(agent, /\.claude-thread\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(reference, /\.reference-content-shell \.claude-sidebar\s*\{[\s\S]*?display:\s*none !important/);
  assert.match(overrides, /--ref-bg:\s*#1f1e1b/);
});
