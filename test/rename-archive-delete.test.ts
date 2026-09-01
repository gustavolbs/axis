import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const runtime = read('src/app-runtime.ts');
const jobManager = read('src/standalone-job-manager.ts');
const appConfig = read('src/app-config.ts');
const appRoot = read('app/src/AppRoot.tsx');
const appTypes = read('app/src/app-types.ts');
const css = read('app/src/lc-fixes.css');

test('a conversation carries a name of its own', () => {
  // Renaming must not rewrite the prompt that started the conversation, so the
  // title is a separate field with the goal as its fallback.
  assert.match(jobManager, /title\?: string/);
  assert.match(jobManager, /archivedAt\?: string/);
  assert.match(jobManager, /async rename\(id: string, title: string\)/);
  assert.match(appRoot, /function jobTitle\(job: SidebarJob\): string/);
  assert.match(appRoot, /job\.title\?\.trim\(\) \|\| job\.input\.goal/);
  // snapshot() rebuilds field by field, so a new field missing there never
  // reaches the renderer.
  const snapshot = jobManager.slice(jobManager.indexOf('function snapshot('));
  assert.match(snapshot.slice(0, 500), /title: job\.title/);
  assert.match(snapshot.slice(0, 500), /archivedAt: job\.archivedAt/);
});

test('archiving hides without discarding, and can be undone', () => {
  assert.match(jobManager, /async setArchived\(id: string, archived: boolean\)/);
  assert.match(jobManager, /job\.archivedAt = archived \? new Date\(\)\.toISOString\(\) : undefined/);
  assert.match(runtime, /projectArchiveMatch && method === 'POST'/);
  // An unknown id must 404 rather than being stored as archived.
  assert.match(runtime, /this\.projects\.getProject\(id\);\s+\/\/ 404s/);
  // The sidebar filters archived items out; the Archived surface lists them.
  assert.match(appRoot, /\.filter\(\(job\) => !job\.archivedAt\)/);
  assert.match(appRoot, /\.filter\(\(project\) => !project\.archived\)/);
  assert.match(appRoot, /const archivedJobs =/);
  assert.match(appRoot, /const archivedProjects =/);
  assert.match(appRoot, /function ArchivedView/);
});

test('deleting a running conversation stops it first', () => {
  // Dropping the entry while the run was in flight would leak the run.
  const remove = jobManager.slice(jobManager.indexOf('async remove(id: string)'));
  const body = remove.slice(0, remove.indexOf('\n  }'));
  assert.match(body, /status === 'running' \|\| job\.status === 'queued'/);
  assert.match(body, /controller\?\.abort\(\)/);
  assert.match(body, /this\.jobs\.delete\(id\)/);
});

test('a project with conversations cannot be deleted', () => {
  // Previously the project went away and its conversations kept pointing at an
  // id that no longer existed, so they vanished without going anywhere.
  const del = runtime.slice(runtime.indexOf("projectMatch && method === 'DELETE'"));
  const body = del.slice(0, del.indexOf('const catalogMatch'));
  assert.match(body, /job\.input\.projectId === id/);
  assert.match(body, /still holds \$\{held\.length\}/);
  assert.match(body, /Archive or delete them first/);
  // A deleted id must not linger in the archived list.
  assert.match(body, /setProjectArchived\(id, false\)/);
});

test('archived project ids live in settings and are pruned', () => {
  // Archiving is presentation; it changes nothing about isolation or budgets,
  // so it stays out of the project store and its credential invariants.
  assert.match(appConfig, /archivedProjectIds\?: string\[\]/);
  assert.match(appConfig, /archivedProjectIds: Array\.isArray\(value\.archivedProjectIds\)/);
  assert.match(appConfig, /archivedProjectIds: settings\.archivedProjectIds\?\.length/);
  const prune = runtime.slice(runtime.indexOf('private archivedProjectIds()'));
  assert.match(prune.slice(0, 400), /live\.has\(id\)/, 'unknown ids must be dropped on read');
  assert.match(appTypes, /archived\?: boolean/);
});

test('the runtime exposes rename, archive and delete for conversations', () => {
  assert.match(runtime, /method === 'PATCH' && jobMatch/);
  assert.match(runtime, /this\.jobs\.rename\(id, requiredString\(body, 'title'\)\)/);
  assert.match(runtime, /this\.jobs\.setArchived\(id, body\.archived\)/);
  assert.match(runtime, /method === 'DELETE' && jobMatch/);
  assert.match(runtime, /typeof body\.archived !== 'boolean'/, 'archived must be validated');
});

test('the sidebar offers the actions and reports a refusal', () => {
  for (const label of ['Rename…', 'Archive', 'Delete…']) {
    assert.ok(appRoot.includes(`>${label}<`), `missing menu entry: ${label}`);
  }
  // Projects get their own menu, and the two menus never open together.
  assert.match(appRoot, /projectMenuId === project\.id/);
  assert.match(appRoot, /setProjectMenuId\(undefined\); setJobMenuId/);
  assert.match(appRoot, /setJobMenuId\(undefined\); setProjectMenuId/);
  // A blocked delete must not fail silently.
  assert.match(appRoot, /setActionError/);
  assert.match(appRoot, /\{actionError \?/);
  // Destructive entries are marked.
  assert.match(css, /\.lc-shell-row-menu button\.danger/);
});

test('deleting the open conversation clears it from the composer', () => {
  const del = appRoot.slice(appRoot.indexOf('function deleteJob'));
  const body = del.slice(0, del.indexOf('\n  }'));
  assert.match(body, /window\.confirm/, 'delete is irreversible; ask first');
  assert.match(body, /local-coder\.open-job/);
});

test('Archived is a navigation surface', () => {
  assert.match(appRoot, /type Surface = 'agent' \| 'projects' \| 'runs' \| 'archived'/);
  assert.match(appRoot, /aria-label="Archived"/);
  assert.match(appRoot, /surface === 'archived' \? <ArchivedView/);
  assert.match(appRoot, /value === 'archived'/, 'the choice must survive a restart');
  assert.match(css, /\.archived-page/);
});
