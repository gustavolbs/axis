import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

/**
 * Comments describe the defects these rules fix, and quote the broken CSS to do
 * it. Structural assertions must not read that prose as code.
 */
const stripCssComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const stripHtmlComments = (source: string) => source.replace(/<!--[\s\S]*?-->/g, '');

/**
 * Every declaration the layer applies to exactly `selector`, concatenated in
 * source order — the same set the cascade resolves. Selectors must match as a
 * whole comma entry: a substring test would also pick up
 * `.sidebar-collapsed .lc-shell-primary-nav button`, which is a different rule.
 */
function declarationsFor(source: string, selector: string): string {
  const bodies: string[] = [];
  for (const [, head, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const parts = head.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.includes(selector)) bodies.push(body);
  }
  return bodies.join('\n');
}

/**
 * The renderer ships exactly three stylesheets and the import order is the
 * cascade: tokens/base, components, corrections. Adding a fourth is how this
 * codebase previously accumulated fourteen of them, 416 `!important`
 * declarations and four competing definitions of `:root`.
 */
const STYLESHEETS = ['app/src/lc-base.css', 'app/src/lc-app.css', 'app/src/lc-fixes.css'] as const;

const baseCss = stripCssComments(read(STYLESHEETS[0]));
const appCss = stripCssComments(read(STYLESHEETS[1]));
const fixesCss = stripCssComments(read(STYLESHEETS[2]));
/** Presence assertions run against the whole cascade, not one layer. */
const css = [baseCss, appCss, fixesCss].join('\n');

const agentSurface = read('app/src/AgentSurfaceV2.tsx');
const appRoot = read('app/src/AppRoot.tsx');
const projectGallery = read('app/src/ProjectGallery.tsx');
const projectDetail = read('app/src/ProjectDetail.tsx');
const folderField = read('app/src/FolderField.tsx');
const settingsModal = read('app/src/SettingsModal.tsx');
const settingsPanels = read('app/src/SettingsPanels.tsx');
const usageSettings = read('app/src/UsageSettings.tsx');
const uiSelect = read('app/src/UiSelect.tsx');
const runInspector = read('app/src/RunInspectorV2.tsx');
const native = read('app/src/native.ts');
const main = read('app/src/main.tsx');
const indexHtml = stripHtmlComments(read('app/index.html'));
const desktop = read('desktop/main.mjs');
const preload = read('desktop/preload.cjs');

test('renderer ships three stylesheets in cascade order and nothing else', () => {
  const imports = main.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^import '\.\/.*\.css';$/.test(line));
  assert.deepEqual(imports, [
    "import './lc-base.css';",
    "import './lc-app.css';",
    "import './lc-fixes.css';"
  ]);

  const present = fs.readdirSync(path.join(root, 'app/src')).filter((file) => file.endsWith('.css')).sort();
  assert.deepEqual(present, ['lc-app.css', 'lc-base.css', 'lc-fixes.css']);
});

