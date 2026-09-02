#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const REQUIRED_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD'];

function fail(message) {
  console.error(`[axis release] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    env: process.env
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with status ${String(result.status)}.`);
}

if (process.platform !== 'darwin') {
  fail('macOS distribution packages must be built on macOS.');
}

const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  fail(`Missing required self-signed release environment variables: ${missing.join(', ')}`);
}

run('node', ['scripts/release-metadata.mjs', 'validate']);
run('npm', ['run', 'build']);
run('npx', [
  'electron-builder',
  '--config',
  'electron-builder.release.yml',
  '--mac',
  'dmg',
  'zip',
  '--x64',
  '--arm64',
  '--publish',
  'never'
]);
