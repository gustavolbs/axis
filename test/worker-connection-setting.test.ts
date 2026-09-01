import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_WORKER_HEALTH_PATH, normalizeBaseUrl, normalizeHealthPath } from '../src/app-runtime.js';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const runtime = read('src/app-runtime.ts');
const executionRuntime = read('src/execution-runtime.ts');
const appConfig = read('src/app-config.ts');
const panels = read('app/src/SettingsPanels.tsx');
const modal = read('app/src/SettingsModal.tsx');
const appRoot = read('app/src/AppRoot.tsx');
const css = read('app/src/lc-fixes.css');

test('the worker URL is canonicalized from what people actually type', () => {
  for (const [input, want] of [
    ['http://192.168.0.10:7337', 'http://192.168.0.10:7337'],
    ['192.168.0.10:7337', 'http://192.168.0.10:7337'],
    ['  http://worker.lan:7337/  ', 'http://worker.lan:7337'],
    // Callers append their own route, so a pasted path is dropped.
    ['http://192.168.0.10:7337/v1/health', 'http://192.168.0.10:7337']
  ] as const) {
    assert.equal(normalizeBaseUrl(input), want, `normalizeBaseUrl(${JSON.stringify(input)})`);
  }
  for (const input of ['', '   ', 'ftp://host:21', 'http://', '///']) {
    assert.throws(() => normalizeBaseUrl(input), /required|not a valid URL|http or https/, JSON.stringify(input));
  }
});

test('the health route is user-supplied and normalized to a single leading slash', () => {
  assert.equal(DEFAULT_WORKER_HEALTH_PATH, '/v1/health');
  for (const [input, want] of [
    ['/v1/health', '/v1/health'],
    ['v1/health', '/v1/health'],
    ['  ///v1//health  ', '/v1/health'],
    ['/healthz', '/healthz'],
    ['/', '/']
  ] as const) {
    assert.equal(normalizeHealthPath(input), want, `normalizeHealthPath(${JSON.stringify(input)})`);
  }
  // A full URL here would silently produce `${base}http://...`.
  assert.throws(() => normalizeHealthPath('http://host/v1/health'), /must be a path/);
  assert.throws(() => normalizeHealthPath('  '), /required/);
});

test('the probe hits the configured route, times out, and does not save', () => {
  const probe = runtime.slice(runtime.indexOf("pathname === '/settings/probe-worker'"), runtime.indexOf("pathname === '/fs/exists'"));
  assert.match(probe, /fetch\(`\$\{target\}\$\{healthPath\}`/, 'the route must come from settings, not a constant');
  assert.match(probe, /setTimeout\(\(\) => controller\.abort\(\), 4_000\)/);
  assert.doesNotMatch(probe, /patchSettings/, 'probing must not write the value');
  // The old probe assumed Ollama's own route and returned 404 against a worker.
  assert.doesNotMatch(runtime, /api\/tags/);
  assert.doesNotMatch(runtime, /probe-ollama/);
});

test('the worker URL and route round-trip through the app settings file', () => {
  assert.match(appConfig, /workerHealthPath\?: string/);
  // parseSettings and writeAppSettings each rebuild the object field by field,
  // so a field missing from either is silently dropped.
  assert.match(appConfig, /workerHealthPath: typeof value\.workerHealthPath === 'string'/);
  assert.match(appConfig, /workerHealthPath: settings\.workerHealthPath\?\.trim\(\)/);
  assert.match(runtime, /writeAppSettings\(\{ \.\.\.readAppSettings\(\), \.\.\.patch \}\)/);
});

test('execution is worker-only: no mode picker anywhere', () => {
  assert.match(runtime, /executionMode: 'remote' as const/);
  assert.doesNotMatch(panels, /Where work runs/);
  assert.doesNotMatch(panels, /settings-mode-choice/);
  assert.doesNotMatch(css, /settings-mode-choice/);
  assert.doesNotMatch(runtime, /executionMode must be/);
});

test('an unconfigured worker does not stop the app from starting', () => {
  // RemoteWorkerClient throws from its constructor and the runtime builds it in
  // a class field initializer, so a missing URL killed the process before any
  // window existed — and Settings, the only place to fix it, never opened.
  assert.match(executionRuntime, /class UnconfiguredWorkerBackend/);
  assert.match(executionRuntime, /config\.executionMode !== 'local' && !config\.remoteWorkerUrl/);
  assert.match(executionRuntime, /workerConfigured: false/);
  assert.match(executionRuntime, /Settings → General → Windows worker/);
});

test('Settings → General exposes the worker URL and its route', () => {
  assert.match(panels, /export function WorkerConnectionSetting/);
  assert.match(modal, /<WorkerConnectionSetting \/>/);
  assert.match(panels, /aria-label="Worker URL"/);
  assert.match(panels, /aria-label="Worker health route"/);
  assert.match(panels, /'\/api\/settings\/probe-worker'/);
  assert.match(css, /\.settings-endpoint-path/);
});

test('New chat does not inherit the last project', () => {
  // The composer seeds its project from this key; leaving it set made a "new
  // chat" belong to the previous project and hide inside a collapsed disclosure
  // instead of appearing under Chats.
  const startNewTask = appRoot.slice(appRoot.indexOf('function startNewTask'), appRoot.indexOf('function persistIds'));
  assert.match(startNewTask, /removeItem\('local-coder\.open-job'\)/);
  assert.match(startNewTask, /removeItem\('local-coder\.project'\)/);
});

test('opening a conversation reveals it instead of leaving it hidden', () => {
  const openJob = appRoot.slice(appRoot.indexOf('function openJob'), appRoot.indexOf('function runProject'));
  assert.match(openJob, /setExpandedProjects/, 'a chat inside a collapsed project must expand it');
  assert.match(openJob, /removeItem\('local-coder\.project'\)/, 'a project-less chat must clear the sticky project');
});
