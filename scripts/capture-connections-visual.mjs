import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';
import { ClaudeAccountProfileStore } from '../dist/claude-account-profiles.js';
import { CodexAccountProfileStore } from '../dist/codex-account-profiles.js';
import { CompanyContextStore, PERSONAL_COMPANY_ID } from '../dist/company-context.js';
import { CredentialManager, CredentialProfileStore } from '../dist/credential-store.js';
import { apiCredentialConnectionId, chatGptAccountConnectionId, claudeAccountConnectionId } from '../dist/provider-connections.js';

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
const acme = companies.createCompany({ name: 'Acme Engineering', description: 'Product engineering', color: '#2563EB', icon: 'code-2' });
const northstar = companies.createCompany({ name: 'Northstar Health', description: 'Clinical platform', color: '#16A34A', icon: 'heart-pulse' });
const credentials = new CredentialManager(new CredentialProfileStore(credentialsFile));
credentials.addEnvironmentCredential({ id: 'openai-product-a', providerId: 'openai', label: 'OpenAI Product A', organizationId: acme.id, environmentVariable: 'AXIS_VISUAL_OPENAI_A' });
credentials.addEnvironmentCredential({ id: 'openai-product-b', providerId: 'openai', label: 'OpenAI Product B', organizationId: acme.id, environmentVariable: 'AXIS_VISUAL_OPENAI_B' });
credentials.addEnvironmentCredential({ id: 'anthropic-health', providerId: 'anthropic', label: 'Anthropic Health', organizationId: northstar.id, environmentVariable: 'AXIS_VISUAL_ANTHROPIC' });
const claudeProfiles = new ClaudeAccountProfileStore(claudeProfilesRoot);
claudeProfiles.create({ id: 'claude-acme', name: 'Claude Acme', organizationLabel: 'Acme Engineering' });
const codexProfiles = new CodexAccountProfileStore(codexProfilesRoot);
codexProfiles.create({ id: 'chatgpt-personal', name: 'ChatGPT Personal' });
const claudeAcmeId = claudeAccountConnectionId('claude-acme');

