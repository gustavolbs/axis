import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';
import { ClaudeAccountProfileStore } from '../dist/claude-account-profiles.js';
import { CompanyContextStore } from '../dist/company-context.js';
import { claudeAccountConnectionId } from '../dist/provider-connections.js';
import { WorkHubSourceStore } from '../dist/work-hub.js';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'companies');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-company-hub-visual-'));
const companyContextFile = path.join(fixtureDir, 'company-context.json');
const claudeProfilesDir = path.join(fixtureDir, 'claude-profiles');
const workHubDir = path.join(fixtureDir, 'work-hub');
const debugPort = 9337;
const now = new Date().toISOString();

fs.mkdirSync(outputDir, { recursive: true });

const companies = new CompanyContextStore(companyContextFile);
const acme = companies.createCompany({
  name: 'Acme Engineering',
  description: 'Product engineering and developer experience',
  color: '#2563EB',
  icon: 'code-2'
});
companies.createCompany({
  name: 'Northstar Health',
  description: 'Clinical platform and operations',
  color: '#16A34A',
  icon: 'heart-pulse'
});

const profiles = new ClaudeAccountProfileStore(claudeProfilesDir);
profiles.create({ id: 'acme', name: 'Claude Acme' });
profiles.create({ id: 'personal', name: 'Claude Personal' });
const acmeConnectionId = claudeAccountConnectionId('acme');
const personalConnectionId = claudeAccountConnectionId('personal');

// Bind fixture connections explicitly to canonical Company ids before Electron
// starts. Mutable provider/account labels are never used as the ownership key.
companies.reconcile({
  projects: [],
  sessions: [],
  connections: [
    { id: acmeConnectionId, label: 'Claude Acme', auth: 'claude-account', companyId: acme.id },
    { id: personalConnectionId, label: 'Claude Personal', auth: 'claude-account', companyId: 'personal' }
  ]
});

const workHub = new WorkHubSourceStore(workHubDir);
const acmeSource = workHub.upsert({
  id: 'acme-jira',
  label: 'Claude Acme · My Work',
  connectionId: acmeConnectionId,
  kind: 'tickets',
  system: 'Jira',
  retention: 'local'
});
const personalSource = workHub.upsert({
  id: 'personal-inbox',
  label: 'Claude Personal · Inbox',
  connectionId: personalConnectionId,
  kind: 'messages',
  system: 'Slack',
  retention: 'local'
});
workHub.writeStates([
  { sourceId: acmeSource.id, status: 'ready', lastSyncedAt: now, itemCount: 1, systems: ['Jira'] },
  { sourceId: personalSource.id, status: 'ready', lastSyncedAt: now, itemCount: 1, systems: ['Slack'] }
]);

