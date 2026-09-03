import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseUnifiedDiff } from '../app/src/diff-review.js';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const projectChatContext = read('src/project-chat-context.ts');
const projectBackend = read('src/project-engineer-backend.ts');
const projectDetail = read('app/src/ProjectDetail.tsx');
const projectGitReview = read('app/src/ProjectGitReview.tsx');
const projectGitSource = read('src/project-git-review.ts');
const companyRuntime = read('src/company-scoped-desktop-runtime.ts');
const main = read('app/src/main.tsx');
const diffReview = read('app/src/diff-review.ts');

test('Project Chat reads bounded repository evidence only through the owning Project', () => {
  assert.match(projectChatContext, /READ-ONLY PROJECT REPOSITORY CONTEXT/);
  assert.match(projectChatContext, /const configuredWorkspace = project\.workspace\.trim\(\)/);
  assert.match(projectChatContext, /prepareContextCapsule\(index, config/);
  assert.match(projectChatContext, /companyIndexDirectory\(config\.contextIndexPath, project\.organizationId\)/);
  assert.match(projectChatContext, /Use Cowork when the user asks you to modify or validate the repository/);
  assert.doesNotMatch(projectChatContext, /workspaceInput/);

  assert.match(projectBackend, /attachProjectChatRepositoryContext/);
  assert.match(projectBackend, /input\.interactionMode === 'chat'/);
  assert.match(projectBackend, /instructionScopedInput\.context/);
});

test('Project surface keeps Company and Chat/Cowork identity visible', () => {
  assert.match(projectDetail, /data-company-id=\{props\.project\.companyId\}/);
  assert.match(projectDetail, /const companyLabel = props\.project\.companyName \?\? props\.project\.companyId/);
  assert.match(projectDetail, /job\.input\.interactionMode === 'cowork' \? 'Cowork' : 'Chat'/);
  assert.match(projectDetail, /Chat can read bounded repository context from this folder\. Cowork can inspect, edit and validate it\./);
  assert.match(projectDetail, /<ProjectGitReview project=\{props\.project\}/);
  assert.doesNotMatch(projectDetail, /project\.organizationName \?\? project\.organizationId/);
});

test('Project Git review is read-only and cannot bypass the active Company Project boundary', () => {
  assert.match(projectGitSource, /git\(workspace, diffArgs\)/);
  assert.match(projectGitSource, /\['diff', '--cached'/);
  assert.match(projectGitSource, /\['diff', '--no-ext-diff'/);
  assert.match(projectGitSource, /GIT_OPTIONAL_LOCKS: '0'/);
  assert.match(projectGitSource, /const configuredWorkspace = project\.workspace\.trim\(\)/);
  assert.doesNotMatch(projectGitSource, /request\.body|cwdInput|workspaceInput/);

  assert.match(companyRuntime, /projectGitReviewPath/);
  assert.match(companyRuntime, /const project = await this\.requireActiveProject/);
  assert.match(companyRuntime, /readProjectGitReview/);
  assert.match(projectGitReview, />Unstaged<\/button>/);
  assert.match(projectGitReview, />Staged<\/button>/);
  assert.match(projectGitReview, /Git state from this Project folder only/);
});

test('unified diff parser separates files, hunks, line numbers and add/remove counts', () => {
  const files = parseUnifiedDiff([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -10 +10 @@',
    '-old();',
    '+next();'
  ].join('\n'));

  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, 'src/a.ts');
  assert.equal(files[0]?.additions, 2);
  assert.equal(files[0]?.removals, 1);
  assert.deepEqual(files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine]), [
    ['context', 1, 1],
    ['remove', 2, undefined],
    ['add', undefined, 2],
    ['add', undefined, 3]
  ]);
  assert.equal(files[1]?.path, 'src/b.ts');
  assert.equal(files[1]?.additions, 1);
  assert.equal(files[1]?.removals, 1);
});

test('desktop installs structured diff review without adding another stylesheet', () => {
  assert.match(main, /installDiffReviewEnhancements\(\)/);
  assert.match(diffReview, /File changes review/);
  assert.match(diffReview, /Review changes · Last turn/);
  assert.match(diffReview, /Raw unified diff/);
  assert.match(diffReview, /scrollIntoView/);
  assert.match(diffReview, /validation-ok/);
  assert.match(diffReview, /validation-fail/);
  assert.equal((main.match(/import '\.\/lc-[^']+\.css';/g) ?? []).length, 3);
});
