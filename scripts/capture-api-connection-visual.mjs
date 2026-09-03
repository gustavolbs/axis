import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';
import { ApiConnectionEndpointStore } from '../dist/api-connection-endpoints.js';
import { CredentialManager, CredentialProfileStore } from '../dist/credential-store.js';
import { apiCredentialConnectionId } from '../dist/provider-connections.js';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'connections');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-api-connection-visual-'));
const credentialsFile = path.join(fixtureDir, 'credentials.json');
const endpointsFile = path.join(fixtureDir, 'api-endpoints.json');
const debugPort = 9340;
const secretEnv = 'AXIS_VISUAL_CUSTOM_ENDPOINT_KEY';

fs.mkdirSync(outputDir, { recursive: true });

const credentials = new CredentialManager(new CredentialProfileStore(credentialsFile));
credentials.addEnvironmentCredential({
  id: 'openai-gateway',
  providerId: 'openai',
  label: 'OpenAI Gateway',
  environmentVariable: secretEnv
});
const connectionId = apiCredentialConnectionId('openai', 'openai-gateway');
new ApiConnectionEndpointStore(endpointsFile).upsert({
  connectionId,
  providerFamily: 'openai',
  credentialId: 'openai-gateway',
  endpoint: 'https://gateway.example/v1/'
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_COMPANY_CONTEXT_PATH: path.join(fixtureDir, 'company-context.json'),
  LOCAL_CODER_CREDENTIALS_PATH: credentialsFile,
  LOCAL_CODER_API_CONNECTION_ENDPOINTS_PATH: endpointsFile,
  LOCAL_CODER_CLAUDE_PROFILES_DIR: path.join(fixtureDir, 'claude-profiles'),
  LOCAL_CODER_CODEX_PROFILES_DIR: path.join(fixtureDir, 'codex-profiles'),
  LOCAL_CODER_PROFILE_NAME: 'API Connection Visual Smoke',
  LOCAL_CODER_PROJECTS_PATH: path.join(fixtureDir, 'projects.json'),
  LOCAL_CODER_RUN_STORE_PATH: path.join(fixtureDir, 'runs.json'),
  LOCAL_CODER_REMOTE_WORKER_URL: 'http://127.0.0.1:65534',
  [secretEnv]: 'visual-custom-endpoint-key'
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
  await waitFor(cdp, "document.querySelectorAll('.connection-center-card').length === 1", 'single API connection');

  const inventory = await evaluate(cdp, `(async () => {
    const card = document.querySelector('.connection-center-card');
    const raw = await window.lc.providerConnections();
    const text = card?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
    return {
      cardCount: document.querySelectorAll('.connection-center-card').length,
      text,
      rawCount: raw.length,
      auth: raw[0]?.auth,
      endpoint: raw[0]?.endpoint,
      hasCustomEndpoint: text.includes('Custom endpoint: https://gateway.example/v1'),
      hasPersonal: text.includes('Company: Personal'),
      hasOtherCloudIdentity: raw.some((connection) => connection.auth === 'claude-account' || connection.auth === 'chatgpt-account')
    };
  })()`);
  if (!inventory || inventory.cardCount !== 1 || inventory.rawCount !== 1 || inventory.auth !== 'api-key' || inventory.endpoint !== 'https://gateway.example/v1' || !inventory.hasCustomEndpoint || !inventory.hasPersonal || inventory.hasOtherCloudIdentity) {
    throw new Error(`Custom API connection inventory failed: ${JSON.stringify(inventory)}`);
  }
  console.log(`api-inventory ${JSON.stringify(inventory)}`);
  await screenshot(cdp, 'api-custom-endpoint-inventory');

  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.connection-center-settings > header button')]
      .find((item) => item.textContent?.includes('Add connection'));
    if (!button) throw new Error('Add connection button not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('.connection-create-dialog') !== null", 'Add connection dialog');
  await evaluate(cdp, `(() => {
    const trigger = document.querySelector('button[aria-label="Connection authentication"]');
    if (!trigger) throw new Error('Authentication selector not found');
    trigger.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('[role=\"listbox\"][aria-label=\"Connection authentication\"]') !== null", 'authentication options');
  await evaluate(cdp, `(() => {
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((item) => item.textContent?.includes('OpenAI API key'));
    if (!option) throw new Error('OpenAI API key option not found');
    option.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('.connection-create-dialog input[type=\"url\"]') !== null", 'API endpoint field');

  const form = await evaluate(cdp, `(() => {
    const dialog = document.querySelector('.connection-create-dialog');
    const rect = dialog?.getBoundingClientRect();
    const endpoint = dialog?.querySelector('input[type="url"]');
    const key = dialog?.querySelector('input[type="password"]');
    const actions = dialog?.querySelector('.nested-settings-dialog-actions');
    actions?.scrollIntoView({ block: 'end' });
    const actionsRect = actions?.getBoundingClientRect();
    const buttons = [...(actions?.querySelectorAll('button') ?? [])];
    return {
      withinViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight),
      endpointPlaceholder: endpoint?.getAttribute('placeholder'),
      hasApiKey: Boolean(key),
      actionsReachable: Boolean(
        rect && actionsRect &&
        actionsRect.top >= rect.top && actionsRect.bottom <= rect.bottom &&
        buttons.some((button) => button.textContent?.trim() === 'Cancel') &&
        buttons.some((button) => button.textContent?.trim() === 'Create connection')
      ),
      scrolled: Boolean(dialog && dialog.scrollTop > 0),
      text: dialog?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
    };
  })()`);
  if (!form?.withinViewport || form.endpointPlaceholder !== 'https://api.openai.com/v1' || !form.hasApiKey || !form.actionsReachable || !form.text.includes('Endpoint optional')) {
    throw new Error(`API connection form contract failed: ${JSON.stringify(form)}`);
  }
  console.log(`api-form ${JSON.stringify(form)}`);
  await screenshot(cdp, 'add-api-connection-dialog');
} finally {
  cdp?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => child.kill('SIGKILL'))
  ]);
}
