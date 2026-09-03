import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';
import { CompanyContextStore } from '../dist/company-context.js';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'companies');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-companies-visual-'));
const companyContextFile = path.join(fixtureDir, 'company-context.json');
const debugPort = 9337;

fs.mkdirSync(outputDir, { recursive: true });

const store = new CompanyContextStore(companyContextFile);
store.createCompany({
  name: 'Acme Engineering',
  description: 'Product engineering and developer experience',
  color: '#2563EB',
  icon: 'code-2'
});
store.createCompany({
  name: 'Northstar Health',
  description: 'Clinical platform and operations',
  color: '#16A34A',
  icon: 'heart-pulse'
});
store.createCompany({
  name: 'Orbit Labs',
  description: 'AI research and product prototypes',
  color: '#7C3AED',
  icon: 'rocket'
});
const archived = store.createCompany({
  name: 'Legacy Studio',
  description: 'Archived client context',
  color: '#EA580C',
  icon: 'palette'
});
store.setCompanyArchived(archived.id, true);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_COMPANY_CONTEXT_PATH: companyContextFile,
  LOCAL_CODER_PROFILE_NAME: 'Visual Smoke',
  LOCAL_CODER_PROJECTS_PATH: path.join(fixtureDir, 'projects.json'),
  LOCAL_CODER_CREDENTIALS_PATH: path.join(fixtureDir, 'credentials.json'),
  LOCAL_CODER_RUN_STORE_PATH: path.join(fixtureDir, 'runs.json')
});

const child = spawn(electronPath, [`--remote-debugging-port=${debugPort}`, 'desktop/main.mjs'], {
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
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && String(item.url).includes('app-dist/index.html'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Electron renderer did not expose a CDP target. ${lastError ? String(lastError) : ''}\n${logs}`);
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

  close() {
    this.socket.close();
  }
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.result?.value === true) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}.\n${logs}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`);
  }
  return result.result?.value;
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

let cdp;
try {
  const page = await target();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(cdp, "document.querySelector('.lc-shell-sidebar') !== null", 'Axis shell');

  await evaluate(cdp, "window.dispatchEvent(new CustomEvent('local-coder:open-settings')); true");
  await waitFor(cdp, "document.querySelector('.settings-modal') !== null", 'Settings modal');
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.settings-rail button')]
      .find((item) => item.textContent?.trim() === 'Companies');
    if (!button) throw new Error('Companies settings tab not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('.connections-settings-page h1')?.textContent === 'Companies'", 'Companies settings');
  await waitFor(cdp, "document.querySelectorAll('.connection-card').length === 3", 'active company cards');

  const wideLayout = await evaluate(cdp, `(() => {
    const page = document.querySelector('.connections-settings-page');
    const cards = [...document.querySelectorAll('.connection-card')];
    return {
      viewport: [window.innerWidth, window.innerHeight],
      page: page ? [page.getBoundingClientRect().width, page.scrollWidth] : null,
      cards: cards.map((card) => [card.getBoundingClientRect().width, card.scrollWidth]),
      bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      text: document.querySelector('.settings-content')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 1000)
    };
  })()`);
  if (!wideLayout || wideLayout.bodyOverflow || wideLayout.page?.[1] > wideLayout.page?.[0] + 1 || wideLayout.cards.some(([width, scroll]) => scroll > width + 1)) {
    throw new Error(`Companies wide layout overflows: ${JSON.stringify(wideLayout)}`);
  }
  console.log(`wide-layout ${JSON.stringify(wideLayout)}`);
  await screenshot(cdp, 'active-light-wide');

  await evaluate(cdp, "document.documentElement.dataset.lcTheme = 'dark'; true");
  await sleep(100);
  await screenshot(cdp, 'active-dark-wide');

  await evaluate(cdp, "document.documentElement.dataset.lcTheme = 'light'; true");
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(150);
  const narrowLayout = await evaluate(cdp, `(() => ({
    viewport: [window.innerWidth, window.innerHeight],
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    actionsWrapped: [...document.querySelectorAll('.connection-actions')]
      .every((actions) => actions.getBoundingClientRect().right <= document.documentElement.clientWidth + 1)
  }))()`);
  if (!narrowLayout || narrowLayout.bodyOverflow || !narrowLayout.actionsWrapped) {
    throw new Error(`Companies narrow layout overflows: ${JSON.stringify(narrowLayout)}`);
  }
  console.log(`narrow-layout ${JSON.stringify(narrowLayout)}`);
  await screenshot(cdp, 'active-light-narrow');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent?.trim() === 'Add company');
    if (!button) throw new Error('Add company button not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('.connection-create-dialog') !== null", 'company editor dialog');
  const dialogLayout = await evaluate(cdp, `(() => {
    const dialog = document.querySelector('.connection-create-dialog');
    const rect = dialog?.getBoundingClientRect();
    return {
      visible: Boolean(rect && rect.width > 0 && rect.height > 0),
      withinViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight),
      text: dialog?.textContent?.replace(/\s+/g, ' ').trim()
    };
  })()`);
  if (!dialogLayout?.visible || !dialogLayout.withinViewport) {
    throw new Error(`Company editor dialog is outside the viewport: ${JSON.stringify(dialogLayout)}`);
  }
  console.log(`dialog-layout ${JSON.stringify(dialogLayout)}`);
  await screenshot(cdp, 'create-company-dialog');
} finally {
  cdp?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => child.kill('SIGKILL'))
  ]);
}
