import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';
import { ProjectStore } from '../dist/project-store.js';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'projects');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-overview-visual-'));
const projectsFile = path.join(fixtureDir, 'projects.json');
const workspace = path.join(fixtureDir, 'atlas-workspace');
const debugPort = 9343;

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# Atlas\n\nProject overview visual fixture.\n');

new ProjectStore(projectsFile).create({
  id: 'visual-project',
  name: 'Project Atlas',
  description: 'Project overview visual fixture',
  workspace,
  instructions: 'Keep answers concise and verify repository evidence.',
  organizationId: 'personal',
  organizationName: 'Personal',
  defaultRoutingPolicy: 'local-first',
  defaultModel: { mode: 'local-first', modelId: 'qwen2.5-coder:7b' },
  privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] },
  connectionPolicy: {
    chat: {
      defaultConnectionId: 'ollama',
      defaultModelId: 'qwen2.5-coder:7b',
      allowedConnectionIds: ['ollama']
    },
    inference: { allowedConnectionIds: ['ollama'], preferredConnectionId: 'ollama' },
    workSourceIds: []
  },
  concurrency: 1
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_PROJECTS_PATH: projectsFile,
  LOCAL_CODER_SETTINGS_PATH: path.join(fixtureDir, 'settings.json'),
  LOCAL_CODER_CREDENTIALS_PATH: path.join(fixtureDir, 'credentials.json'),
  LOCAL_CODER_RUN_STORE_PATH: path.join(fixtureDir, 'runs.json'),
  LOCAL_CODER_PROFILE_NAME: 'Project Visual Smoke',
  LOCAL_CODER_REMOTE_WORKER_URL: 'http://127.0.0.1:65534'
});

const child = spawn(electronPath, [`--remote-debugging-port=${debugPort}`, '.'], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe']
});

let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && String(item.url).includes('app-dist/index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* renderer is still starting */ }
    await sleep(250);
  }
  throw new Error(`Electron renderer did not expose a CDP target.\n${logs}`);
}

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket.close(); }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`);
  return result.result?.value;
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${label}.\n${logs}`);
}

async function screenshot(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const targetPath = path.join(outputDir, `${name}.png`);
  fs.writeFileSync(targetPath, Buffer.from(result.data, 'base64'));
  console.log(`captured ${path.relative(root, targetPath)}`);
}

