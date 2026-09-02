import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const moduleUrl = pathToFileURL(path.resolve('desktop/user-executable-path.mjs')).href;
const { buildDesktopExecutablePath } = await import(moduleUrl) as {
  buildDesktopExecutablePath(options?: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    platform?: NodeJS.Platform;
  }): string;
};

function mkdir(candidate: string): string {
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

test('packaged macOS PATH discovers common user CLI and Node-manager bins without a login shell', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-desktop-path-'));
  try {
    const localBin = mkdir(path.join(home, '.local', 'bin'));
    const voltaBin = mkdir(path.join(home, '.volta', 'bin'));
    const nvmBin = mkdir(path.join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin'));
    const fnmBin = mkdir(path.join(home, '.local', 'share', 'fnm', 'node-versions', 'v22.0.0', 'installation', 'bin'));
    const original = ['/usr/bin', '/bin'];

    const value = buildDesktopExecutablePath({
      env: { HOME: home, PATH: original.join(path.delimiter) },
      home,
      platform: 'darwin'
    });
    const entries = value.split(path.delimiter);

    assert.deepEqual(entries.slice(0, original.length), original);
    for (const candidate of [localBin, voltaBin, nvmBin, fnmBin]) {
      assert.ok(entries.includes(candidate), `missing desktop CLI path: ${candidate}`);
    }
    assert.equal(new Set(entries).size, entries.length, 'PATH entries must be deduplicated');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('non-macOS PATH is left untouched', () => {
  const original = ['/custom/bin', '/usr/bin'].join(path.delimiter);
  assert.equal(
    buildDesktopExecutablePath({ env: { PATH: original }, home: '/unused', platform: 'linux' }),
    original
  );
});