test('only lc-base.css defines tokens, :root and document-level elements', () => {
  for (const [name, source] of [['lc-app.css', appCss], ['lc-fixes.css', fixesCss]] as const) {
    assert.doesNotMatch(source, /^\s*:root\s*[,{]/m, `${name} must not declare :root`);
    assert.doesNotMatch(source, /^\s*(html|body|#root)\s*[,{]/m, `${name} must not declare html/body/#root`);
    assert.doesNotMatch(source, /^\s*--lc-[a-z0-9-]+\s*:/m, `${name} must not define design tokens`);
  }
  // The four surfaces are specified values, not derived ones.
  assert.match(baseCss, /--lc-bg:\s*#151515/, 'chat canvas');
  assert.match(baseCss, /--lc-sidebar:\s*#111111/, 'sidebar');
  assert.match(baseCss, /--lc-surface:\s*#20201f/, 'composer and decision picker');
  // The picker shares the composer surface rather than carrying a second token.
  assert.match(fixesCss, /\.decision-picker\s*\{[^}]*background:\s*var\(--lc-surface\)/);
  assert.match(baseCss, /html\[data-lc-theme='light'\]/);
  assert.match(baseCss, /@media \(prefers-color-scheme: light\)/);
  assert.match(main, /dataset\.lcTheme/);
});

test('the --ref-* token namespace is gone and every token used is defined', () => {
  assert.doesNotMatch(css, /--ref-/, 'the parallel --ref-* palette must not come back');
  assert.doesNotMatch(appRoot, /--ref-/);

  const used = new Set([...css.matchAll(/var\((--lc-[a-z0-9-]+)/g)].map((match) => match[1]));
  const defined = new Set([...baseCss.matchAll(/^\s*(--lc-[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));
  const missing = [...used].filter((token) => !defined.has(token)).sort();
  assert.deepEqual(missing, [], `undefined tokens: ${missing.join(', ')}`);

  const unused = [...defined].filter((token) => !used.has(token) && token !== '--lc-sidebar-width').sort();
  assert.deepEqual(unused, [], `unused tokens: ${unused.join(', ')}`);
});

test('[hidden] survives author display rules', () => {
  // An author `display` declaration beats the UA stylesheet's `[hidden]` rule at
  // any specificity, so `.new-task-button { display: flex }` used to render a
  // `<button hidden>` as a full-width band across the top of the thread pane.
  assert.match(baseCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.doesNotMatch(agentSurface, /agent-new-task-proxy/, 'the hidden proxy button must stay deleted');
});

test('collapsed rail width comes from one token, never a hardcoded pixel pair', () => {
  // The rail was drawn at a hardcoded 56px while macOS needs 78px to clear the
  // traffic lights, so the New chat "+" bled into the content area and the
  // search palette was offset by the wrong amount.
  assert.match(appRoot, /'--lc-sidebar-width':/);
  assert.match(appRoot, /platform === 'darwin' \? 78 : 56/);
  assert.doesNotMatch(css, /grid-template-columns:\s*(56|78)px/);
  assert.doesNotMatch(css, /\.lc-shell-sidebar\s*\{[^}]*width:\s*(56|78)px/);
  assert.doesNotMatch(css, /padding-left:\s*(56|76|78)px/, 'use var(--lc-traffic-w) / var(--lc-sidebar-width)');
  assert.match(baseCss, /--lc-traffic-w:\s*78px/);
});

test('macOS keeps a reachable expand control when collapsed', () => {
  // Hiding it left ⌘\ as the only way back, which nobody discovers.
  assert.doesNotMatch(appRoot, /hideMacCollapsedToggle/);
  assert.doesNotMatch(css, /lc-shell-icon-button\s*\{[^}]*display:\s*none/);
  // The strip is window-level now, so collapsing cannot move or hide it.
  assert.match(appRoot, /aria-label=\{sidebarCollapsed \? 'Expand sidebar' : 'Collapse sidebar'\}/);
});

test('the window chrome strip holds the toggle and search beside the lights in both states', () => {
  // A wordmark here rendered on top of the traffic lights, and the reference
  // app does not have one: the strip is toggle + search only.
  assert.doesNotMatch(appRoot, /lc-shell-product-mark/, 'the wordmark must stay out of the title bar');
  assert.doesNotMatch(css, /lc-shell-product-mark/);
  assert.match(appRoot, /lc-shell-window-chrome[\s\S]{0,600}?aria-label="Search"/);

  // Out of flow, so its position no longer depends on the sidebar width — a
  // 56px rail cannot hold 76px of lights plus a button, which is why the
  // collapsed state used to push them underneath.
  const strip = declarationsFor(fixesCss, '.lc-shell-window-chrome');
  assert.match(strip, /position:\s*fixed/);
  assert.match(strip, /top:\s*0/);
  assert.match(strip, /left:\s*0/);
  assert.doesNotMatch(fixesCss, /\.sidebar-collapsed \.lc-shell-window-chrome/, 'the strip must not move when collapsing');
  assert.match(fixesCss, /\.lc-shell-primary-nav\s*\{[^}]*margin-top:\s*var\(--lc-titlebar-h\)/, 'the sidebar must reserve the strip height');

  // The macOS inset comes from tokens, with a gap so the toggle is not welded
  // to the green button. Nothing may !important over it.
  assert.match(fixesCss, /\[data-platform='darwin'\] \.lc-shell-window-chrome\s*\{[^}]*padding-left:\s*calc\(var\(--lc-traffic-w\) \+ var\(--lc-traffic-gap\)\)/);
  assert.match(baseCss, /--lc-traffic-gap:\s*\d+px/);
  assert.doesNotMatch(css, /\.lc-shell-window-chrome\s*\{[^}]*padding[^;}]*!important/);

  // Search moved out of the nav; no keyboard badge is rendered in a row.
  assert.doesNotMatch(appRoot, /<kbd>⌘K<\/kbd>/);
  assert.doesNotMatch(css, /lc-shell-primary-nav\s+kbd/);
});

test('sidebar rows use the reference scale, not a denser or larger one', () => {
  const nav = declarationsFor(fixesCss, '.lc-shell-primary-nav button');
  assert.match(nav, /height:\s*32px/);
  assert.match(nav, /font-size:\s*13px/);
  assert.match(nav, /border-radius:\s*8px/);

  assert.match(declarationsFor(fixesCss, '.lc-shell-account-avatar'), /width:\s*26px/);
  assert.match(declarationsFor(fixesCss, '.lc-shell-sidebar-section-title'), /font-size:\s*12px/);
  assert.match(declarationsFor(fixesCss, '.lc-shell-sidebar-row-copy strong'), /font-size:\s*13px/);
  assert.match(appRoot, /lc-shell-account-chevron/);
});

test('there is no Chats surface: conversations live in the sidebar tree', () => {
  // In the reference app a Chats screen would be the archive, which this app
  // does not have — the nav is New chat / Projects / Runs.
  assert.match(appRoot, /type Surface = 'agent' \| 'projects' \| 'project' \| 'runs'/);
  assert.doesNotMatch(appRoot, /selectSurface\('chats'\)/);
  assert.doesNotMatch(appRoot, /<ChatHistory/);
  assert.equal(fs.existsSync(path.join(root, 'app/src/ChatHistory.tsx')), false);
  assert.doesNotMatch(css, /chat-history/);
  assert.doesNotMatch(native, /'chats'/);
  assert.doesNotMatch(desktop, /emitCommand\('chats'\)/);
  assert.doesNotMatch(desktop, /CommandOrControl\+3/);
});

test('project conversations nest under the project, behind a disclosure', () => {
  assert.match(appRoot, /jobsByProject/);
  assert.match(appRoot, /lc-shell-project-disclosure/);
  assert.match(appRoot, /aria-expanded=\{expanded\}/);
  assert.match(appRoot, /lc-shell-project-children/);
  assert.match(appRoot, /local-coder\.expanded-projects/);
  // Expanded state survives a restart.
  assert.match(appRoot, /EXPANDED_KEY/);
  assert.match(fixesCss, /\.lc-shell-project-children\s*\{[^}]*border-left/);
});

test('conversations without a project get their own section', () => {
  assert.match(appRoot, /looseJobs/);
  assert.match(appRoot, /!job\.input\.projectId/);
  assert.match(appRoot, /<span>Chats<\/span>/);
});

test('one dot carries unread, read and in-progress, and toggles read state', () => {
  assert.match(appRoot, /lc-shell-chat-dot/);
  assert.match(appRoot, /data-state=\{state\}/);
  assert.match(appRoot, /function isRunning/);
  assert.match(appRoot, /local-coder\.read-jobs/);
  assert.match(appRoot, /Mark as unread/);
  assert.match(appRoot, /markRead\(job\.id, true\)/, 'opening a conversation marks it read');
  for (const state of ['unread', 'read', 'running']) {
    assert.match(fixesCss, new RegExp(`\\.lc-shell-chat-dot\\[data-state='${state}'\\]`), `missing dot state: ${state}`);
  }
  assert.match(fixesCss, /animation:\s*lc-dot-pulse/);
  assert.match(fixesCss, /@keyframes lc-dot-pulse/);
});

test('the footer has no Settings row: the account row opens the same modal', () => {
  assert.doesNotMatch(appRoot, /aria-label="Settings"/);
  assert.match(appRoot, /className="lc-shell-account-row" onClick=\{\(\) => openSettings\(\)\}/);
  // The shortcut and the native menu item stay.
  assert.match(appRoot, /key === ','/);
  assert.match(desktop, /CommandOrControl\+,/);
});

test('the account avatar stays visible in the collapsed rail', () => {
  // Every rule that hides footer button spans must exempt the avatar, otherwise
  // the collapsed rail loses its account row entirely.
  const hiders = [...css.matchAll(/^([^{}\n]*lc-shell-sidebar-footer[^{}]*span[^{}]*)\{([^}]*)\}/gm)]
    .filter(([, , body]) => /display:\s*none/.test(body));
  assert.ok(hiders.length > 0, 'expected at least one collapsed-footer rule to check');
  for (const [, selector] of hiders) {
    assert.match(selector, /:not\(\.lc-shell-account-avatar\)/, `rule hides the avatar: ${selector.trim()}`);
  }
  assert.match(fixesCss, /\.sidebar-collapsed \.lc-shell-account-row \.lc-shell-account-avatar/);
});

test('shell-level state classes are never used as descendants of the shell', () => {
  // `sidebar-collapsed` and `data-shell` sit on the same element, so
  // "[data-shell='electron'] .sidebar-collapsed" matched nothing and silently
  // dropped every macOS collapsed-rail rule.
  assert.doesNotMatch(css, /\[data-(?:shell|platform)=[^\]]*\]\s+\.(?:sidebar-collapsed|auto-sidebar-collapsed|lc-shell-app-shell)/);
});

test('the error toast lays out its actions instead of squashing them into icon squares', () => {
  // `.lc-agent-error-banner button { width: 26px }` applied to Retry and
  // Settings too, so their labels overflowed and collided with the dismiss X.
  assert.match(fixesCss, /error-banner > button:not\(\[aria-label='Dismiss'\]\)\s*\{[^}]*width:\s*auto/);
  assert.match(fixesCss, /error-banner > button:not\(\[aria-label='Dismiss'\]\)\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(agentSurface, /setTimeout\(\(\) => setError\(undefined\), 8_000\)/);
  assert.match(agentSurface, />Retry<\/button>/);
  assert.match(agentSurface, />Settings<\/button>/);
  assert.match(appRoot, /lc-shell-runtime-status/);
});

test('hover and active never resolve to the same background', () => {
  const hover = fixesCss.match(/\.lc-shell-primary-nav button:hover[\s\S]*?\{([\s\S]*?)\}/);
  const active = fixesCss.match(/\.lc-shell-primary-nav button\.active,[\s\S]*?\{([\s\S]*?)\}/);
  assert.ok(hover && active);
  const bg = (block: string) => block.match(/background:\s*([^;]+)/)?.[1].trim();
  assert.notEqual(bg(hover[1]), bg(active[1]), 'hovered and selected rows must be distinguishable');
});

test('composer focus is one ring on the card, not a square outline on the textarea', () => {
  assert.match(fixesCss, /\.lc-agent-prompt-input:focus[\s\S]*?outline:\s*none/);
  assert.match(fixesCss, /\.lc-agent-composer:focus-within[\s\S]*?box-shadow:/);
  assert.match(agentSurface, /useRef<HTMLTextAreaElement>/);
  assert.match(agentSurface, /element\.style\.height = 'auto'/);
  assert.match(agentSurface, /Math\.min\(element\.scrollHeight/);
  assert.match(agentSurface, /rows=\{1\}/);
  assert.match(css, /max-height:\s*min\(360px/);
});

test('one profile-name formatter feeds both the sidebar and the greeting', () => {
  assert.match(native, /export function displayProfileName/);
  assert.match(appRoot, /displayProfileName\(userName\)/);
  assert.match(agentSurface, /displayProfileName\(userName\)/);
  assert.doesNotMatch(appRoot, /^function displayProfileName/m, 'must not be duplicated per view');
  assert.match(agentSurface, /function greeting/);
});

test('desktop chrome uses persistent responsive sidebar and safe native drag regions', () => {
  for (const required of ['lc-shell-app-shell', 'lc-shell-sidebar', 'lc-shell-window-chrome', 'lc-shell-sidebar-resizer', 'New chat', 'Search', 'Chats', 'Projects', 'Runs']) {
    assert.equal(appRoot.includes(required), true, `missing global shell primitive: ${required}`);
  }
  assert.match(appRoot, /data-shell=/);
  assert.match(appRoot, /data-platform=/);
  assert.match(appRoot, /local-coder\.sidebar-width/);
  assert.match(appRoot, /autoCollapsed/);
  assert.match(appRoot, /window\.innerWidth < 900/);
  assert.match(css, /-webkit-app-region:\s*drag/);
  assert.match(css, /-webkit-app-region:\s*no-drag/);
  assert.match(css, /overflow-x:\s*clip/);
  assert.match(css, /margin-top:\s*auto/);
  assert.match(desktop, /trafficLightPosition/);
});

test('collapsed rail has accessible names delayed tooltips and persistent profile footer', () => {
  for (const label of ['New chat', 'Search', 'Projects', 'Runs']) {
    assert.match(appRoot, new RegExp(`aria-label=\\"${label}\\"`));
  }
  assert.match(appRoot, /data-tooltip=/);
  assert.match(css, /transition:\s*opacity 120ms ease 400ms/);
  assert.match(appRoot, /lc-shell-account-avatar/);
});

test('global and native shortcuts cover core Local Coder navigation', () => {
  for (const token of ["key === 'k'", "key === 'n'", "key === '\\\\'", "key === ','", "key === '1'", "key === '2'"]) {
    assert.match(appRoot, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const accelerator of ['CommandOrControl+N', 'CommandOrControl+\\\\', 'CommandOrControl+,', 'CommandOrControl+1', 'CommandOrControl+2']) {
    assert.equal(desktop.includes(accelerator), true, `missing native shortcut: ${accelerator}`);
  }
  assert.match(preload, /local-coder:command/);
});

test('the application menu keeps the roles the clipboard shortcuts depend on', () => {
  // A custom menu without these roles silently disables Cmd+A/C/V/X/Z on macOS:
  // the accelerators are delivered by the menu, not by the web contents.
  assert.match(desktop, /\{ role: 'editMenu' \}/, 'no Edit menu means no copy, paste or select-all');
  assert.match(desktop, /\{ role: 'windowMenu' \}/);
  assert.match(desktop, /Menu\.setApplicationMenu/);
});

test('desktop restores window bounds and avoids white boot flash', () => {
  for (const required of ['window-state.json', 'screen.getAllDisplays()', 'screen.getDisplayMatching(requested)', 'screen.getPrimaryDisplay()', 'window.getNormalBounds()', 'window.isMaximized()']) {
    assert.equal(desktop.includes(required), true, `missing desktop bounds behavior: ${required}`);
  }
  assert.match(desktop, /MIN_WINDOW_WIDTH = 760/);
  assert.match(desktop, /MIN_WINDOW_HEIGHT = 560/);
  assert.match(desktop, /backgroundColor:\s*'#151515'/);
  assert.match(desktop, /show:\s*false/);
  assert.match(desktop, /once\('ready-to-show'/);
  // The window background, the meta colour and --lc-bg must agree or the app
  // flashes a different colour before the stylesheet lands.
  assert.match(indexHtml, /theme-color" content="#151515"/);
  assert.doesNotMatch(indexHtml, /<style/, "CSP is style-src 'self'; inline <style> would be blocked");
});

test('native bridge exposes only narrow runtime folder theme profile login and command capabilities', () => {
  assert.match(desktop, /ipcMain\.handle\('local-coder:runtime-request'/);
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

test('agent remains thread-first with lightweight streaming state', () => {
  for (const required of ['lc-agent-thread-pane', 'thread-user-turn', 'user-message', 'thread-assistant-turn', 'assistant-body', 'lc-agent-composer', 'lc-agent-prompt-input', 'lc-agent-send-button', 'lc-agent-stop-button', 'lc-agent-progress-rail']) {
    assert.equal(agentSurface.includes(required), true, `missing Agent primitive: ${required}`);
  }
  for (const state of ['Working', 'Thinking', 'Writing']) assert.match(agentSurface, new RegExp(state));
  assert.doesNotMatch(agentSurface, /thinkingChars/);
});

test('send affordance is text-driven, and only Cowork needs a folder', () => {
  assert.match(agentSurface, /canSubmit=\{Boolean\(goal\.trim\(\)\)\}/);
  assert.match(agentSurface, /if \(!goal\.trim\(\)\) return/);
  // Chat is one inference that reads no files, so it sends without a folder.
  assert.match(agentSurface, /if \(!effectiveWorkspace && mode === 'cowork'\)/);
  assert.match(agentSurface, /setExtrasOpen\(true\)/);
});

test('workspace entry has native Browse and browser recent-folder fallback', () => {
  assert.match(projectGallery, /<FolderField/);
  assert.match(agentSurface, /<FolderField/);
  assert.match(settingsModal, /<FolderField/);
  assert.match(folderField, /window\.lc\?\.pickDirectory/);
  assert.match(folderField, /Browse/);
  assert.match(folderField, /<datalist/);
  assert.match(folderField, /local-coder\.recent-workspaces/);
  assert.match(folderField, /Folder not found/);
  assert.match(css, /\.path-browse-button/);
});

test('model menu is catalog-driven, keeps branded built-ins, and exposes Effort and Thinking', () => {
  assert.match(agentSurface, /className="model-effort-trigger"/);
  assert.match(agentSurface, /type ModelMenuView = 'closed' \| 'providers' \| 'models' \| 'legacy-models' \| 'effort'/);
  assert.match(agentSurface, /modelMenu === 'closed' \? 'providers' : 'closed'/);
  assert.match(agentSurface, /props\.modelMenu === 'models' \|\| props\.modelMenu === 'legacy-models'/);
  assert.match(agentSurface, /Older Claude versions and dated snapshots/);
  assert.match(agentSurface, /setModelMenu\('providers'\).*models<\/strong>/s, 'the model list must have a back path to providers');
  assert.match(agentSurface, /setModelMenu\('models'\)/, 'choosing a provider must open its model list');
  assert.match(agentSurface, /\(catalog\?\.providers \?\? \[\]\)\.map\(\(provider\)/);
  assert.match(agentSurface, /id: provider\.id/);
  assert.doesNotMatch(agentSurface, /type ProviderMode = 'ollama'/, 'new providers must not require a hardcoded union');
  for (const label of ['Ollama', 'Claude', 'GPT']) assert.match(agentSurface, new RegExp(`return '${label}'`));
  assert.match(agentSurface, /label: 'Local-first'/);
  assert.match(agentSurface, /Start on Ollama; ask before bounded cloud escalation/);
  assert.match(agentSurface, /mode\.reason \?\? 'unavailable'/, 'provider discovery failures must be visible');
  assert.match(agentSurface, /catalogHasSelection\(next, current\)/, 'catalog refresh must preserve a valid explicit model');
  assert.doesNotMatch(agentSurface, /<strong>Auto<\/strong>/, 'Auto must not appear as a fifth provider mode');
  assert.match(agentSurface, /<strong>Effort<\/strong>/);
  assert.match(agentSurface, /<strong>Thinking<\/strong>/);
  for (const label of ['Low', 'Medium', 'High', 'Extra high', 'Max']) assert.match(agentSurface, new RegExp(`label: '${label}'`));
  assert.match(agentSurface, /const modelOverrideAllowed = Boolean\(selectedProject\) \|\| mode === 'chat'/);
  assert.match(agentSurface, /modelSelection:\s*modelOverrideAllowed \? parseModelValue\(modelSelection\) : undefined/);
  assert.match(agentSurface, /reasoningEffort:\s*modelOverrideAllowed \? \(thinkingEnabled \? effort : 'none'\) : undefined/);
  assert.match(agentSurface, /allowLocalFirst=\{Boolean\(selectedProject\)\}/);
  assert.match(agentSurface, /\/api\/jobs\/\$\{active\.id\}\/escalate/);
  assert.match(agentSurface, /Ollama remains the task owner and resumes after the answer/);
  assert.match(css, /\.lc-agent-switch\.on/);
});

test('the empty state is a greeting and nothing else', () => {
  assert.match(agentSurface, /getProfile\(\)/);
  // The reference app shows no breadcrumb and no explanatory paragraph; those
  // were most of the content on the screen.
  assert.doesNotMatch(agentSurface, /empty-project-breadcrumb/);
  assert.doesNotMatch(css, /empty-project-breadcrumb/);
  assert.doesNotMatch(agentSurface, /Start a chat in this project/);
  assert.doesNotMatch(agentSurface, /Describe what you want to build/);
  // The mark is inline with the greeting, not stacked above it.
  assert.match(fixesCss, /\.lc-agent-empty-start h1\s*\{[^}]*display:\s*flex/);
  assert.match(css, /padding-top:\s*var\(--lc-titlebar-h\)/);
});

test('suggestions sit below the composer, with an icon and a real surface', () => {
  // Rendered after <Composer/>, not inside the empty state above it.
  const composerAt = agentSurface.indexOf('<Composer');
  const suggestionsAt = agentSurface.indexOf('<Suggestions');
  assert.ok(composerAt > 0 && suggestionsAt > composerAt, 'Suggestions must render after the composer');
  // EmptyStart no longer receives the callback, so it cannot render them above.
  assert.doesNotMatch(agentSurface, /function EmptyStart\([^)]*onSuggestion/);

  const pill = declarationsFor(fixesCss, '.lc-agent-quick-actions button');
  assert.match(pill, /background:\s*var\(--lc-surface-2\)/, 'hairline pills on the canvas read as disabled');
  assert.match(pill, /font-size:\s*13px/);
  assert.match(agentSurface, /icon: Code/);
  assert.match(agentSurface, /<Icon size=\{14\}/);
});

test('Chat and Cowork are distinct modes and Cowork is bound to a folder', () => {
  assert.match(agentSurface, /type ComposerMode = 'chat' \| 'cowork'/);
  assert.match(agentSurface, /local-coder\.composer-mode/, 'the choice must survive a restart');
  assert.match(agentSurface, /composer-mode-switch/);
  assert.match(agentSurface, /role="radiogroup"/);
  // Switching to Cowork without a folder asks for one instead of failing later.
  assert.match(agentSurface, /next === 'cowork' && !selectedProject && !workspace\.trim\(\)/);
  assert.match(agentSurface, /'Project or folder'/);
  // Chat shows starting points; Cowork says which folder it will act on.
  assert.match(agentSurface, /mode === 'chat' \? <Suggestions/);
  assert.match(agentSurface, /lc-agent-cowork-hint/);
  assert.match(fixesCss, /\.composer-mode-switch button\.selected/);
});

test('New chat is borderless with the tint on its icon, and projects show no count', () => {
  const button = declarationsFor(fixesCss, '.lc-shell-new-chat');
  assert.match(button, /border:\s*0/);
  assert.match(button, /background:\s*transparent/);
  assert.doesNotMatch(css, /\.lc-shell-new-chat\s*\{[^}]*border[^;}]*!important/);
  assert.match(declarationsFor(fixesCss, '.lc-shell-new-chat i'), /background:\s*color-mix/);
  assert.doesNotMatch(appRoot, /lc-shell-project-count/);
  assert.doesNotMatch(css, /lc-shell-project-count/);
});

test('Projects uses real folder picker and consistent primary-secondary hierarchy', () => {
  for (const required of ['lc-shell-projects-page', 'lc-shell-project-grid', 'lc-shell-project-card', 'lc-shell-project-modal', 'New project', 'Last updated', 'Create a project', 'Search projects']) {
    assert.equal(projectGallery.includes(required), true, `missing Projects primitive: ${required}`);
  }
  assert.match(projectGallery, /<FolderPlus size=\{15\}/);
  assert.match(projectGallery, /What do you want to accomplish\?/);
  assert.match(projectDetail, /project-detail-instructions/);
  assert.match(projectGallery, /btn-secondary/);
  assert.match(projectGallery, /btn-primary/);
  assert.match(css, /\.btn-primary/);
  assert.match(css, /\.btn-secondary/);
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
  assert.match(css, /\.ui-select-popover/);
});

test('Usage renders through the CSP-compatible stylesheet and keeps the reference hierarchy', () => {
  assert.doesNotMatch(usageSettings, /<style>/, "CSP blocks component-level inline styles");
  for (const selector of ['.usage-shell', '.usage-toolbar', '.usage-chart-wrap', '.usage-row']) {
    assert.match(appCss, new RegExp(selector.replace('.', '\\.')));
  }
  assert.match(usageSettings, /className="usage-chart"/);
  assert.match(usageSettings, /className="usage-chart-tooltip"/);
  assert.match(usageSettings, /onPointerEnter=\{\(\) => setHoveredKey/);
  assert.match(usageSettings, /Spend: \{costLabel\(hoveredPoint\)\}/);
  assert.match(usageSettings, /Show \{hiddenRows\} more/);
  assert.match(usageSettings, /<progress className=\{`usage-budget-progress/);
});

test('appearance syncs with Electron nativeTheme and every preview has its own rule', () => {
  assert.match(settingsModal, /window\.lc\?\.setTheme/);
  assert.match(desktop, /nativeTheme\.on\('updated'/);
  assert.match(preload, /local-coder:theme-changed/);
  // theme-${mode} is built from a template literal, so these classes are easy to
  // lose to dead-CSS pruning; System had no rule and rendered a stray diagonal.
  for (const mode of ['light', 'dark', 'system']) {
    assert.match(fixesCss, new RegExp(`\\.theme-preview\\.theme-${mode}\\s*\\{`), `missing preview: ${mode}`);
  }
  assert.match(fixesCss, /\.theme-preview\.theme-system::after/);
  assert.match(fixesCss, /clip-path:\s*polygon/);
});

test('Runs is an operational table rather than asymmetric admin cards', () => {
  assert.match(runInspector, /<table className="runs-table">/);
  for (const column of ['When', 'Project / task', 'Provider / model', 'Tokens', 'Cost', 'Latency', 'Status']) assert.match(runInspector, new RegExp(column.replace('/', '\\/')));
  assert.match(runInspector, /runs-detail/);
  assert.doesNotMatch(runInspector, /PROJECT EXECUTION/);
  assert.match(css, /\.runs-table/);
});

test('typography scale, casing and scrollbars stay on the token system', () => {
  assert.match(css, /outline:\s*2px solid var\(--lc-accent\)/);
  assert.match(fixesCss, /\.page-title[\s\S]*?font-family:\s*var\(--lc-font-serif\)/);
  assert.match(fixesCss, /text-transform:\s*none/);
  assert.match(baseCss, /scrollbar-color/);
  // Page titles are serif 400; the Runs heading used to be Inter 580, which put
  // it on a different scale from every other route.
  assert.match(fixesCss, /\.page-title\s*\{[^}]*font-weight:\s*400\s*;/);
});

test('renderer zoom is not forced and the thread owns its scroll', () => {
  assert.doesNotMatch(desktop, /setZoomFactor\(/);
  assert.match(appCss, /\.lc-agent-thread\s*\{[\s\S]*?overflow-y:\s*auto/);
  // The agent's own right rail is gone with the retired AgentSurface, so the
  // grid no longer reserves a phantom column for it.
  assert.doesNotMatch(css, /lc-agent-sidebar/);
  assert.equal(fs.existsSync(path.join(root, 'app/src/AgentSurface.tsx')), false, 'the superseded agent surface must stay deleted');
  assert.doesNotMatch(agentSurface, /from '\.\/AdminPanel\.js'/, 'AdminPanel.tsx does not exist; types live in app-types');
});
