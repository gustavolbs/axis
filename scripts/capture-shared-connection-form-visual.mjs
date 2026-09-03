import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'connections');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-shared-connection-form-'));
const debugPort = 9341;

fs.mkdirSync(outputDir, { recursive: true });

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_COMPANY_CONTEXT_PATH: path.join(fixtureDir, 'company-context.json'),
  LOCAL_CODER_CREDENTIALS_PATH: path.join(fixtureDir, 'credentials.json'),
  LOCAL_CODER_API_CONNECTION_ENDPOINTS_PATH: path.join(fixtureDir, 'api-endpoints.json'),
  LOCAL_CODER_CLAUDE_PROFILES_DIR: path.join(fixtureDir, 'claude-profiles'),
  LOCAL_CODER_CODEX_PROFILES_DIR: path.join(fixtureDir, 'codex-profiles'),
  LOCAL_CODER_PROVIDER_SETTINGS_PATH: path.join(fixtureDir, 'providers.json'),
  LOCAL_CODER_PROFILE_NAME: 'Shared Connection Form Smoke',
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
      const response = JSON.parse(String(event.data));
      if (!response.id) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
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
    if (await evaluate(cdp, expression) === true) return;
    await sleep(150);
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

async function chooseAuth(cdp, label) {
  await evaluate(cdp, `(() => {
    const trigger = document.querySelector('button[aria-label="Connection authentication"]');
    if (!trigger) throw new Error('Authentication selector not found');
    trigger.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('[role=\"listbox\"][aria-label=\"Connection authentication\"]') !== null", 'authentication options');
  await evaluate(cdp, `(() => {
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((item) => item.textContent?.includes(${JSON.stringify(label)}));
    if (!option) throw new Error(${JSON.stringify(`${label} option not found`)});
    option.click();
    return true;
  })()`);
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
      .find((item) => item.textContent?.trim() === 'Connections');
    if (!button) throw new Error('Connections settings tab not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('.connection-center-settings h1')?.textContent === 'Connections'", 'Connection Center');
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.connection-center-settings > header button')]
      .find((item) => item.textContent?.includes('Add connection'));
    if (!button) throw new Error('Add connection button not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('.connection-create-dialog') !== null", 'shared connection form');

  const accountInitial = await evaluate(cdp, `(() => {
    const form = document.querySelector('.connection-create-dialog');
    if (!form) throw new Error('Shared form missing');
    form.dataset.sharedFormProbe = 'preserve-me';
    const labels = [...form.querySelectorAll('label')];
    const inputFor = (label) => labels.find((item) => item.querySelector(':scope > span')?.textContent?.trim() === label)?.querySelector('input');
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const id = inputFor('Profile ID');
    const name = inputFor('Name');
    if (!id || !name) throw new Error('Account base inputs missing');
    setValue(id, 'shared-identity');
    setValue(name, 'Shared Product Identity');
    return {
      formCount: document.querySelectorAll('.connection-create-dialog').length,
      auth: document.querySelector('button[aria-label="Connection authentication"]')?.textContent?.trim(),
      company: document.querySelector('button[aria-label="Connection Company"]')?.textContent?.trim(),
      endpointCount: form.querySelectorAll('input[type="url"]').length,
      secretCount: form.querySelectorAll('input[type="password"]').length
    };
  })()`);
  await sleep(100);
  if (!accountInitial || accountInitial.formCount !== 1 || !accountInitial.auth?.includes('Claude account') || accountInitial.endpointCount !== 0 || accountInitial.secretCount !== 0) {
    throw new Error(`Initial Account form contract failed: ${JSON.stringify(accountInitial)}`);
  }
  await screenshot(cdp, 'shared-form-account');

  await chooseAuth(cdp, 'OpenAI API key');
  await waitFor(cdp, "document.querySelector('.connection-create-dialog input[type=\"url\"]') !== null", 'API-specific fields');
  const apiState = await evaluate(cdp, `(() => {
    const form = document.querySelector('.connection-create-dialog');
    const labels = [...form.querySelectorAll('label')];
    const inputForPrefix = (label) => labels.find((item) => item.querySelector(':scope > span')?.textContent?.trim().startsWith(label))?.querySelector('input');
    return {
      sameForm: form?.dataset.sharedFormProbe === 'preserve-me',
      formCount: document.querySelectorAll('.connection-create-dialog').length,
      idLabel: labels.find((item) => item.querySelector(':scope > span')?.textContent?.trim() === 'Credential ID')?.querySelector(':scope > span')?.textContent?.trim(),
      idValue: inputForPrefix('Credential ID')?.value,
      nameValue: inputForPrefix('Name')?.value,
      company: document.querySelector('button[aria-label="Connection Company"]')?.textContent?.trim(),
      auth: document.querySelector('button[aria-label="Connection authentication"]')?.textContent?.trim(),
      endpointCount: form?.querySelectorAll('input[type="url"]').length,
      secretCount: form?.querySelectorAll('input[type="password"]').length
    };
  })()`);
  if (!apiState || !apiState.sameForm || apiState.formCount !== 1 || apiState.idLabel !== 'Credential ID' || apiState.idValue !== 'shared-identity' || apiState.nameValue !== 'Shared Product Identity' || apiState.company !== accountInitial.company || !apiState.auth?.includes('OpenAI API key') || apiState.endpointCount !== 1 || apiState.secretCount !== 1) {
    throw new Error(`API-key shared form contract failed: ${JSON.stringify(apiState)}`);
  }
  console.log(`shared-api-state ${JSON.stringify(apiState)}`);
  await screenshot(cdp, 'shared-form-api-key');

  await chooseAuth(cdp, 'Claude account');
  await waitFor(cdp, "document.querySelector('.connection-create-dialog input[type=\"url\"]') === null", 'Account-specific field restoration');
  const accountRestored = await evaluate(cdp, `(() => {
    const form = document.querySelector('.connection-create-dialog');
    const labels = [...form.querySelectorAll('label')];
    const inputFor = (label) => labels.find((item) => item.querySelector(':scope > span')?.textContent?.trim() === label)?.querySelector('input');
    return {
      sameForm: form?.dataset.sharedFormProbe === 'preserve-me',
      formCount: document.querySelectorAll('.connection-create-dialog').length,
      idValue: inputFor('Profile ID')?.value,
      nameValue: inputFor('Name')?.value,
      company: document.querySelector('button[aria-label="Connection Company"]')?.textContent?.trim(),
      endpointCount: form?.querySelectorAll('input[type="url"]').length,
      secretCount: form?.querySelectorAll('input[type="password"]').length
    };
  })()`);
  if (!accountRestored || !accountRestored.sameForm || accountRestored.formCount !== 1 || accountRestored.idValue !== 'shared-identity' || accountRestored.nameValue !== 'Shared Product Identity' || accountRestored.company !== accountInitial.company || accountRestored.endpointCount !== 0 || accountRestored.secretCount !== 0) {
    throw new Error(`Restored Account shared form contract failed: ${JSON.stringify(accountRestored)}`);
  }
  console.log(`shared-account-restored ${JSON.stringify(accountRestored)}`);
  await screenshot(cdp, 'shared-form-account-restored');
} finally {
  cdp?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => child.kill('SIGKILL'))
  ]);
}
