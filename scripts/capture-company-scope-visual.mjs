import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';
import { CompanyContextStore } from '../dist/company-context.js';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'companies');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-company-scope-visual-'));
const companyContextFile = path.join(fixtureDir, 'company-context.json');
const runStorePath = path.join(fixtureDir, 'runs.json');
const debugPort = 9341;
const now = new Date().toISOString();

fs.mkdirSync(outputDir, { recursive: true });

const store = new CompanyContextStore(companyContextFile);
const acme = store.createCompany({
  name: 'Acme Engineering',
  description: 'Product engineering and developer experience',
  color: '#2563EB',
  icon: 'code-2'
});
const northstar = store.createCompany({
  name: 'Northstar Health',
  description: 'Clinical platform and operations',
  color: '#16A34A',
  icon: 'heart-pulse'
});

const sessionDir = path.join(path.dirname(runStorePath), 'sessions');
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, 'jobs.json'), `${JSON.stringify([{
  id: 'visual-result-job',
  status: 'success',
  createdAt: now,
  updatedAt: now,
  title: 'Visual result',
  input: {
    companyId: 'personal',
    workspace: '',
    goal: 'Show a completed result',
    interactionMode: 'chat',
    reasoningEffort: 'auto',
    modelSelection: { mode: 'explicit', providerId: 'ollama', modelId: 'visual-model' }
  },
  turns: [
    { id: 'turn-user', role: 'user', content: 'Show a completed result', createdAt: now },
    { id: 'turn-assistant', role: 'assistant', content: 'Completed result for Company scope visual verification.', createdAt: now }
  ],
  activityHistory: [],
  rounds: 1,
  events: []
}], null, 2)}\n`);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_COMPANY_CONTEXT_PATH: companyContextFile,
  LOCAL_CODER_SETTINGS_PATH: path.join(fixtureDir, 'settings.json'),
  LOCAL_CODER_PROFILE_NAME: 'Visual Smoke',
  LOCAL_CODER_PROJECTS_PATH: path.join(fixtureDir, 'projects.json'),
  LOCAL_CODER_CREDENTIALS_PATH: path.join(fixtureDir, 'credentials.json'),
  LOCAL_CODER_RUN_STORE_PATH: runStorePath,
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
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  });
  const targetPath = path.join(outputDir, `${name}.png`);
  fs.writeFileSync(targetPath, Buffer.from(result.data, 'base64'));
  console.log(`captured ${path.relative(root, targetPath)}`);
}

async function assertContextRow(cdp, companyId, expectedName) {
  const state = await evaluate(cdp, `(() => {
    const row = document.querySelector('.lc-shell-company-row[data-company-id="${companyId}"]');
    const rect = row?.getBoundingClientRect();
    const icon = row?.querySelector('.lc-shell-company-icon svg');
    return {
      exists: Boolean(row),
      text: row?.textContent?.replace(/\\s+/g, ' ').trim(),
      hasIcon: Boolean(icon),
      active: row?.classList.contains('active') ?? false,
      visible: Boolean(rect && rect.width > 0 && rect.height > 0)
    };
  })()`);
  if (!state?.exists || !state.visible || !state.hasIcon || !state.text?.includes(expectedName)) {
    throw new Error(`Context row ${companyId} is invalid: ${JSON.stringify(state)}`);
  }
  return state;
}

async function activeCompany(cdp) {
  return await evaluate(cdp, `(async () => {
    const response = await fetch('/api/companies/active', { headers: { accept: 'application/json' } });
    const payload = await response.json();
    return payload.scope?.activeCompanyId;
  })()`);
}

let cdp;
try {
  const page = await target();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(cdp, `document.querySelector('.lc-shell-sidebar') !== null`, 'Axis shell');
  await waitFor(cdp, `document.querySelectorAll('.lc-shell-company-row').length >= 3`, 'Context rows');

  const duplicateSelectors = await evaluate(cdp, `document.querySelectorAll('.axis-company-scope').length`);
  if (duplicateSelectors !== 0) throw new Error(`Unexpected duplicate Company selectors: ${duplicateSelectors}`);

  const personalState = await assertContextRow(cdp, 'personal', 'Personal');
  await assertContextRow(cdp, acme.id, 'Acme Engineering');
  await assertContextRow(cdp, northstar.id, 'Northstar Health');
  if (!personalState.active) throw new Error('Personal should be the selected Context on first launch.');
  if (await activeCompany(cdp) !== 'personal') throw new Error('Sidebar and runtime Company scope are not synchronized.');
  await screenshot(cdp, 'company-contexts-expanded');

  await evaluate(cdp, `document.querySelector('.lc-shell-company-row[data-company-id="${acme.id}"]')?.click(); true`);
  await waitFor(cdp, `document.querySelector('.lc-shell-company-row[data-company-id="${acme.id}"]')?.classList.contains('active') === true`, 'Acme Context selection');
  await waitFor(cdp, `(async () => (await (await fetch('/api/companies/active')).json()).scope?.activeCompanyId === '${acme.id}')()`, 'canonical Acme runtime scope');
  await screenshot(cdp, 'company-contexts-acme');

  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.lc-shell-primary-nav button')]
      .find((item) => item.getAttribute('aria-label') === 'New chat' || item.textContent?.trim() === 'New chat');
    if (!button) throw new Error('New chat button not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, `document.querySelector('.lc-shell-company-row[data-company-id="personal"]')?.classList.contains('active') === true`, 'Personal Context after New Chat');
  if (await activeCompany(cdp) !== 'personal') throw new Error('New Chat must be projectless Personal scope.');
  if (await evaluate(cdp, `document.querySelectorAll('.axis-company-scope').length`) !== 0) throw new Error('New Chat exposed a duplicate Company selector.');
  await screenshot(cdp, 'company-context-new-chat');

  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent?.includes('Visual result'));
    if (!button) throw new Error('Visual result sidebar item not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, `document.body.textContent?.includes('Completed result for Company scope visual verification.')`, 'completed result');
  if (await evaluate(cdp, `document.querySelectorAll('.axis-company-scope').length`) !== 0) throw new Error('Completed result exposed a duplicate Company selector.');
  await screenshot(cdp, 'company-context-result');
} finally {
  cdp?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => child.kill('SIGKILL'))
  ]);
}
