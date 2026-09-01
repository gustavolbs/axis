#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

const root = path.resolve(import.meta.dirname, '..');
const consoleDist = path.join(root, 'console-dist');
const sizes = [[760, 560], [900, 640], [1120, 720], [1440, 900]];
const zoomFactors = [0.8, 1, 1.25, 1.5];
const surfaces = [
  { label: 'Agent', nav: 'New chat', selector: '.claude-agent-shell' },
  { label: 'Chats', nav: 'Chats', selector: '.chat-history-page' },
  { label: 'Projects', nav: 'Projects', selector: '.reference-projects-page' },
  { label: 'Runs', nav: 'Runs', selector: '.runs-shell' }
];

const smokeProject = {
  id: 'smoke-project',
  name: 'Smoke Project',
  workspace: '/tmp/local-coder-smoke',
  organizationId: 'smoke-org',
  organizationName: 'Smoke Org',
  defaultRoutingPolicy: 'balanced',
  defaultModel: { mode: 'auto' },
  privacy: { cloudAllowed: true, allowedProviderIds: ['ollama', 'anthropic'] },
  credentialProfileIds: {},
  budgets: { warningFractions: [0.5, 0.75, 0.9], hardStopFraction: 1 },
  concurrency: 1,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z'
};
const smokeCatalog = {
  projectId: smokeProject.id,
  defaultRoutingPolicy: 'balanced',
  defaultModel: { mode: 'auto' },
  providers: [
    { id: 'ollama', kind: 'local', enabled: true, ready: true, models: [{ id: 'qwen3.8:27b', displayName: 'Qwen 3.8 27B', available: true, routing: { enabled: true, qualityScore: 78 }, providerDefault: true, projectDefault: false }] },
    { id: 'anthropic', kind: 'cloud', enabled: true, ready: true, models: [{ id: 'claude-sonnet-smoke', displayName: 'Claude Sonnet', available: true, routing: { enabled: true, frontier: true, qualityScore: 94 }, providerDefault: true, projectDefault: false }] }
  ]
};
const usagePeriod = { events: 0, cloudEvents: 0, localEvents: 0, knownCostUsd: 0, unknownCostEvents: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 };
const emptyUsage = { projectId: smokeProject.id, budgets: smokeProject.budgets, daily: usagePeriod, monthly: usagePeriod, activeReservations: { count: 0, upperBoundUsd: 0 } };

const watchdog = setTimeout(() => {
  console.error('Desktop layout smoke exceeded its 110 second safety limit.');
  app.exit(2);
}, 110_000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mime(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function staticServer() {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api/jobs') return sendJson(response, { jobs: [] });
    if (pathname === '/api/projects') return sendJson(response, { projects: [smokeProject] });
    if (pathname === `/api/projects/${smokeProject.id}/catalog`) return sendJson(response, { catalog: smokeCatalog });
    if (pathname === `/api/projects/${smokeProject.id}/usage`) return sendJson(response, { usage: emptyUsage });
    if (pathname === '/api/providers') return sendJson(response, { providers: smokeCatalog.providers.map((provider) => ({ id: provider.id, kind: provider.kind, builtIn: true, settings: { enabled: true, defaultModelId: provider.models[0].id, models: {} }, credentials: [], pricing: {} })) });
    if (pathname === '/api/credentials') return sendJson(response, { credentials: [] });
    if (pathname === '/api/fs/exists') return sendJson(response, { exists: true, resolvedPath: '/tmp/local-coder-smoke' });
    if (pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write('event: jobs\ndata: []\n\n');
      response.write('event: worker\ndata: {"ok":true,"hostname":"layout-smoke"}\n\n');
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(consoleDist, relative);
    if (!resolved.startsWith(`${consoleDist}${path.sep}`) && resolved !== path.join(consoleDist, 'index.html')) return response.writeHead(403).end();
    try {
      const body = fs.readFileSync(resolved);
      response.writeHead(200, { 'content-type': mime(resolved) });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve layout smoke server port.');
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(window, expression, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(35);
  }
  throw new Error(`Timed out waiting for rendered condition: ${expression}`);
}

async function clickByText(window, selector, text) {
  await window.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => element.textContent?.trim().includes(${JSON.stringify(text)}));
    if (!target) throw new Error('Missing clickable element: ${selector} / ${text}');
    target.click();
  })()`, true);
}

async function selectSurface(window, surface) {
  await clickByText(window, '.reference-primary-nav button', surface.nav);
  await waitFor(window, `document.querySelector(${JSON.stringify(surface.selector)})`);
  await delay(45);
}

async function prepareAgentProject(window) {
  await selectSurface(window, surfaces[0]);
  await waitFor(window, "document.querySelector('.composer-text-button')");
  await waitFor(window, "document.querySelector('.model-effort-trigger')");
  await delay(90);
}

async function measure(window, surfaceSelector) {
  return window.webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === 'none') return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
    };
    const surfaceRoot = document.querySelector(${JSON.stringify(surfaceSelector)});
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      shell: rect('.reference-app-shell'),
      sidebar: rect('.reference-sidebar'),
      content: rect('.reference-content-shell'),
      surfaceRoot: rect(${JSON.stringify(surfaceSelector)}),
      composer: ${JSON.stringify(surfaceSelector)} === '.claude-agent-shell' ? rect('.claude-composer') : null,
      threadPane: ${JSON.stringify(surfaceSelector)} === '.claude-agent-shell' ? rect('.claude-thread-pane') : null,
      surfaceOverflowY: surfaceRoot ? getComputedStyle(surfaceRoot).overflowY : null
    };
  })()`, true);
}

