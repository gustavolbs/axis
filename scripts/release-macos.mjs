#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const REQUIRED_ENV = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID'
];

function fail(message) {
  console.error(`[local-coder release] ${message}`);
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
  fail('Signed macOS distribution packages must be built on macOS.');
}

const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  fail(`Missing required signing/notarization environment variables: ${missing.join(', ')}`);
}

// Secrets stay in inherited environment variables. They are never copied into command-line
// arguments, artifact names, or release logs by this wrapper.
run('npm', ['run', 'build']);
run('npx', [
  'electron-builder',
  '--config',
  'electron-builder.release.yml',
  '--mac',
  'dmg',
  'zip',
  '--publish',
  'never'
]);
