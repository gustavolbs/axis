import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');

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
  // An unknown id must be rejected before archive state can be stored.
  assert.match(runtime, /this\.projects\.getProject\(id\);/);
  // The sidebar filters archived items out; the Archived surface lists them.
  assert.match(appRoot, /\.filter\(\(job\) => !job\.archivedAt\)/);
  assert.match(appRoot, /\.filter\(\(project\) => !project\.archived\)/);
  assert.match(appRoot, /const archivedJobs =/);
  assert.match(appRoot, /const archivedProjects =/);
  assert.match(appRoot, /function ArchivedView/);
});

test('a follow-up unarchives the conversation it continues', () => {
  // The two features meet here: an archived chat can be opened from the
  // Archived surface, so a follow-up must restart it through the shared Chat
  // reset path rather than duplicating reset state in every turn action.
  const followUpStart = jobManager.search(/async followUp\(\s*id: string/);
  assert.notEqual(followUpStart, -1, 'followUp method must remain present');
  const followUp = jobManager.slice(followUpStart);
  const body = followUp.slice(0, followUp.indexOf('\n  }\n'));
  assert.match(body, /this\.restartChat\(job, 'Chat follow-up queued'\)/);

  const restartChat = jobManager.slice(jobManager.indexOf('private restartChat(job: JobInternal'));
  const restartBody = restartChat.slice(0, restartChat.indexOf('\n  }\n'));
  assert.match(restartBody, /job\.archivedAt = undefined/);
  // And it must not consume Cowork's resume budget.
  assert.match(restartBody, /job\.rounds = 0/);
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
  const body = del.slice(0, del.indexOf('\n  }\n'));
  // Delete is irreversible, so it asks first — through the in-app dialog.
  assert.match(body, /kind: 'confirm'/);
  assert.match(body, /danger: true/);
  assert.match(body, /local-coder\.open-job/);
});

test('archiving no longer destroys history, and the list pages', () => {
  // The store is rewritten in full on every change and only the first 30 jobs
  // were written, so archiving a 31st conversation deleted the oldest for good.
  assert.match(jobManager, /const PERSISTED_JOB_LIMIT = 200/);
  assert.doesNotMatch(jobManager, /slice\(0, 30\)/);
  const persist = jobManager.slice(jobManager.indexOf('private schedulePersist'));
  assert.match(persist.slice(0, 900), /slice\(0, PERSISTED_JOB_LIMIT\)/);
  // Archived conversations keep their content but drop progress telemetry,
  // which is what made the old limit necessary.
  assert.match(persist.slice(0, 900), /events: publicJob\.archivedAt \? \[\] : publicJob\.events/);

  // The view pages rather than rendering every archived conversation.
  assert.match(appRoot, /const ARCHIVED_PAGE_SIZE = 20/);
  assert.match(appRoot, /setVisible\(\(current\) => current \+ ARCHIVED_PAGE_SIZE\)/);
  // Restoring or deleting shortens the list; the page size must not outrun it.
  assert.match(appRoot, /Math\.min\(visible, props\.jobs\.length\)/);
  assert.match(appRoot, /remaining > 0 \?/);
  assert.match(css, /\.archived-more/);
});

test('Archived is a navigation surface', () => {
  assert.match(appRoot, /type Surface = 'agent' \| 'projects' \| 'project' \| 'runs' \| 'archived'/);
  assert.match(appRoot, /aria-label="Archived"/);
  assert.match(appRoot, /surface === 'archived' \? <ArchivedView/);
  assert.match(appRoot, /value === 'archived'/, 'the choice must survive a restart');
  assert.match(css, /\.archived-page/);
});
