import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('signed macOS release workflow is manual and fail-closed', () => {
  const workflow = read('.github/workflows/release-macos.yml');

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /\bpush:/);

  for (const secret of [
    'MAC_CSC_LINK',
    'MAC_CSC_KEY_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID'
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }

  assert.match(workflow, /for name in CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID/);
  assert.match(workflow, /Required release secret is missing:/);
  assert.match(workflow, /if \[ "\$missing" -ne 0 \]; then\s+exit 1/);
  assert.match(workflow, /npm run desktop:release:mac/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /Authority=Developer ID Application/);
  assert.match(workflow, /xcrun stapler validate/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /hdiutil attach/);
  assert.match(workflow, /shasum -a 256/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /set -x/);
});

test('local release command also refuses unsigned or unnotarized packaging', () => {
  const releaseScriptPath = path.join(root, 'scripts/release-macos.mjs');
  const releaseScript = read('scripts/release-macos.mjs');
  const check = spawnSync(process.execPath, ['--check', releaseScriptPath], { encoding: 'utf8' });

  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(releaseScript, /process\.platform !== 'darwin'/);
  assert.match(releaseScript, /CSC_LINK/);
  assert.match(releaseScript, /CSC_KEY_PASSWORD/);
  assert.match(releaseScript, /APPLE_ID/);
  assert.match(releaseScript, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(releaseScript, /APPLE_TEAM_ID/);
  assert.match(releaseScript, /Missing required signing\/notarization environment variables/);
  assert.match(releaseScript, /shell: false/);
  assert.match(releaseScript, /electron-builder\.release\.yml/);
  assert.doesNotMatch(releaseScript, /process\.env\.(?:CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID)/);
});

test('distribution config requires hardened runtime and notarization', () => {
  const releaseConfig = read('electron-builder.release.yml');
  const devConfig = read('electron-builder.yml');
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

  assert.match(releaseConfig, /hardenedRuntime:\s*true/);
  assert.match(releaseConfig, /notarize:\s*true/);
  assert.match(releaseConfig, /gatekeeperAssess:\s*false/);
  assert.doesNotMatch(devConfig, /notarize:\s*true/);
  assert.equal(pkg.scripts?.['desktop:release:mac'], 'node scripts/release-macos.mjs');
});

test('ordinary CI remains unsigned and separate from distribution', () => {
  const ci = read('.github/workflows/ci.yml');

  assert.match(ci, /CSC_IDENTITY_AUTO_DISCOVERY:\s*'false'/);
  assert.match(ci, /npm run desktop:pack:mac/);
  assert.doesNotMatch(ci, /desktop:release:mac/);
  assert.doesNotMatch(ci, /MAC_CSC_LINK/);
  assert.doesNotMatch(ci, /APPLE_APP_SPECIFIC_PASSWORD/);
});

test('installation and release docs preserve migration and isolation invariants', () => {
  const install = read('docs/INSTALLATION.md');
  const release = read('docs/RELEASE_CHECKLIST.md');

  assert.match(install, /cloudAllowed: false/);
  assert.match(install, /allowed providers: ollama/);
  assert.match(install, /Organization ID is a security boundary/);
  assert.match(install, /legacy v0\.14 `remoteWorkerToken` is read for compatibility only/);
  assert.match(install, /remoteWorkerCredentialRef/);
  assert.match(install, /macOS Keychain/);

  assert.match(release, /Developer ID Application/);
  assert.match(release, /legacy v0\.14 Local-only settings remain readable/);
  assert.match(release, /Projects do not silently enable cloud access/);
  assert.match(release, /credentials cannot be rebound across Organization IDs/);
  assert.match(release, /never their values/);
});
