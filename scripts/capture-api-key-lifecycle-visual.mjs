import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';
import { ApiConnectionEndpointStore } from '../dist/api-connection-endpoints.js';
import { CredentialManager, CredentialProfileStore } from '../dist/credential-store.js';
import { apiCredentialConnectionId } from '../dist/provider-connections.js';

const root = process.cwd();
const outputDir = path.join(root, 'visual-artifacts', 'connections');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-api-lifecycle-visual-'));
const credentialsFile = path.join(fixtureDir, 'credentials.json');
const endpointsFile = path.join(fixtureDir, 'api-endpoints.json');
const debugPort = 9342;
const firstCredentialId = 'lifecycle-openai-a';
const siblingCredentialId = 'lifecycle-openai-b';
const firstConnectionId = apiCredentialConnectionId('openai', firstCredentialId);
const siblingConnectionId = apiCredentialConnectionId('openai', siblingCredentialId);
const firstSecret = `axis-lifecycle-old-${process.pid}-${Date.now()}`;
const rotatedSecret = `axis-lifecycle-new-${process.pid}-${Date.now()}`;
const siblingSecret = `axis-lifecycle-sibling-${process.pid}-${Date.now()}`;

fs.mkdirSync(outputDir, { recursive: true });

const requests = [];
const server = http.createServer((request, response) => {
  requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, project: request.headers['openai-project'] });
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'gpt-lifecycle-smoke', owned_by: 'axis-smoke' }] }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not found' }));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Lifecycle smoke HTTP server did not expose a TCP port.');
const endpoint = `http://127.0.0.1:${address.port}/v1`;

const credentials = new CredentialManager(new CredentialProfileStore(credentialsFile));
credentials.addOrReplaceKeychainCredential({ id: firstCredentialId, providerId: 'openai', label: 'Lifecycle Primary', organizationId: 'personal', secret: firstSecret });
credentials.addOrReplaceKeychainCredential({ id: siblingCredentialId, providerId: 'openai', label: 'Lifecycle Sibling', organizationId: 'personal', secret: siblingSecret });
const endpoints = new ApiConnectionEndpointStore(endpointsFile);
endpoints.upsert({ connectionId: firstConnectionId, providerFamily: 'openai', credentialId: firstCredentialId, endpoint });
endpoints.upsert({ connectionId: siblingConnectionId, providerFamily: 'openai', credentialId: siblingCredentialId });

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  LOCAL_CODER_COMPANY_CONTEXT_PATH: path.join(fixtureDir, 'company-context.json'),
  LOCAL_CODER_CREDENTIALS_PATH: credentialsFile,
  LOCAL_CODER_API_CONNECTION_ENDPOINTS_PATH: endpointsFile,
  LOCAL_CODER_CLAUDE_PROFILES_DIR: path.join(fixtureDir, 'claude-profiles'),
  LOCAL_CODER_CODEX_PROFILES_DIR: path.join(fixtureDir, 'codex-profiles'),
  LOCAL_CODER_PROFILE_NAME: 'API Lifecycle Visual Smoke',
  LOCAL_CODER_PROJECTS_PATH: path.join(fixtureDir, 'projects.json'),
  LOCAL_CODER_RUN_STORE_PATH: path.join(fixtureDir, 'runs.json'),
  LOCAL_CODER_REMOTE_WORKER_URL: 'http://127.0.0.1:65534'
});
const child = spawn(electronPath, [`--remote-debugging-port=${debugPort}`, '.'], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk.toString(); }); child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); const targets = await response.json(); const page = targets.find((item) => item.type === 'page' && String(item.url).includes('app-dist/index.html')); if (page?.webSocketDebuggerUrl) return page; } catch { /* starting */ } await sleep(250); } throw new Error(`Electron renderer did not expose a CDP target.\n${logs}`); }
class Cdp { constructor(url) { this.nextId = 1; this.pending = new Map(); this.socket = new WebSocket(url); this.ready = new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); }); this.socket.addEventListener('message', (event) => { const response = JSON.parse(String(event.data)); if (!response.id) return; const pending = this.pending.get(response.id); if (!pending) return; this.pending.delete(response.id); response.error ? pending.reject(new Error(response.error.message)) : pending.resolve(response.result); }); } async send(method, params = {}) { await this.ready; const id = this.nextId++; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); } close() { this.socket.close(); } }
async function evaluate(cdp, expression) { const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`); return result.result?.value; }
async function waitFor(cdp, expression, label) { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { if (await evaluate(cdp, expression) === true) return; await sleep(150); } throw new Error(`Timed out waiting for ${label}.\n${logs}`); }
function safeRequests() { return requests.map(({ authorization, ...request }) => request); }
async function waitForRequest(match, label) { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { const request = requests.find(match); if (request) return request; await sleep(100); } throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(safeRequests())}`); }
async function screenshot(cdp, name) { const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }); const targetPath = path.join(outputDir, `${name}.png`); fs.writeFileSync(targetPath, Buffer.from(result.data, 'base64')); console.log(`captured ${path.relative(root, targetPath)}`); }
async function clickText(cdp, selector, text) { return await evaluate(cdp, `(() => { const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent?.trim().includes(${JSON.stringify(text)})); if (!target) throw new Error(${JSON.stringify(`${text} not found`)}); target.click(); return true; })()`); }
async function openPersonalConnections(cdp) {
  await waitFor(cdp, `document.querySelector('.lc-shell-primary-nav button[data-company-id="personal"]') !== null`, 'Personal context navigation');
  await evaluate(cdp, `(() => { const personal = document.querySelector('.lc-shell-primary-nav button[data-company-id="personal"]'); if (!personal) throw new Error('Personal context not found'); personal.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.company-hub[data-company-id="personal"]') !== null`, 'Personal Company Hub');
  await evaluate(cdp, `(() => { const button = [...document.querySelectorAll('.company-hub-rail > button')].find((item) => item.textContent?.trim() === 'Connections'); if (!button) throw new Error('Connections section missing'); button.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.connection-center-settings[data-company-scope="personal"]') !== null`, 'Personal Connection Center');
}