async function measurePopover(window, selector) {
  return window.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return { rect: { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }, viewport: { width: window.innerWidth, height: window.innerHeight }, documentScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth };
  })()`, true);
}

function withinViewport(name, rect, viewport) {
  if (!rect) throw new Error(`${name} is missing from rendered UI.`);
  const epsilon = 2;
  if (rect.left < -epsilon || rect.top < -epsilon || rect.right > viewport.width + epsilon || rect.bottom > viewport.height + epsilon) throw new Error(`${name} escaped viewport: ${JSON.stringify({ rect, viewport })}`);
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`${name} has invalid dimensions: ${JSON.stringify(rect)}`);
}

function assertNoHorizontalPageOverflow(result, label) {
  const epsilon = 2;
  if (result.documentScrollWidth > result.viewport.width + epsilon || result.bodyScrollWidth > result.viewport.width + epsilon) throw new Error(`horizontal page overflow ${label}: ${JSON.stringify(result)}`);
}

function assertLayout(result, size, zoom, surface) {
  assertNoHorizontalPageOverflow(result, `on ${surface.label} at ${size.join('x')} zoom ${zoom}`);
  withinViewport('application shell', result.shell, result.viewport);
  withinViewport('global sidebar', result.sidebar, result.viewport);
  withinViewport('content shell', result.content, result.viewport);
  withinViewport(`${surface.label} root`, result.surfaceRoot, result.viewport);
  if (surface.selector === '.claude-agent-shell') {
    withinViewport('Agent composer', result.composer, result.viewport);
    withinViewport('Agent thread pane', result.threadPane, result.viewport);
  }
}

function assertPopover(result, label) {
  if (!result) throw new Error(`${label} did not render.`);
  assertNoHorizontalPageOverflow(result, `while ${label} is open`);
  withinViewport(label, result.rect, result.viewport);
}

async function closeOpenComposerMenu(window) {
  await window.webContents.executeJavaScript("document.querySelector('.claude-prompt-input')?.click()", true);
  await delay(30);
}

async function checkAgentMenus(window, size, zoom) {
  await selectSurface(window, surfaces[0]);

  await window.webContents.executeJavaScript("document.querySelector('.model-effort-trigger').click()", true);
  await waitFor(window, "document.querySelector('.model-popover')");
  assertPopover(await measurePopover(window, '.model-popover'), `model menu at ${size.join('x')} zoom ${zoom}`);
  await clickByText(window, '.model-popover .popover-row-link', 'Effort');
  await waitFor(window, "document.querySelector('.effort-popover')");
  assertPopover(await measurePopover(window, '.effort-popover'), `effort menu at ${size.join('x')} zoom ${zoom}`);
  await window.webContents.executeJavaScript("document.querySelector('.effort-popover .popover-back').click()", true);
  await waitFor(window, "document.querySelector('.model-popover') && !document.querySelector('.effort-popover')");
  const thinkingVisible = await window.webContents.executeJavaScript("Boolean([...document.querySelectorAll('.model-popover button')].find((button) => button.textContent?.includes('Thinking'))?.querySelector('.claude-switch.on'))", true);
  if (!thinkingVisible) throw new Error(`Thinking switch is not visibly enabled at ${size.join('x')} zoom ${zoom}.`);
  await closeOpenComposerMenu(window);

  await window.webContents.executeJavaScript("document.querySelector('.composer-icon-button').click()", true);
  await waitFor(window, "document.querySelector('.composer-add-popover')");
  assertPopover(await measurePopover(window, '.composer-add-popover'), `add-context menu at ${size.join('x')} zoom ${zoom}`);
  await closeOpenComposerMenu(window);

  await window.webContents.executeJavaScript("document.querySelector('.composer-text-button').click()", true);
  await waitFor(window, "document.querySelector('.project-popover')");
  assertPopover(await measurePopover(window, '.project-popover'), `project menu at ${size.join('x')} zoom ${zoom}`);
  await closeOpenComposerMenu(window);
}

async function openUiSelect(window, label) {
  await window.webContents.executeJavaScript(`(() => {
    const trigger = [...document.querySelectorAll('.ui-select-trigger')]
      .find((button) => button.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!trigger) throw new Error('Missing UiSelect trigger: ${label}');
    trigger.click();
  })()`, true);
  await waitFor(window, "document.querySelector('.ui-select-popover')");
}

async function closeUiSelect(window) {
  await window.webContents.executeJavaScript("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))", true);
  await waitFor(window, "!document.querySelector('.ui-select-popover')");
}

async function checkSettings(window, size, zoom) {
  await clickByText(window, '.reference-sidebar-footer > button', 'Settings');
  await waitFor(window, "document.querySelector('.settings-modal')");
  assertPopover(await measurePopover(window, '.settings-modal'), `settings modal at ${size.join('x')} zoom ${zoom}`);

  await clickByText(window, '.settings-rail button', 'Appearance');
  await waitFor(window, "document.querySelector('.settings-option-group')");

  await clickByText(window, '.settings-rail button', 'Model routing');
  await waitFor(window, "document.querySelector('.routing-settings-page')");
  await openUiSelect(window, 'Project');
  assertPopover(await measurePopover(window, '.ui-select-popover'), `project settings select at ${size.join('x')} zoom ${zoom}`);
  await closeUiSelect(window);
  await openUiSelect(window, 'Routing policy');
  assertPopover(await measurePopover(window, '.ui-select-popover'), `routing-policy select at ${size.join('x')} zoom ${zoom}`);
  await closeUiSelect(window);

  await clickByText(window, '.settings-rail button', 'API keys');
  await waitFor(window, "document.querySelector('.api-key-settings-page')");
  await clickByText(window, '.api-key-settings-page .settings-save-button', 'Add key');
  await waitFor(window, "document.querySelector('.nested-settings-dialog')");
  assertPopover(await measurePopover(window, '.nested-settings-dialog'), `add API key dialog at ${size.join('x')} zoom ${zoom}`);
  await openUiSelect(window, 'Provider');
  assertPopover(await measurePopover(window, '.ui-select-popover'), `provider select at ${size.join('x')} zoom ${zoom}`);
  await closeUiSelect(window);
  await openUiSelect(window, 'Backend');
  assertPopover(await measurePopover(window, '.ui-select-popover'), `backend select at ${size.join('x')} zoom ${zoom}`);
  await closeUiSelect(window);
  await clickByText(window, '.nested-settings-dialog-actions button', 'Cancel');
  await waitFor(window, "!document.querySelector('.nested-settings-dialog')");

  await window.webContents.executeJavaScript("document.querySelector('.settings-close').click()", true);
  await waitFor(window, "!document.querySelector('.settings-modal')");
}

const server = staticServer();
let window;

try {
  if (!fs.existsSync(path.join(consoleDist, 'index.html'))) throw new Error('console-dist/index.html is missing. Run npm run build before the layout smoke.');
  const url = await listen(server);
  await app.whenReady();
  window = new BrowserWindow({ width: 760, height: 560, minWidth: 320, minHeight: 320, show: false, titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  await window.loadURL(url);
  await prepareAgentProject(window);

  const checks = [];
  for (const [width, height] of sizes) {
    window.setSize(width, height, false);
    for (const zoom of zoomFactors) {
      window.webContents.setZoomFactor(zoom);
      await delay(70);
      for (const surface of surfaces) {
        await selectSurface(window, surface);
        const result = await measure(window, surface.selector);
        assertLayout(result, [width, height], zoom, surface);
        checks.push({ surface: surface.label, width, height, zoom, viewport: result.viewport });
      }
      await checkAgentMenus(window, [width, height], zoom);
      await checkSettings(window, [width, height], zoom);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    checks,
    layoutChecks: sizes.length * zoomFactors.length * surfaces.length,
    interactiveComposerChecks: sizes.length * zoomFactors.length * 3,
    settingsChecks: sizes.length * zoomFactors.length,
    focusedSettingsSelectChecks: sizes.length * zoomFactors.length * 4
  }, null, 2));
} finally {
  clearTimeout(watchdog);
  if (window && !window.isDestroyed()) window.destroy();
  server.closeAllConnections?.();
  await Promise.race([new Promise((resolve) => server.close(resolve)), delay(1_500)]);
  app.quit();
}
