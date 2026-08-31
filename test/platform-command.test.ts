import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveWindowsNodeCli } from '../src/platform-command.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-coder-platform-command-'));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// test cli\n', 'utf8');
}

test('resolves pnpm from Corepack beside the system Node while execPath is dedicated', () => {
  const root = tempDir();
  const dedicatedNode = path.join(root, 'state', 'runtime', 'node.exe');
  const systemNode = path.join(root, 'system-node', 'node.exe');
  const packageJson = path.join(root, 'system-node', 'node_modules', 'corepack', 'package.json');
  const pnpmCli = path.join(root, 'system-node', 'node_modules', 'corepack', 'dist', 'pnpm.js');

  touch(dedicatedNode);
  touch(systemNode);
  touch(pnpmCli);
  writeJson(packageJson, {
    name: 'corepack',
    publishConfig: { bin: { pnpm: './dist/pnpm.js' } }
  });

  const resolved = resolveWindowsNodeCli('pnpm', {
    execPath: dedicatedNode,
    env: {
      LOCAL_CODER_SYSTEM_NODE_PATH: systemNode,
      Path: path.dirname(systemNode)
    }
  });

  assert.equal(resolved, pnpmCli);
});

test('resolves a globally installed pnpm from its package bin manifest', () => {
  const root = tempDir();
  const dedicatedNode = path.join(root, 'state', 'runtime', 'node.exe');
  const prefix = path.join(root, 'global-prefix');
  const packageJson = path.join(prefix, 'node_modules', 'pnpm', 'package.json');
  const pnpmCli = path.join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');

  touch(dedicatedNode);
  touch(pnpmCli);
  writeJson(packageJson, {
    name: 'pnpm',
    bin: { pnpm: './bin/pnpm.mjs' }
  });

  const resolved = resolveWindowsNodeCli('pnpm', {
    execPath: dedicatedNode,
    env: { Path: prefix }
  });

  assert.equal(resolved, pnpmCli);
});

test('prefers npm_execpath when it points to a real JavaScript npm CLI', () => {
  const root = tempDir();
  const dedicatedNode = path.join(root, 'runtime', 'node.exe');
  const npmCli = path.join(root, 'npm', 'npm-cli.js');
  touch(dedicatedNode);
  touch(npmCli);

  const resolved = resolveWindowsNodeCli('npm', {
    execPath: dedicatedNode,
    env: { npm_execpath: npmCli }
  });

  assert.equal(resolved, npmCli);
});

test('does not return cmd shims or unrelated executables as JavaScript CLIs', () => {
  const root = tempDir();
  const dedicatedNode = path.join(root, 'runtime', 'node.exe');
  touch(dedicatedNode);
  touch(path.join(root, 'bin', 'pnpm.cmd'));

  const resolved = resolveWindowsNodeCli('pnpm', {
    execPath: dedicatedNode,
    env: { Path: path.join(root, 'bin') }
  });

  assert.equal(resolved, undefined);
});
