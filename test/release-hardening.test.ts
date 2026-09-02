import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('macOS release workflow is automatic on main and fail-closed', () => {
  const workflow = read('.github/workflows/release-macos.yml');

  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, /contents:\s*write/);

  for (const secret of ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD']) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.doesNotMatch(workflow, /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID/);

  assert.match(workflow, /npm run release:validate/);
  assert.match(workflow, /npm run --silent release:notes/);
  assert.match(workflow, /git ls-remote --exit-code --tags/);
  assert.match(workflow, /npm run desktop:release:mac/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /certificate root = H|certificate leaf = H/);
  assert.match(workflow, /Ad-hoc signature detected/);
  assert.match(workflow, /shasum -a 256/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /stapler|spctl --assess|notariz/i);
  assert.doesNotMatch(workflow, /set -x/);
});

test('local release command requires only the stable self-signed signing inputs', () => {
  const releaseScriptPath = path.join(root, 'scripts/release-macos.mjs');
  const releaseScript = read('scripts/release-macos.mjs');
  const check = spawnSync(process.execPath, ['--check', releaseScriptPath], { encoding: 'utf8' });

  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(releaseScript, /process\.platform !== 'darwin'/);
  assert.match(releaseScript, /CSC_LINK/);
  assert.match(releaseScript, /CSC_KEY_PASSWORD/);
  assert.doesNotMatch(releaseScript, /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID/);
  assert.match(releaseScript, /Missing required self-signed release environment variables/);
  assert.match(releaseScript, /release-metadata\.mjs', 'validate/);
  assert.match(releaseScript, /shell: false/);
  assert.match(releaseScript, /electron-builder\.release\.yml/);
  assert.match(releaseScript, /'--x64'/);
  assert.match(releaseScript, /'--arm64'/);
  assert.doesNotMatch(releaseScript, /process\.env\.(?:CSC_LINK|CSC_KEY_PASSWORD)/);
});

test('distribution config requires a stable self-signed identity and no paid notarization', () => {
  const releaseConfig = read('electron-builder.release.yml');
  const devConfig = read('electron-builder.yml');
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

  assert.match(releaseConfig, /identity:\s*Axis Code Signing/);
  assert.match(releaseConfig, /forceCodeSigning:\s*true/);
  assert.match(releaseConfig, /hardenedRuntime:\s*false/);
  assert.match(releaseConfig, /notarize:\s*false/);
  assert.match(releaseConfig, /gatekeeperAssess:\s*false/);
  assert.match(releaseConfig, /artifactName:\s*\$\{productName\}-mac-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
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

test('release documentation preserves free update and standalone isolation invariants', () => {
  const install = read('docs/INSTALLATION.md');
  const release = read('docs/RELEASE_CHECKLIST.md');
  const updates = read('docs/AUTO_UPDATES.md');

  assert.match(install, /cloudAllowed: false/);
  assert.match(install, /allowed providers: ollama/);
  assert.match(install, /Organization ID is a security boundary/);
  assert.match(install, /~\/\.local-coder\/settings\.json/);
  assert.match(install, /LOCAL_CODER_REMOTE_WORKER_CREDENTIAL_REF/);
  assert.match(install, /does not persist the raw worker bearer token/);
  assert.match(install, /macOS Keychain/);
  assert.doesNotMatch(install, /legacy v0\.14|control-plane\.json.*remain|npm run console/);

  assert.match(release, /Axis Code Signing/);
  assert.match(release, /MAC_CSC_LINK/);
  assert.match(release, /automatic/i);
  assert.doesNotMatch(release, /APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID/);
  assert.match(release, /settings persist worker credential references, never raw worker bearer tokens/);
  assert.match(release, /Projects do not silently enable cloud access/);
  assert.match(release, /credentials cannot be rebound across Organization IDs/);
  assert.match(release, /never their values/);
  assert.match(release, /DesktopAppRuntime/);
  assert.doesNotMatch(release, /legacy v0\.14|npm run console|attach.*control plane/i);

  assert.match(updates, /update-electron-app/);
  assert.match(updates, /self-signed/i);
  assert.match(updates, /0\.16\.0/);
});