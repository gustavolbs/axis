import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const launcher = read('app/src/GlobalWorkHubLauncher.tsx');
const fixes = read('app/src/lc-fixes.css');

test('Work Hub Sources renderer uses the established styled source-card primitives', () => {
  for (const className of [
    'work-hub-list',
    'work-hub-source-card',
    'work-hub-source-icon',
    'work-hub-source-copy',
    'work-hub-state',
    'work-hub-source-actions',
    'work-hub-source-error'
  ]) {
    assert.match(launcher, new RegExp(className));
  }

  for (const className of [
    'work-hub-source-card',
    'work-hub-source-icon',
    'work-hub-source-copy',
    'work-hub-state',
    'work-hub-source-actions',
    'work-hub-source-error'
  ]) {
    assert.match(fixes, new RegExp(`\\.${className}\\b`));
  }

  assert.doesNotMatch(launcher, /work-hub-source-row|work-hub-source-identity|work-hub-source-state/);
});

test('Work Hub source status, error and narrow-layout states remain contained by the source card', () => {
  assert.match(launcher, /status-\$\{status\}/);
  assert.match(launcher, /status === 'ready' \? <CheckCircle2/);
  assert.match(launcher, /status === 'error' \? <AlertCircle/);
  assert.match(launcher, /state\?\.error \? <div className="work-hub-source-error"><AlertCircle/);
  assert.match(launcher, /status === 'error' \? 'Try again' : 'Sync'/);

  assert.match(fixes, /\.work-hub-source-card\.status-syncing\s*\{/);
  assert.match(fixes, /\.work-hub-source-card\.status-error\s*\{/);
  assert.match(fixes, /\.work-hub-source-error\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/);
  assert.match(fixes, /@media \(max-width:\s*520px\)[\s\S]*?\.work-hub-source-card\s*\{[\s\S]*?grid-template-columns:\s*36px minmax\(0,\s*1fr\);/);
});
