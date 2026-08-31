import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const quickStart = fs.readFileSync(path.join(root, 'docs/QUICK_START.md'), 'utf8');

for (const referencedPath of [
  'scripts/setup-windows-host.ps1',
  'scripts/install-windows-worker-task.ps1',
  'scripts/install-claude-remote-worker.mjs',
  'scripts/install-claude-routing-rule.mjs',
  'scripts/install-claude-token-saver.mjs',
  'scripts/smoke-cloud-providers.mjs',
  'docs/INSTALLATION.md',
  'docs/WINDOWS_REMOTE_SETUP.md',
  'docs/NORDVPN_MESHNET.md',
  'docs/CLOUD_SMOKE.md',
  'docs/DESKTOP_SHELL.md'
]) {
  test(`quick start referenced path exists: ${referencedPath}`, () => {
    assert.equal(fs.existsSync(path.join(root, referencedPath)), true);
  });
}

test('quick start exposes the supported primary commands', () => {
  for (const command of [
    'npm run desktop',
    'npm run console',
    'npm run install:claude:worker -- --host <WINDOWS_HOST>',
    'npm run install:routing',
    'npm run install:claude-token-saver',
    'npm run smoke:cloud -- --provider anthropic',
    'npm run smoke:cloud -- --provider openai'
  ]) {
    assert.match(quickStart, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('quick start does not instruct users to persist worker token in argv or config files', () => {
  assert.doesNotMatch(quickStart, /install:claude:worker[^\n]*--token/);
  assert.match(quickStart, /macOS Keychain/);
  assert.match(quickStart, /unset LOCAL_CODER_WINDOWS_WORKER_TOKEN/);
});

test('quick start makes cloud opt-in after local-only validation', () => {
  assert.match(quickStart, /Cloud allowed: OFF/);
  assert.match(quickStart, /Allowed providers: ollama/);
  assert.match(quickStart, /Isso é opcional\. Faça somente depois de o Local-only funcionar\./);
});
