import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';
import { ClaudeAccountProfileStore } from '../dist/claude-account-profiles.js';
import { CodexAccountProfileStore } from '../dist/codex-account-profiles.js';
import { CompanyContextStore, PERSONAL_COMPANY_ID } from '../dist/company-context.js';
import { CredentialManager, CredentialProfileStore } from '../dist/credential-store.js';
import {
  apiCredentialConnectionId,
  chatGptAccountConnectionId,
  claudeAccountConnectionId
} from '../dist/provider-connections.js';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'connections');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-connections-visual-'));
const companyContextFile = path.join(fixtureDir, 'company-context.json');
const credentialsFile = path.join(fixtureDir, 'credentials.json');
const claudeProfilesRoot = path.join(fixtureDir, 'claude-profiles');
const codexProfilesRoot = path.join(fixtureDir, 'codex-profiles');
const debugPort = 9339;

fs.mkdirSync(outputDir, { recursive: true });

const companies = new CompanyContextStore(companyContextFile);
const acme = companies.createCompany({
  name: 'Acme Engineering',
  description: 'Product engineering',
  color: '#2563EB',
  icon: 'code-2'
});
const northstar = companies.createCompany({
  name: 'Northstar Health',
  description: 'Clinical platform',
  color: '#16A34A',
  icon: 'heart-pulse'
});

const credentials = new CredentialManager(new CredentialProfileStore(credentialsFile));
credentials.addEnvironmentCredential({
  id: 'openai-product-a',
  providerId: 'openai',
  label: 'OpenAI Product A',
  organizationId: acme.id,
  environmentVariable: 'AXIS_VISUAL_OPENAI_A'
});
credentials.addEnvironmentCredential({
  id: 'openai-product-b',
  providerId: 'openai',
  label: 'OpenAI Product B',
  organizationId: acme.id,
  environmentVariable: 'AXIS_VISUAL_OPENAI_B'
});
credentials.addEnvironmentCredential({
  id: 'anthropic-health',
  providerId: 'anthropic',
  label: 'Anthropic Health',
  organizationId: northstar.id,
  environmentVariable: 'AXIS_VISUAL_ANTHROPIC'
});

const claudeProfiles = new ClaudeAccountProfileStore(claudeProfilesRoot);
claudeProfiles.create({
  id: 'claude-acme',
  name: 'Claude Acme',
  organizationLabel: 'Acme Engineering'
});
const codexProfiles = new CodexAccountProfileStore(codexProfilesRoot);
codexProfiles.create({
  id: 'chatgpt-personal',
  name: 'ChatGPT Personal'
});

