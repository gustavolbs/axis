import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const bootstrap = fs.readFileSync('desktop/bootstrap.mjs', 'utf8');
const preload = fs.readFileSync('desktop/preload.cjs', 'utf8');

test('packaged macOS bootstrap pins provider subprocesses to an Axis-owned cwd', () => {
  assert.match(bootstrap, /\.local-coder['"],\s*['"]runtime-cwd/);
  assert.match(bootstrap, /fs\.mkdirSync\(runtimeCwd,\s*\{\s*recursive:\s*true,\s*mode:\s*0o700\s*\}\)/);
  assert.match(bootstrap, /process\.chdir\(runtimeCwd\)/);
  assert.ok(
    bootstrap.indexOf('process.chdir(runtimeCwd)') < bootstrap.indexOf('await import(\'./main.mjs\')'),
    'the safe cwd must be installed before the desktop runtime is imported'
  );
});

test('Work Hub startup refresh is passive and cannot launch every provider', () => {
  assert.match(
    preload,
    /refreshWorkHub:\s*\(sourceId\)\s*=>\s*sourceId\s*===\s*undefined\s*\?\s*ipcRenderer\.invoke\('local-coder:work-hub-snapshot'\)/
  );
  assert.match(
    preload,
    /:\s*ipcRenderer\.invoke\('local-coder:work-hub-refresh',\s*String\(sourceId\)\)/
  );
  assert.doesNotMatch(
    preload,
    /ipcRenderer\.invoke\('local-coder:work-hub-refresh',\s*sourceId\s*===\s*undefined\s*\?\s*undefined/
  );
});