function writeCache(source, items) {
  const file = workHub.cacheFile(source.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, sourceId: source.id, syncedAt: now, items }, null, 2)}\n`, { mode: 0o600 });
}

writeCache(acmeSource, [{
  kind: 'ticket',
  sourceId: acmeSource.id,
  connectionId: acmeConnectionId,
  providerFamily: 'anthropic',
  system: 'Jira',
  externalId: 'ACME-42',
  collectedAt: now,
  key: 'ACME-42',
  title: 'Ship global Work Hub',
  status: 'In Progress',
  normalizedStatus: 'in-progress',
  project: 'Axis'
}]);
writeCache(personalSource, [{
  kind: 'message',
  sourceId: personalSource.id,
  connectionId: personalConnectionId,
  providerFamily: 'anthropic',
  system: 'Slack',
  externalId: 'personal-message-1',
  collectedAt: now,
  title: 'Personal follow-up',
  preview: 'Personal context stays isolated from Acme Engineering.',
  sender: 'Visual fixture',
  timestamp: now,
  unread: true,
  requiresAttention: true
}]);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_COMPANY_CONTEXT_PATH: companyContextFile,
  LOCAL_CODER_CLAUDE_PROFILES_DIR: claudeProfilesDir,
  LOCAL_CODER_WORK_HUB_DIR: workHubDir,
  LOCAL_CODER_SETTINGS_PATH: path.join(fixtureDir, 'settings.json'),
  LOCAL_CODER_PROFILE_NAME: 'Visual Smoke',
  LOCAL_CODER_PROJECTS_PATH: path.join(fixtureDir, 'projects.json'),
  LOCAL_CODER_CREDENTIALS_PATH: path.join(fixtureDir, 'credentials.json'),
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

  const primary = await evaluate(cdp, `(() => ({
    workHubs: [...document.querySelectorAll('.lc-shell-primary-nav button')].filter((button) => button.getAttribute('aria-label') === 'Work Hub').length,
    contexts: [...document.querySelectorAll('.lc-shell-primary-nav button[data-company-id]')].map((button) => ({ id: button.dataset.companyId, label: button.getAttribute('aria-label') })),
    text: document.querySelector('.lc-shell-primary-nav')?.textContent?.replace(/\\s+/g, ' ').trim()
  }))()`);
  if (primary?.workHubs !== 1 || !primary.contexts.some((entry) => entry.id === 'personal' && entry.label === 'Personal') || !primary.contexts.some((entry) => entry.id === acme.id && entry.label === 'Acme Engineering')) fail('Primary navigation architecture is invalid', primary);
  console.log(`primary-navigation ${JSON.stringify(primary)}`);

  await evaluate(cdp, `document.querySelector('.lc-shell-primary-nav button[data-company-id=${JSON.stringify(acme.id)}]')?.click(); true`);
  await waitFor(cdp, `document.querySelector('.company-hub[data-company-id=${JSON.stringify(acme.id)}]') !== null`, 'Acme Company Hub');
  const companyRail = await evaluate(cdp, `(() => ({
    sections: [...document.querySelectorAll('.company-hub-rail > button')].map((button) => button.textContent?.trim()),
    workHubButtons: [...document.querySelectorAll('.company-hub-rail button')].filter((button) => button.textContent?.includes('Work Hub')).length,
    heading: document.querySelector('.company-hub-content .work-hub-header h2')?.textContent
  }))()`);
  if (JSON.stringify(companyRail?.sections) !== JSON.stringify(['Overview', 'Projects', 'Connections', 'MCPs', 'Skills', 'Settings']) || companyRail.workHubButtons !== 0 || companyRail.heading !== 'Acme Engineering') fail('Company Hub rail is invalid', companyRail);
  console.log(`company-hub ${JSON.stringify(companyRail)}`);
  await screenshot(cdp, 'company-hub-overview');

  await evaluate(cdp, `(() => { const button = [...document.querySelectorAll('.company-hub-rail > button')].find((item) => item.textContent?.trim() === 'Connections'); if (!button) throw new Error('Connections section missing'); button.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.company-source-settings') !== null`, 'Company-owned Work Hub sources');
  const companySources = await evaluate(cdp, `(() => ({
    heading: document.querySelector('.company-source-settings h2')?.textContent,
    sources: [...document.querySelectorAll('.company-source-settings [data-source-id]')].map((item) => ({ sourceId: item.dataset.sourceId, companyId: item.dataset.companyId, text: item.textContent?.replace(/\\s+/g, ' ').trim() })),
    hasAdd: [...document.querySelectorAll('.company-source-settings button')].some((button) => button.textContent?.includes('Add source'))
  }))()`);
  if (companySources?.heading !== 'Work Hub sources' || !companySources.hasAdd || companySources.sources.length !== 1 || companySources.sources[0]?.companyId !== acme.id || companySources.sources[0]?.sourceId !== 'acme-jira') fail('Company source administration is not scoped', companySources);
  console.log(`company-sources ${JSON.stringify(companySources)}`);
  await screenshot(cdp, 'company-connections-sources');

  await evaluate(cdp, `(() => { const button = [...document.querySelectorAll('.company-hub-rail > button')].find((item) => item.textContent?.trim() === 'Overview'); button?.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.company-hub-content .work-hub-header h2')?.textContent === 'Acme Engineering'`, 'Company overview');
  await evaluate(cdp, `(() => { const button = [...document.querySelectorAll('.company-hub-content button')].find((item) => item.textContent?.includes('Open in Work Hub')); if (!button) throw new Error('Open in Work Hub missing'); button.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.work-hub-page:not(.company-hub)') !== null`, 'global Work Hub');
  await waitFor(cdp, `document.querySelector('.work-hub-company-filter button[data-company-id=${JSON.stringify(acme.id)}]')?.getAttribute('aria-pressed') === 'true'`, 'Company-filtered global Work Hub');
  const deepLink = await evaluate(cdp, `(() => ({
    workHubSurfaces: document.querySelectorAll('.work-hub-page:not(.company-hub)').length,
    filter: localStorage.getItem('local-coder.work-hub-company-filter'),
    activeScope: document.querySelector('.work-hub-company-filter button[aria-pressed="true"]')?.textContent?.trim(),
    hasAll: [...document.querySelectorAll('.work-hub-company-filter button')].some((button) => button.textContent?.trim() === 'All'),
    hasPersonal: [...document.querySelectorAll('.work-hub-company-filter button')].some((button) => button.dataset.companyId === 'personal'),
    ticket: document.querySelector('.work-hub-item[data-company-id=${JSON.stringify(acme.id)}]')?.textContent?.replace(/\\s+/g, ' ').trim(),
    leakedPersonal: document.querySelector('.work-hub-item[data-company-id="personal"]') !== null
  }))()`);
  if (deepLink?.workHubSurfaces !== 1 || deepLink.filter !== acme.id || deepLink.activeScope !== 'Acme Engineering' || !deepLink.hasAll || !deepLink.hasPersonal || !deepLink.ticket?.includes('Acme Engineering') || deepLink.leakedPersonal) fail('Company → global Work Hub deep-link is invalid', deepLink);
  console.log(`work-hub-deep-link ${JSON.stringify(deepLink)}`);
  await screenshot(cdp, 'work-hub-acme-filtered');

  await evaluate(cdp, `(() => { const all = [...document.querySelectorAll('.work-hub-company-filter button')].find((button) => button.textContent?.trim() === 'All'); all?.click(); const sources = [...document.querySelectorAll('.work-hub-rail button')].find((button) => button.textContent?.trim() === 'Sources'); sources?.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.work-hub-source-list') !== null && document.querySelectorAll('.work-hub-source-list [data-source-id]').length === 2`, 'global source aggregation');
  const globalSources = await evaluate(cdp, `(() => ({
    sourceRows: [...document.querySelectorAll('.work-hub-source-list [data-source-id]')].map((item) => ({ companyId: item.dataset.companyId, text: item.textContent?.replace(/\\s+/g, ' ').trim() })),
    addButtons: [...document.querySelectorAll('.work-hub-main button')].filter((button) => /add source|choose what to sync/i.test(button.textContent || '')).length,
    removeButtons: [...document.querySelectorAll('.work-hub-main button')].filter((button) => /remove/i.test(button.textContent || '')).length,
    copy: document.querySelector('.work-hub-header p')?.textContent
  }))()`);
  if (globalSources?.sourceRows.length !== 2 || !globalSources.sourceRows.some((row) => row.companyId === 'personal') || !globalSources.sourceRows.some((row) => row.companyId === acme.id) || globalSources.addButtons !== 0 || globalSources.removeButtons !== 0 || !globalSources.copy?.includes('Configure sources inside the owning Company')) fail('Global Sources must be aggregation/health only', globalSources);
  console.log(`global-sources ${JSON.stringify(globalSources)}`);
  await screenshot(cdp, 'work-hub-sources-global');

  await evaluate(cdp, `(() => { const personal = document.querySelector('.work-hub-company-filter button[data-company-id="personal"]'); personal?.click(); const inbox = [...document.querySelectorAll('.work-hub-rail button')].find((button) => button.textContent?.trim() === 'Inbox'); inbox?.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.work-hub-item[data-company-id="personal"]') !== null`, 'Personal-filtered Inbox');
  const personal = await evaluate(cdp, `(() => ({
    activeScope: document.querySelector('.work-hub-company-filter button[aria-pressed="true"]')?.textContent?.trim(),
    personalMessage: document.querySelector('.work-hub-item[data-company-id="personal"]')?.textContent?.replace(/\\s+/g, ' ').trim(),
    leakedAcme: document.querySelector('.work-hub-item[data-company-id=${JSON.stringify(acme.id)}]') !== null
  }))()`);
  if (personal?.activeScope !== 'Personal' || !personal.personalMessage?.includes('Personal') || personal.leakedAcme) fail('Personal Work Hub isolation is invalid', personal);
  console.log(`personal-filter ${JSON.stringify(personal)}`);
  await screenshot(cdp, 'work-hub-personal-inbox');

  await evaluate(cdp, `window.dispatchEvent(new CustomEvent('local-coder:open-settings')); true`);
  await waitFor(cdp, `document.querySelector('.settings-modal') !== null`, 'global Settings');
  const settings = await evaluate(cdp, `(() => ({ tabs: [...document.querySelectorAll('.settings-rail button')].map((button) => button.textContent?.trim()) }))()`);
  if (JSON.stringify(settings?.tabs) !== JSON.stringify(['General', 'Appearance', 'Usage'])) fail('Global Settings contains Company-specific settings', settings);
  console.log(`global-settings ${JSON.stringify(settings)}`);
  await screenshot(cdp, 'global-settings-app-wide');
} finally {
  cdp?.close();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => child.kill('SIGKILL'))
  ]);
}
