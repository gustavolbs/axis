import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { normalizeBaseUrl } from '../src/app-runtime.js';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const runtime = read('src/app-runtime.ts');
const panels = read('app/src/SettingsPanels.tsx');
const modal = read('app/src/SettingsModal.tsx');
const fixesCss = read('app/src/lc-fixes.css');

const appConfig = read('src/app-config.ts');
const config = read('src/config.ts');

test('the runtime exposes the Ollama endpoint as a setting', () => {
  assert.match(runtime, /pathname === '\/settings'/);
  assert.match(runtime, /method === 'PUT' && pathname === '\/settings'/);
  assert.match(runtime, /pathname === '\/settings\/probe-ollama'/);
  // OllamaClient reads config.ollamaBaseUrl per request, so writing it through
  // takes effect without restarting the app.
  assert.match(runtime, /this\.config\.ollamaBaseUrl = next/);
});

test('the endpoint lives in the app settings file that loadConfig already reads', () => {
  assert.match(appConfig, /ollamaBaseUrl\?: string/);
  // parseSettings and writeAppSettings both rebuild the object field by field,
  // so a field missing from either one is silently dropped.
  assert.match(appConfig, /ollamaBaseUrl: typeof value\.ollamaBaseUrl === 'string'/);
  assert.match(appConfig, /ollamaBaseUrl: settings\.ollamaBaseUrl\?\.trim\(\)/);
  assert.match(config, /settings\?\.ollamaBaseUrl/);
});

test('saving one setting does not wipe the others', () => {
  // writeAppSettings replaces the whole file, and loadConfig reads
  // executionMode, remoteWorkerUrl, remoteWorkerCredentialRef and model from it.
  assert.match(runtime, /writeAppSettings\(\{ \.\.\.readAppSettings\(\), \.\.\.patch \}\)/);
  assert.doesNotMatch(runtime, /path\.dirname\(this\.config\.runStorePath\), 'settings\.json'/,
    'that path resolves to the app settings file and replacing it loses the worker config');
});

test('direct mode is selectable so the worker bearer token is not required', () => {
  // The token comes from the remote worker protocol, not from Ollama:
  // executionMode 'local' talks to Ollama directly and never consults it.
  assert.match(runtime, /requiresWorkerToken: this\.config\.executionMode !== 'local'/);
  assert.match(runtime, /executionMode must be 'local', 'remote' or 'auto'/);
  assert.match(runtime, /restartRequired/, 'the execution runtime is built once at startup');
  assert.match(panels, /'Direct to Ollama'/);
  assert.match(panels, /'No token'/);
  assert.match(panels, /executionMode: next/);
  assert.match(fixesCss, /\.settings-mode-choice/);
});

test('the endpoint the user typed is canonicalized', () => {
  for (const [input, want] of [
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    // A trailing slash would produce `.../api/tags` with a double slash.
    ['http://127.0.0.1:11434///', 'http://127.0.0.1:11434'],
    ['  https://ollama.lan:11434  ', 'https://ollama.lan:11434'],
    // No scheme is what people actually type.
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['localhost:11434', 'http://localhost:11434'],
    ['192.168.0.9:11434/', 'http://192.168.0.9:11434'],
    // Requests append their own path, so a pasted one is dropped.
    ['http://127.0.0.1:11434/api', 'http://127.0.0.1:11434'],
    ['HTTP://LocalHost:11434', 'http://localhost:11434']
  ] as const) {
    assert.equal(normalizeBaseUrl(input), want, `normalizeBaseUrl(${JSON.stringify(input)})`);
  }
});

test('a bad endpoint is rejected here, not three layers down in a fetch error', () => {
  for (const input of ['', '   ', 'ftp://host:21', 'file:///etc', 'http://', 'http:// ', '///']) {
    assert.throws(() => normalizeBaseUrl(input), /required|not a valid URL|http or https/, JSON.stringify(input));
  }
});

test('the probe does not hang and does not save', () => {
  const probe = runtime.slice(runtime.indexOf("pathname === '/settings/probe-ollama'"));
  assert.match(probe.slice(0, 900), /AbortController/);
  assert.match(probe.slice(0, 900), /setTimeout\(\(\) => controller\.abort\(\), 4_000\)/);
  assert.doesNotMatch(probe.slice(0, 900), /persistSettings/, 'probing must not write the value');
});

test('Settings → General can edit, test and save the endpoint', () => {
  assert.match(panels, /export function OllamaEndpointSetting/);
  assert.match(modal, /<OllamaEndpointSetting \/>/);
  assert.match(modal, /tab === 'general'[\s\S]{0,400}?<OllamaEndpointSetting/);
  assert.match(panels, /'\/api\/settings'/);
  assert.match(panels, /'\/api\/settings\/probe-ollama'/);
  assert.match(panels, /aria-label="Ollama base URL"/);
  // Save is only offered when the value actually changed.
  assert.match(panels, /const dirty =/);
  assert.match(panels, /disabled=\{!dirty \|\| busy !== undefined\}/);
  assert.match(fixesCss, /\.settings-endpoint-row/);
});

test('no component imports the AdminPanel module, which does not exist', () => {
  for (const file of fs.readdirSync(path.join(root, 'app/src')).filter((f) => f.endsWith('.tsx'))) {
    assert.doesNotMatch(read(`app/src/${file}`), /from '\.\/AdminPanel\.js'/, `${file} imports a missing module`);
  }
});
