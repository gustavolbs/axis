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
fs.writeFileSync(path.join(workspace, 'README.md'), '# Atlas\n\nVisual fixture for the Project overview.\n');

new ProjectStore(projectsFile).create({
  id: 'visual-project',
  name: 'Project Atlas',
  description: 'Claude Cowork parity visual fixture',
  workspace,
  instructions: 'Keep answers concise, verify repository evidence, and preserve the existing design system.',
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
    } catch { /* renderer still starting */ }
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
    localStorage.setItem('local-coder.starred-projects', JSON.stringify(['visual-project']));
    localStorage.setItem('local-coder.project-schedules.v1', JSON.stringify([{
      id: 'weekly-review', projectId: 'visual-project', companyId: 'personal',
      name: 'Weekly project review', prompt: 'Review current project state and summarize risks.',
      frequency: 'weekly', time: '09:00', weekday: 1, enabled: true,
      createdAt: '2026-09-03T12:00:00.000Z', updatedAt: '2026-09-03T12:00:00.000Z',
      nextRunAt: '2030-09-09T12:00:00.000Z'
    }]));
    location.reload();
    return true;
  })()`);

  await waitFor(cdp, `document.querySelector('.project-detail-page') !== null`, 'Project overview');
  await evaluate(cdp, `document.documentElement.dataset.lcTheme = 'dark'; true`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(250);

  const overview = await evaluate(cdp, `(() => {
    const page = document.querySelector('.project-detail-page');
    const rail = document.querySelector('.project-detail-panel');
    const sections = [...document.querySelectorAll('.project-detail-panel section')];
    const section = (name) => sections.find((item) => item.querySelector('h2')?.textContent?.trim() === name);
    return {
      title: document.querySelector('.project-detail-header h1')?.textContent?.trim(),
      railHeadings: sections.map((item) => item.querySelector('h2')?.textContent?.trim()),
      hasScheduledTask: section('Scheduled')?.textContent?.includes('Weekly project review'),
      hasContext: section('Context')?.textContent?.includes('atlas-workspace'),
      hasMemory: section('Memory')?.textContent?.includes('Enabled for this project'),
      hasConnectionsInRail: Boolean(rail?.querySelector('[aria-label="Project model and connections"]')),
      starPressed: document.querySelector('[aria-label="Remove project from favorites"]')?.getAttribute('aria-pressed'),
      overflow: page ? page.scrollWidth - page.clientWidth : 999
    };
  })()`);
  if (overview?.title !== 'Project Atlas') fail('Project title mismatch', overview);
  if (JSON.stringify(overview?.railHeadings) !== JSON.stringify(['Instructions', 'Scheduled', 'Context', 'Memory'])) fail('Project rail hierarchy mismatch', overview);
  if (!overview.hasScheduledTask || !overview.hasContext || !overview.hasMemory || overview.hasConnectionsInRail || overview.starPressed !== 'true' || overview.overflow > 1) fail('Project overview state mismatch', overview);
  console.log(`project-overview ${JSON.stringify(overview)}`);
  await screenshot(cdp, 'project-overview-dark');

  await evaluate(cdp, `(() => { const button = document.querySelector('[aria-label="Add scheduled task"]'); button?.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.lc-shell-project-modal input[placeholder="Weekly project review"]') !== null`, 'Scheduled task dialog');
  const modal = await evaluate(cdp, `(() => {
    const dialog = document.querySelector('.lc-shell-project-modal');
    const box = dialog?.getBoundingClientRect();
    return { title: dialog?.querySelector('h2')?.textContent?.trim(), left: box?.left, right: box?.right, width: innerWidth };
  })()`);
  if (modal?.title !== 'Schedule a task' || modal.left < 0 || modal.right > modal.width) fail('Scheduled task modal is out of bounds', modal);
  await screenshot(cdp, 'project-schedule-dialog-dark');
  await evaluate(cdp, `document.querySelector('.lc-shell-project-modal [aria-label="Close"]')?.click(); true`);

  await evaluate(cdp, `document.documentElement.dataset.lcTheme = 'light'; true`);
  await sleep(180);
  await screenshot(cdp, 'project-overview-light');

  await evaluate(cdp, `document.documentElement.dataset.lcTheme = 'dark'; true`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const narrow = await evaluate(cdp, `(() => {
    const page = document.querySelector('.project-detail-page');
    const layout = document.querySelector('.project-detail-layout');
    const rail = document.querySelector('.project-detail-panel');
    const layoutBox = layout?.getBoundingClientRect();
    const railBox = rail?.getBoundingClientRect();
    return {
      overflow: page ? page.scrollWidth - page.clientWidth : 999,
      railBelowMain: Boolean(layoutBox && railBox && railBox.top > layoutBox.top + 150)
    };
  })()`);
  if (narrow?.overflow > 1 || !narrow?.railBelowMain) fail('Narrow Project overview layout is invalid', narrow);
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