let cdp;
try {
  const page = await target(); cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await waitFor(cdp, "document.querySelector('.lc-shell-sidebar') !== null", 'Axis shell');
  await openPersonalConnections(cdp);
  await waitFor(cdp, "document.querySelectorAll('.connection-center-card').length === 2", 'two API Key siblings');

  await evaluate(cdp, `(() => { const card = document.querySelector('[data-connection-id="${firstConnectionId}"]'); const button = [...(card?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === 'Manage'); if (!card || card.dataset.companyId !== 'personal' || !button) throw new Error('Primary Personal API Key Manage action not found'); button.click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('.api-key-manage-dialog[data-api-connection-id="${firstConnectionId}"]') !== null`, 'API Key lifecycle dialog');

  const initial = await evaluate(cdp, `(() => { const dialog = document.querySelector('.api-key-manage-dialog'); const password = dialog?.querySelector('input[type="password"]'); const text = dialog?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''; return { hasCompany: text.includes('Company'), hasPersonal: text.includes('Personal'), hasTest: text.includes('Test connection'), hasRotate: text.includes('Rotate API key'), hasRemove: text.includes('Remove connection'), passwordEmpty: password?.value === '', leaksOldSecret: text.includes(${JSON.stringify(firstSecret)}) || [...(dialog?.querySelectorAll('input') ?? [])].some((input) => input.value === ${JSON.stringify(firstSecret)}) }; })()`);
  if (!initial?.hasCompany || !initial.hasPersonal || !initial.hasTest || !initial.hasRotate || !initial.hasRemove || !initial.passwordEmpty || initial.leaksOldSecret) throw new Error(`Initial API lifecycle UI contract failed: ${JSON.stringify(initial)}`);
  await screenshot(cdp, 'api-lifecycle-manage-initial');

  const initialRequestCount = requests.length;
  await clickText(cdp, '.api-key-manage-dialog button', 'Test connection');
  await waitFor(cdp, "document.querySelector('.api-key-manage-dialog')?.textContent?.includes('Connection verified') === true", 'initial verified result');
  const initialRequest = await waitForRequest((request, index) => index >= initialRequestCount && request.method === 'GET' && request.url === '/v1/models' && request.authorization === `Bearer ${firstSecret}`, 'initial safe connection test');
  if (initialRequest.project !== undefined) throw new Error(`Initial test unexpectedly sent project metadata: ${JSON.stringify(safeRequests())}`);

  await evaluate(cdp, `(() => { const dialog = document.querySelector('.api-key-manage-dialog'); const name = [...dialog.querySelectorAll('input')].find((input) => input.previousElementSibling?.textContent?.includes('Connection name')); const project = dialog.querySelector('input[aria-label="API header openai-project"]'); if (!name || !project) throw new Error('Editable API lifecycle fields not found'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(name, 'Lifecycle Primary Edited'); name.dispatchEvent(new Event('input', { bubbles: true })); set.call(project, 'project-smoke'); project.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(250); await clickText(cdp, '.api-key-manage-dialog button', 'Save changes');
  await waitFor(cdp, "document.querySelector('.api-key-manage-dialog')?.textContent?.includes('Connection settings saved') === true", 'saved API settings');
  const persisted = await evaluate(cdp, `(async () => { const details = await window.lc.apiKeyConnectionDetails(${JSON.stringify(firstConnectionId)}); return { name: details.name, endpoint: details.endpoint, headers: details.headers, enabled: details.enabled }; })()`);
  console.log(`api-lifecycle-persisted ${JSON.stringify(persisted)}`);
  if (persisted?.name !== 'Lifecycle Primary Edited' || persisted?.headers?.['openai-project'] !== 'project-smoke') throw new Error(`Save did not persist edited API lifecycle metadata: ${JSON.stringify(persisted)}`);
  await screenshot(cdp, 'api-lifecycle-edited');

  await evaluate(cdp, `(() => { const input = [...document.querySelectorAll('.api-key-manage-dialog input[type="password"]')].find((item) => item.previousElementSibling?.textContent?.includes('Replacement API key')); if (!input) throw new Error('Replacement API key input not found'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ${JSON.stringify(rotatedSecret)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(150); await clickText(cdp, '.api-key-manage-dialog button', 'Rotate key');
  await waitFor(cdp, "document.querySelector('.api-key-manage-dialog')?.textContent?.includes('API key rotated') === true", 'rotated API key');

  const rotatedRequestStart = requests.length;
  await clickText(cdp, '.api-key-manage-dialog button', 'Test connection');
  await waitFor(cdp, "document.querySelector('.api-key-manage-dialog')?.textContent?.includes('Connection verified') === true", 'post-rotation verified result');
  await waitForRequest((request, index) => index >= rotatedRequestStart && request.method === 'GET' && request.url === '/v1/models' && request.authorization === `Bearer ${rotatedSecret}` && request.project === 'project-smoke', 'post-rotation test using rotated key and persisted project header');

  await evaluate(cdp, `(() => { const button = document.querySelector('.api-key-manage-dialog button[aria-label="Disable API Key connection"]'); if (!button) throw new Error('Disable API Key connection control not found'); button.click(); return true; })()`);
  await waitFor(cdp, "document.querySelector('.api-key-manage-dialog')?.textContent?.includes('Connection disabled') === true", 'disabled state');
  const disabled = await evaluate(cdp, `(() => { const dialog = document.querySelector('.api-key-manage-dialog'); const test = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Test connection')); return { disabled: test?.disabled === true, text: dialog.textContent?.replace(/\\s+/g, ' ').trim() ?? '' }; })()`);
  if (!disabled?.disabled || !disabled.text.includes('Disabled')) throw new Error(`Disabled UI contract failed: ${JSON.stringify(disabled)}`);
  await screenshot(cdp, 'api-lifecycle-disabled');

  await evaluate(cdp, `(() => { const button = document.querySelector('.api-key-manage-dialog button[aria-label="Enable API Key connection"]'); if (!button) throw new Error('Enable API Key connection control not found'); button.click(); return true; })()`);
  await waitFor(cdp, "document.querySelector('.api-key-manage-dialog')?.textContent?.includes('Connection enabled') === true", 're-enabled state');

  await clickText(cdp, '.api-key-manage-dialog button', 'Remove connection');
  await waitFor(cdp, "document.querySelector('.shell-dialog') !== null", 'remove confirmation');
  await clickText(cdp, '.shell-dialog button', 'Remove connection');
  await waitFor(cdp, "document.querySelector('.api-key-manage-dialog') === null", 'closed lifecycle dialog after removal');
  await waitFor(cdp, "document.querySelectorAll('.connection-center-card').length === 1", 'one sibling after removal');
  const remaining = await evaluate(cdp, `(() => ({ firstGone: document.querySelector('[data-connection-id="${firstConnectionId}"]') === null, siblingPresent: document.querySelector('[data-connection-id="${siblingConnectionId}"]') !== null, siblingCompany: document.querySelector('[data-connection-id="${siblingConnectionId}"]')?.dataset.companyId, text: document.querySelector('.connection-center-card')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '' }))()`);
  if (!remaining?.firstGone || !remaining.siblingPresent || remaining.siblingCompany !== 'personal' || !remaining.text.includes('Lifecycle Sibling')) throw new Error(`Sibling isolation after removal failed: ${JSON.stringify(remaining)}`);
  await screenshot(cdp, 'api-lifecycle-sibling-after-remove');
  console.log(`api-lifecycle-requests ${JSON.stringify(safeRequests())}`);
} finally {
  cdp?.close(); child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3_000).then(() => child.kill('SIGKILL'))]);
  try { credentials.remove(firstCredentialId); } catch { /* already removed */ }
  try { credentials.remove(siblingCredentialId); } catch { /* cleanup */ }
  await new Promise((resolve) => server.close(resolve));
}
