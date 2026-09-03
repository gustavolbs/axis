import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'runtime-ui');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-runtime-ui-visual-'));
const debugPort = 9348;

fs.mkdirSync(outputDir, { recursive: true });

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_COMPANY_CONTEXT_PATH: path.join(fixtureDir, 'company-context.json'),
  LOCAL_CODER_CREDENTIALS_PATH: path.join(fixtureDir, 'credentials.json'),
  LOCAL_CODER_API_CONNECTION_ENDPOINTS_PATH: path.join(fixtureDir, 'api-endpoints.json'),
  LOCAL_CODER_CLAUDE_PROFILES_DIR: path.join(fixtureDir, 'claude-profiles'),
  LOCAL_CODER_CODEX_PROFILES_DIR: path.join(fixtureDir, 'codex-profiles'),
  LOCAL_CODER_PROFILE_NAME: 'Runtime UI Visual Smoke',
  LOCAL_CODER_PROJECTS_PATH: path.join(fixtureDir, 'projects.json'),
  LOCAL_CODER_RUN_STORE_PATH: path.join(fixtureDir, 'runs.json'),
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
    } catch {
      // Electron is still starting.
    }
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
      const response = JSON.parse(String(event.data));
      if (!response.id) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      response.error ? pending.reject(new Error(response.error.message)) : pending.resolve(response.result);
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

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`);
  return result.result?.value;
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression) === true) return;
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

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
}

async function setTheme(cdp, theme) {
  await evaluate(cdp, `(() => {
    localStorage.setItem('local-coder.theme', ${JSON.stringify(theme)});
    document.documentElement.dataset.lcTheme = ${JSON.stringify(theme)};
    return document.documentElement.dataset.lcTheme === ${JSON.stringify(theme)};
  })()`);
}

async function chooseScenario(cdp, scenario) {
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('[aria-label="Preview scenarios"] button')]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(scenario)});
    if (!button) throw new Error('Scenario button not found: ${scenario}');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, `document.querySelector('[data-runtime-ui-preview="${scenario}"]') !== null`, `${scenario} scenario`);
}

async function assertLayout(cdp, label) {
  const result = await evaluate(cdp, `(() => {
    const root = document.querySelector('[data-runtime-ui-preview]');
    if (!root) return { ok: false, reason: 'preview missing' };
    const interactive = [...root.querySelectorAll('button, textarea, [role="tab"], [role="tabpanel"]')];
    const invalid = interactive.filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return rect.right < 0 || rect.left > innerWidth;
    }).length;
    return {
      ok: root.scrollWidth <= root.clientWidth + 1 && invalid === 0,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      invalid
    };
  })()`);
  if (!result?.ok) throw new Error(`${label} layout contract failed: ${JSON.stringify(result)}`);
}

let cdp;
try {
  const page = await target();
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(cdp, "document.getElementById('root') !== null", 'Axis renderer root');

  await evaluate(cdp, `(() => {
    localStorage.setItem('local-coder.theme', 'light');
    const next = new URL(location.href);
    next.searchParams.set('runtime-ui-preview', 'active');
    location.href = next.href;
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('[data-runtime-ui-preview=\"active\"]') !== null", 'runtime UI preview');

  await setViewport(cdp, 1280, 900);
  await setTheme(cdp, 'light');
  await assertLayout(cdp, 'active light');
  await screenshot(cdp, 'runtime-active-light');

  const focused = await evaluate(cdp, `(() => {
    const option = document.querySelector('[aria-label="Decision options"] button');
    option?.focus();
    return document.activeElement === option;
  })()`);
  if (!focused) throw new Error('Decision option could not receive keyboard focus.');
  await screenshot(cdp, 'runtime-active-keyboard-focus-light');

  const tabMoved = await evaluate(cdp, `(() => {
    const first = document.querySelector('[role="tab"]');
    first?.focus();
    first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return document.activeElement?.getAttribute('role') === 'tab'
      && document.activeElement?.textContent?.includes('Shell')
      && document.activeElement?.getAttribute('aria-selected') === 'true';
  })()`);
  if (!tabMoved) throw new Error('Runtime pane keyboard navigation did not move focus and selection.');

  await setTheme(cdp, 'dark');
  await assertLayout(cdp, 'active dark');
  await screenshot(cdp, 'runtime-active-dark');

  await setViewport(cdp, 700, 840);
  await setTheme(cdp, 'light');
  await assertLayout(cdp, 'active narrow');
  await screenshot(cdp, 'runtime-active-narrow-light');

  await setViewport(cdp, 1280, 900);
  await chooseScenario(cdp, 'empty');
  await setTheme(cdp, 'light');
  await assertLayout(cdp, 'empty light');
  await screenshot(cdp, 'runtime-empty-light');

  await chooseScenario(cdp, 'resolved');
  await setTheme(cdp, 'light');
  await assertLayout(cdp, 'resolved light');
  await screenshot(cdp, 'runtime-resolved-light');

  await chooseScenario(cdp, 'failure');
  await setTheme(cdp, 'dark');
  await assertLayout(cdp, 'failure dark');
  await screenshot(cdp, 'runtime-failure-dark');

  await chooseScenario(cdp, 'active');
  const controlsFound = await evaluate(cdp, `(() => {
    const allow = [...document.querySelectorAll('[aria-label="Approval actions"] button')]
      .find((candidate) => candidate.textContent?.includes('Allow'));
    const option = [...document.querySelectorAll('[aria-label="Decision options"] button')]
      .find((candidate) => candidate.textContent?.includes('Review first'));
    if (!allow || !option) return false;
    allow.click();
    option.click();
    return true;
  })()`);
  if (!controlsFound) throw new Error('Approval/decision fixture controls were not found.');
  await waitFor(cdp, `(() => {
    const status = document.querySelector('.decision-picker-echo')?.textContent ?? '';
    return status.includes('Permission allowed') && status.includes('review');
  })()`, 'approval and decision resolution');
  await setTheme(cdp, 'light');
  await screenshot(cdp, 'runtime-decision-resolution-light');
} finally {
  cdp?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(4000)
  ]);
  if (!child.killed) child.kill('SIGKILL');
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
