import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readProjectGitReview } from '../src/project-git-review.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function canonicalPath(value: string): string {
  const real = fs.realpathSync.native(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

test('Project Git review reads working, staged, and branch diffs from the Project workspace', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-project-git-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Axis Test']);
  git(root, ['config', 'user.email', 'axis-test@example.invalid']);

  const source = path.join(root, 'src', 'value.ts');
  write(source, 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', 'feature/review']);

  write(source, 'export const value = 2;\n');
  const working = await readProjectGitReview({ id: 'project-a', workspace: root }, 'working');
  assert.equal(working.scope, 'working');
  assert.equal(canonicalPath(working.repositoryRoot), canonicalPath(root));
  assert.match(working.diff, /-export const value = 1;/);
  assert.match(working.diff, /\+export const value = 2;/);
  assert.equal(working.status.length, 1);

  git(root, ['add', 'src/value.ts']);
  const staged = await readProjectGitReview({ id: 'project-a', workspace: root }, 'staged');
  assert.equal(staged.scope, 'staged');
  assert.match(staged.diff, /-export const value = 1;/);
  assert.match(staged.diff, /\+export const value = 2;/);

  git(root, ['commit', '-m', 'feature change']);
  const branch = await readProjectGitReview({ id: 'project-a', workspace: root }, 'branch');
  assert.equal(branch.scope, 'branch');
  assert.equal(branch.baseRef, 'main');
  assert.match(branch.diff, /-export const value = 1;/);
  assert.match(branch.diff, /\+export const value = 2;/);
  assert.equal(branch.clean, true);
});