companies.reconcile({ projects: [], sessions: [], connections: [
  { id: apiCredentialConnectionId('openai', 'openai-product-a'), label: 'OpenAI Product A', auth: 'api-key', companyId: acme.id },
  { id: apiCredentialConnectionId('openai', 'openai-product-b'), label: 'OpenAI Product B', auth: 'api-key', companyId: acme.id },
  { id: apiCredentialConnectionId('anthropic', 'anthropic-health'), label: 'Anthropic Health', auth: 'api-key', companyId: northstar.id },
  { id: claudeAcmeId, label: 'Claude Acme', auth: 'claude-account', companyId: acme.id, organizationLabel: 'Acme Engineering' },
  { id: chatGptAccountConnectionId('chatgpt-personal'), label: 'ChatGPT Personal', auth: 'chatgpt-account', companyId: PERSONAL_COMPANY_ID }
] });

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
  AXIS_VISUAL_OPENAI_A: 'visual-openai-a', AXIS_VISUAL_OPENAI_B: 'visual-openai-b', AXIS_VISUAL_ANTHROPIC: 'visual-anthropic'
});
const child = spawn(electronPath, [`--remote-debugging-port=${debugPort}`, '.'], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk.toString(); }); child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function target() { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); const targets = await response.json(); const page = targets.find((item) => item.type === 'page' && String(item.url).includes('app-dist/index.html')); if (page?.webSocketDebuggerUrl) return page; } catch { /* starting */ } await sleep(250); } throw new Error(`Electron renderer did not expose a CDP target.\n${logs}`); }
class Cdp { constructor(url) { this.nextId = 1; this.pending = new Map(); this.socket = new WebSocket(url); this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); }); this.socket.addEventListener('message', (event) => { const response = JSON.parse(String(event.data)); if (!response.id) return; const pending = this.pending.get(response.id); if (!pending) return; this.pending.delete(response.id); response.error ? pending.reject(new Error(response.error.message)) : pending.resolve(response.result); }); } async send(method, params = {}) { await this.ready; const id = this.nextId++; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); } close() { this.socket.close(); } }
async function evaluate(cdp, expression) { const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`); return result.result?.value; }
async function waitFor(cdp, expression, label) { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { if (await evaluate(cdp, expression) === true) return; await sleep(150); } throw new Error(`Timed out waiting for ${label}.\n${logs}`); }
async function screenshot(cdp, name) { const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); const targetPath = path.join(outputDir, `${name}.png`); fs.writeFileSync(targetPath, Buffer.from(result.data, 'base64')); console.log(`captured ${path.relative(root, targetPath)}`); }

let cdp;
try {
  const page = await target(); cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, "document.querySelector('.lc-shell-sidebar') !== null", 'Axis shell');
  await waitFor(cdp, `document.querySelector('.lc-shell-primary-nav button[data-company-id=${JSON.stringify(acme.id)}]') !== null`, 'Acme context navigation');
  await evaluate(cdp, `(() => { const button = document.querySelector('.lc-shell-primary-nav button[data-company-id=${JSON.stringify(acme.id)}]'); if (!button) throw new Error('Acme context not found'); button.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.company-hub[data-company-id=${JSON.stringify(acme.id)}]') !== null`, 'Acme Company Hub');
  await evaluate(cdp, `(() => { const button = [...document.querySelectorAll('.company-hub-rail > button')].find((item) => item.textContent?.trim() === 'Connections'); if (!button) throw new Error('Connections section missing'); button.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.connection-center-settings[data-company-scope=${JSON.stringify(acme.id)}]') !== null`, 'Acme Connection Center');
  await waitFor(cdp, "document.querySelectorAll('.connection-center-card').length === 3", 'three Acme connections');

  const inventory = await evaluate(cdp, `(async () => {
    const cards = [...document.querySelectorAll('.connection-center-card')]; const rawConnections = await window.lc.providerConnections();
    return { cardCount: cards.length, cardCompanies: cards.map((card) => card.dataset.companyId), cardTexts: cards.map((card) => card.textContent?.replace(/\\s+/g, ' ').trim() ?? ''), rawCount: rawConnections.length, leakedNorthstar: cards.some((card) => card.textContent?.includes('Northstar Health')), leakedPersonal: cards.some((card) => card.textContent?.includes('Company: Personal')), apiKeyCount: cards.filter((card) => card.textContent?.includes('API Key')).length, accountCount: cards.filter((card) => card.textContent?.includes('Claude Account')).length, bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, cardsOverflow: cards.some((card) => card.scrollWidth > card.clientWidth + 1) };
  })()`);
  if (!inventory || inventory.cardCount !== 3 || inventory.rawCount !== 5 || inventory.cardCompanies.some((id) => id !== acme.id) || inventory.leakedNorthstar || inventory.leakedPersonal || inventory.apiKeyCount !== 2 || inventory.accountCount !== 1 || inventory.bodyOverflow || inventory.cardsOverflow) throw new Error(`Company-scoped connection inventory failed: ${JSON.stringify(inventory)}`);

  const typography = await evaluate(cdp, `(() => {
    const buttons = [...document.querySelectorAll('.connection-center-settings button')].filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return [...new Set(buttons.map((button) => getComputedStyle(button).fontSize))];
  })()`);
  if (!Array.isArray(typography) || typography.some((size) => size !== '11.5px')) throw new Error(`Connection button typography drifted: ${JSON.stringify(typography)}`);
  console.log(`inventory ${JSON.stringify(inventory)} typography=${JSON.stringify(typography)}`); await screenshot(cdp, 'inventory-acme-wide');

  await evaluate(cdp, `(() => { const button = [...document.querySelectorAll('.connection-center-settings button')].find((item) => item.textContent?.includes('Add connection')); if (!button) throw new Error('Add connection button not found'); button.click(); return true; })()`);
  await waitFor(cdp, "document.querySelector('.connection-create-dialog') !== null", 'add connection dialog');
  const dialog = await evaluate(cdp, `(() => { const form = document.querySelector('.connection-create-dialog'); const rect = form?.getBoundingClientRect(); const scope = form?.querySelector('.company-connection-fixed-scope')?.textContent?.replace(/\\s+/g, ' ').trim(); return { withinViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight), fixedScope: scope, hasCompanySelector: Boolean(form?.querySelector('button[aria-label="Connection Company"]')), hasAuthentication: Boolean(form?.querySelector('button[aria-label="Connection authentication"]')) }; })()`);
  if (!dialog?.withinViewport || !dialog.fixedScope?.includes('Acme Engineering') || !dialog.fixedScope.includes('Ownership is fixed') || dialog.hasCompanySelector || !dialog.hasAuthentication) throw new Error(`Company-locked add connection dialog failed: ${JSON.stringify(dialog)}`);
  await screenshot(cdp, 'add-connection-acme-locked');
  await evaluate(cdp, `(() => { const cancel = [...document.querySelectorAll('.connection-create-dialog button')].find((item) => item.textContent?.trim() === 'Cancel'); cancel?.click(); return true; })()`);

  await evaluate(cdp, `(() => { const button = [...document.querySelectorAll('.company-hub-rail > button')].find((item) => item.textContent?.trim() === 'MCPs'); if (!button) throw new Error('MCPs section missing'); button.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('[data-connection-id=${JSON.stringify(claudeAcmeId)}]') !== null`, 'Acme MCP account surface');
  const mcpScope = await evaluate(cdp, `(() => {
    const toolbar = document.querySelector('.company-mcp-toolbar');
    const search = toolbar?.querySelector('input[aria-label="Search MCPs"]');
    const add = [...(toolbar?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('Add MCP'));
    const accountCards = [...document.querySelectorAll('.company-mcp-list [data-connection-id]')];
    return {
      accountCards: accountCards.map((item) => item.dataset.connectionId),
      text: document.querySelector('.company-hub-content')?.textContent?.replace(/\\s+/g, ' ').trim(),
      hasSearch: Boolean(search),
      hasAdd: Boolean(add),
      addFontSize: add ? getComputedStyle(add).fontSize : undefined
    };
  })()`);
  if (mcpScope?.accountCards.length !== 1 || mcpScope.accountCards[0] !== claudeAcmeId || mcpScope.text?.includes('ChatGPT Personal') || !mcpScope.hasSearch || !mcpScope.hasAdd || mcpScope.addFontSize !== '11.5px') throw new Error(`Company MCP surface failed: ${JSON.stringify(mcpScope)}`);
  console.log(`mcp-scope ${JSON.stringify(mcpScope)}`); await screenshot(cdp, 'mcps-acme-scoped');
} finally {
  cdp?.close(); child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3_000).then(() => child.kill('SIGKILL'))]);
}
