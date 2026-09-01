import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const quickStart = fs.readFileSync(path.join(root, 'docs/QUICK_START.md'), 'utf8');

for (const referencedPath of [
  'scripts/setup-windows-host.ps1',
  'scripts/install-windows-worker-task.ps1',
  'docs/INSTALLATION.md',
  'docs/WINDOWS_REMOTE_SETUP.md',
  'docs/NORDVPN_MESHNET.md',
  'docs/CLOUD_SMOKE.md',
  'docs/DESKTOP_SHELL.md',
  'docs/RELEASE_CHECKLIST.md'
]) {
  test(`quick start referenced path exists: ${referencedPath}`, () => {
    assert.equal(fs.existsSync(path.join(root, referencedPath)), true);
  });
}

test('quick start exposes the supported standalone commands', () => {
  for (const command of [
    'npm install',
    'npm run desktop',
    'npm run check',
    'npm run desktop:pack:mac'
  ]) {
    assert.equal(quickStart.includes(command), true, `missing command: ${command}`);
  }
});

test('quick start explicitly rejects the retired host surfaces', () => {
  assert.match(quickStart, /does not require Claude Desktop/i);
  assert.match(quickStart, /no HTTP control server is started/i);
  assert.doesNotMatch(quickStart, /install:claude|install:routing|install:claude-token-saver/);
  assert.doesNotMatch(quickStart, /127\.0\.0\.1:7557|npm run console/);
});

test('quick start keeps secrets out of app settings and repository files', () => {
  assert.match(quickStart, /Keychain-backed storage/);
  assert.match(quickStart, /does not persist the raw bearer token/);
  assert.match(quickStart, /Do not commit API keys, worker tokens, or secrets/);
});

test('quick start keeps cloud opt-in after local-only validation', () => {
  assert.match(quickStart, /Cloud allowed:\s+OFF/);
  assert.match(quickStart, /Allowed providers: ollama/);
  assert.match(quickStart, /Only enable a paid provider after local-only execution is working/);
  assert.match(quickStart, /first test with cloud disabled/i);
});

test('quick start routes paid smoke details to the dedicated guide', () => {
  assert.match(quickStart, /CLOUD_SMOKE\.md/);
  assert.match(quickStart, /npm run smoke:cloud/);
  assert.doesNotMatch(quickStart, /export (?:ANTHROPIC_API_KEY|OPENAI_API_KEY)=/);
});