companies.reconcile({
  projects: [],
  sessions: [],
  connections: [
    {
      id: apiCredentialConnectionId('openai', 'openai-product-a'),
      label: 'OpenAI Product A',
      auth: 'api-key',
      companyId: acme.id
    },
    {
      id: apiCredentialConnectionId('openai', 'openai-product-b'),
      label: 'OpenAI Product B',
      auth: 'api-key',
      companyId: acme.id
    },
    {
      id: apiCredentialConnectionId('anthropic', 'anthropic-health'),
      label: 'Anthropic Health',
      auth: 'api-key',
      companyId: northstar.id
    },
    {
      id: claudeAccountConnectionId('claude-acme'),
      label: 'Claude Acme',
      auth: 'claude-account',
      companyId: acme.id,
      organizationLabel: 'Acme Engineering'
    },
    {
      id: chatGptAccountConnectionId('chatgpt-personal'),
      label: 'ChatGPT Personal',
      auth: 'chatgpt-account',
      companyId: PERSONAL_COMPANY_ID
    }
  ]
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_COMPANY_CONTEXT_PATH: companyContextFile,
  LOCAL_CODER_CREDENTIALS_PATH: credentialsFile,
  LOCAL_CODER_CLAUDE_PROFILES_DIR: claudeProfilesRoot,
  LOCAL_CODER_CODEX_PROFILES_DIR: codexProfilesRoot,
  LOCAL_CODER_PROFILE_NAME: 'Connection Visual Smoke',
  LOCAL_CODER_PROJECTS_PATH: path.join(fixtureDir, 'projects.json'),
  LOCAL_CODER_RUN_STORE_PATH: path.join(fixtureDir, 'runs.json'),
  LOCAL_CODER_REMOTE_WORKER_URL: 'http://127.0.0.1:65534',
  AXIS_VISUAL_OPENAI_A: 'visual-openai-a',
  AXIS_VISUAL_OPENAI_B: 'visual-openai-b',
  AXIS_VISUAL_ANTHROPIC: 'visual-anthropic'
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
    const result = await evaluate(cdp, expression);
    if (result === true) return;
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
  await waitFor(cdp, "document.querySelector('.connection-center-settings h1')?.textContent === 'Connections'", 'Connection Center');
  await waitFor(cdp, "document.querySelectorAll('.connection-center-card').length === 5", 'five connection fixtures');

  const inventory = await evaluate(cdp, `(async () => {
    const root = document.querySelector('.connection-center-settings');
    const text = root?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
    const cards = [...document.querySelectorAll('.connection-center-card')];
    const rawConnections = await window.lc.providerConnections();
    return {
      cardCount: cards.length,
      cardTexts: cards.map((card) => card.textContent?.replace(/\\s+/g, ' ').trim() ?? ''),
      rawConnections: rawConnections.map((connection) => ({
        label: connection.label,
        auth: connection.auth,
        organizationId: connection.organizationId,
        organizationLabel: connection.organizationLabel,
        companyId: connection.companyId,
        companyName: connection.companyName
      })),
      hasAcme: text.includes('Company: Acme Engineering'),
      hasNorthstar: text.includes('Company: Northstar Health'),
      hasPersonal: text.includes('Company: Personal'),
      openAiCount: cards.filter((card) => card.textContent?.includes('OpenAI')).length,
      apiKeyCount: cards.filter((card) => card.textContent?.includes('API Key')).length,
      bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      cardsOverflow: cards.some((card) => card.scrollWidth > card.clientWidth + 1)
    };
  })()`);
  console.log(`inventory ${JSON.stringify(inventory)}`);
  await screenshot(cdp, 'inventory-light-wide');
  if (!inventory || inventory.cardCount !== 5 || !inventory.hasAcme || !inventory.hasNorthstar || !inventory.hasPersonal || inventory.openAiCount < 2 || inventory.apiKeyCount !== 3 || inventory.bodyOverflow || inventory.cardsOverflow) {
    throw new Error(`Connection inventory contract failed: ${JSON.stringify(inventory)}`);
  }

  await evaluate(cdp, "document.documentElement.dataset.lcTheme = 'dark'; true");
  await sleep(100);
  await screenshot(cdp, 'inventory-dark-wide');

  await evaluate(cdp, "document.documentElement.dataset.lcTheme = 'light'; true");
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 760,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(150);
  const narrow = await evaluate(cdp, `(() => ({
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    cardsOverflow: [...document.querySelectorAll('.connection-center-card')]
      .some((card) => card.scrollWidth > card.clientWidth + 1)
  }))()`);
  if (!narrow || narrow.bodyOverflow || narrow.cardsOverflow) {
    throw new Error(`Connection Center narrow layout overflows: ${JSON.stringify(narrow)}`);
  }
  await screenshot(cdp, 'inventory-light-narrow');
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.connection-center-settings > header button')]
      .find((item) => item.textContent?.includes('Add connection'));
    if (!button) throw new Error('Add connection button not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('.connection-center-settings .connection-create-dialog') !== null", 'add connection dialog');
  const dialog = await evaluate(cdp, `(() => {
    const form = document.querySelector('.connection-center-settings .connection-create-dialog');
    const rect = form?.getBoundingClientRect();
    const text = form?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
    return {
      visible: Boolean(rect && rect.width > 0 && rect.height > 0),
      withinViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight),
      hasCompany: text.includes('Company'),
      hasAuthentication: text.includes('Authentication')
    };
  })()`);
  if (!dialog?.visible || !dialog.withinViewport || !dialog.hasCompany || !dialog.hasAuthentication) {
    throw new Error(`Add connection dialog contract failed: ${JSON.stringify(dialog)}`);
  }
  await screenshot(cdp, 'add-connection-dialog');
  await evaluate(cdp, `(() => {
    const cancel = [...document.querySelectorAll('.connection-center-settings .connection-create-dialog button')]
      .find((item) => item.textContent?.trim() === 'Cancel');
    cancel?.click();
    return true;
  })()`);

  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.connection-center-settings > .connections-surface-tabs button')]
      .find((item) => item.textContent?.includes('Connectors'));
    if (!button) throw new Error('Connectors tab not found');
    button.click();
    return true;
  })()`);
  await waitFor(cdp, "document.querySelector('.connection-center-connectors') !== null", 'embedded connectors panel');
  const connectorComposition = await evaluate(cdp, `(() => ({
    connectionHeadings: [...document.querySelectorAll('.connection-center-settings h1')]
      .filter((node) => node.textContent?.trim() === 'Connections').length,
    surfaceTabs: document.querySelectorAll('.connection-center-settings > .connections-surface-tabs').length,
    nestedSettingsPage: Boolean(document.querySelector('.connection-center-legacy-connectors .focused-settings-page')),
    hasSearch: Boolean(document.querySelector('.connection-center-connectors input[aria-label="Search connectors"]')),
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }))()`);
  if (!connectorComposition || connectorComposition.connectionHeadings !== 1 || connectorComposition.surfaceTabs !== 1 || connectorComposition.nestedSettingsPage || !connectorComposition.hasSearch || connectorComposition.bodyOverflow) {
    throw new Error(`Embedded Connectors composition failed: ${JSON.stringify(connectorComposition)}`);
  }
  console.log(`connectors ${JSON.stringify(connectorComposition)}`);
  await screenshot(cdp, 'connectors-light-wide');
} finally {
  cdp?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => child.kill('SIGKILL'))
  ]);
}