function fail(label, value) {
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

let cdp;
try {
  const page = await target();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(cdp, `document.querySelector('.lc-shell-sidebar') !== null`, 'Axis shell');

  await evaluate(cdp, `(() => {
    localStorage.setItem('local-coder.surface', 'project');
    localStorage.setItem('local-coder.project', 'visual-project');
    localStorage.setItem('local-coder.company', 'personal');
    localStorage.setItem('local-coder.pinned-projects', JSON.stringify(['visual-project']));
    location.reload();
    return true;
  })()`);

  await waitFor(cdp, `document.querySelector('.project-detail-page') !== null`, 'Project overview');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(cdp, `document.documentElement.dataset.lcTheme = 'dark'; true`);
  await sleep(250);

  const overview = await evaluate(cdp, `(() => {
    const project = document.querySelector('.project-detail-page');
    const rail = document.querySelector('.project-detail-panel');
    return {
      title: document.querySelector('.project-detail-header h1')?.textContent?.trim(),
      pinPressed: document.querySelector('[aria-label="Unpin project"]')?.getAttribute('aria-pressed'),
      hasFavoriteControl: Boolean(document.querySelector('[aria-label*="favorite" i], [aria-label*="star" i]')),
      railHeadings: [...document.querySelectorAll('.project-detail-panel h2')].map((item) => item.textContent?.trim()),
      connectionPanelInRail: Boolean(rail?.querySelector('.project-connection-policy')),
      hasConnectionsModal: Boolean(document.querySelector('[aria-label="Project model and connections"]')),
      hasFolderControl: Boolean(document.querySelector('.project-detail-panel [aria-label="Choose project folder"]')),
      hasSharedComposer: Boolean(document.querySelector('.lc-agent-composer .lc-agent-prompt-input')),
      hasModelControl: Boolean(document.querySelector('.lc-agent-composer .model-effort-trigger[aria-haspopup="menu"]')),
      hasGitReview: Boolean(document.querySelector('.project-git-review')),
      overflow: project ? project.scrollWidth - project.clientWidth : 999
    };
  })()`);
  if (overview?.title !== 'Project Atlas' || overview.pinPressed !== 'true' || overview.hasFavoriteControl) fail('Project header state mismatch', overview);
  if (JSON.stringify(overview.railHeadings) !== JSON.stringify(['Instructions', 'Context'])) fail('Project rail hierarchy mismatch', overview);
  if (overview.connectionPanelInRail || overview.hasConnectionsModal || !overview.hasFolderControl || !overview.hasSharedComposer || !overview.hasModelControl || !overview.hasGitReview || overview.overflow > 1) fail('Project overview state mismatch', overview);
  console.log(`project-overview ${JSON.stringify(overview)}`);
  await screenshot(cdp, 'project-overview-dark');

  await evaluate(cdp, `document.querySelector('.lc-agent-composer .model-effort-trigger')?.click(); true`);
  await waitFor(cdp, `document.querySelector('.lc-agent-composer .model-popover') !== null`, 'Project inline model selector');
  const modelSelector = await evaluate(cdp, `(() => {
    const popover = document.querySelector('.lc-agent-composer .model-popover');
    const box = popover?.getBoundingClientRect();
    return {
      role: popover?.getAttribute('role'),
      providerLabel: document.querySelector('.lc-agent-composer .model-popover .model-provider-label')?.textContent?.trim(),
      hasConnectionsDialog: Boolean(document.querySelector('[aria-label="Project model and connections"]')),
      left: box?.left,
      right: box?.right,
      top: box?.top,
      bottom: box?.bottom,
      width: innerWidth,
      height: innerHeight
    };
  })()`);
  if (modelSelector.role !== 'menu' || modelSelector.providerLabel !== 'Provider or account' || modelSelector.hasConnectionsDialog) fail('Project model selector is not the inline New Chat popover', modelSelector);
  if (modelSelector.left < 0 || modelSelector.right > modelSelector.width || modelSelector.top < 0 || modelSelector.bottom > modelSelector.height) fail('Project model selector is out of bounds', modelSelector);
  await screenshot(cdp, 'project-model-selector-dark');
  await evaluate(cdp, `document.querySelector('.lc-agent-composer .model-effort-trigger')?.click(); true`);
  await waitFor(cdp, `document.querySelector('.lc-agent-composer .model-popover') === null`, 'Project model selector close');

  await evaluate(cdp, `document.querySelector('[aria-label="More project options"]')?.click(); true`);
  await waitFor(cdp, `document.querySelector('.lc-shell-row-menu') !== null`, 'Project actions menu');
  const actions = await evaluate(cdp, `[...document.querySelectorAll('.lc-shell-row-menu [role="menuitem"]')].map((item) => item.textContent?.replace(/\\s+/g, ' ').trim())`);
  if (!actions.some((item) => item?.startsWith('Rename')) || !actions.some((item) => item?.startsWith('Archive')) || !actions.some((item) => item?.startsWith('Delete')) || actions.some((item) => item?.startsWith('Model & connections'))) fail('Project actions menu is incomplete', actions);
  await screenshot(cdp, 'project-actions-menu-dark');
  await evaluate(cdp, `document.querySelector('[aria-label="More project options"]')?.click(); true`);

  await evaluate(cdp, `document.documentElement.dataset.lcTheme = 'light'; true`);
  await sleep(180);
  await screenshot(cdp, 'project-overview-light');

  await evaluate(cdp, `document.documentElement.dataset.lcTheme = 'dark'; true`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const narrow = await evaluate(cdp, `(() => {
    const project = document.querySelector('.project-detail-page');
    const layout = document.querySelector('.project-detail-layout');
    const rail = document.querySelector('.project-detail-panel');
    const layoutBox = layout?.getBoundingClientRect();
    const railBox = rail?.getBoundingClientRect();
    return {
      overflow: project ? project.scrollWidth - project.clientWidth : 999,
      railBelowMain: Boolean(layoutBox && railBox && railBox.top > layoutBox.top + 150)
    };
  })()`);
  if (narrow.overflow > 1 || !narrow.railBelowMain) fail('Narrow Project overview layout is invalid', narrow);
  console.log(`project-overview-narrow ${JSON.stringify(narrow)}`);
  await screenshot(cdp, 'project-overview-narrow-dark');
} finally {
  cdp?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => child.kill('SIGKILL'))
  ]);
}
