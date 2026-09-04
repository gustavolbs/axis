import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('app/src/ProjectDetail.tsx', 'utf8');

test('Project overview preserves the canonical Axis pin and current main Project behavior', () => {
  assert.match(source, /PinOff/);
  assert.match(source, /Pin/);
  assert.match(source, /PINNED_PROJECTS_KEY = 'local-coder\.pinned-projects'/);
  assert.match(source, /local-coder:pins-changed/);
  assert.doesNotMatch(source, /\bStar\b/);
  assert.doesNotMatch(source, /starred-projects|favorite/i);
  assert.match(source, /<ProjectGitReview project=\{props\.project\}/);
  assert.doesNotMatch(source, /Choose a default Chat connection and model/);
});

test('Project overview wires existing controls instead of inventing a scheduler', () => {
  assert.match(source, /pickDirectory\(props\.project\.workspace \|\| undefined\)/);
  assert.match(source, /method: 'PATCH', body: \{ workspace: selected \}/);
  assert.match(source, /body: \{ instructions \}/);
  assert.match(source, /setConnectionsOpen\(true\)/);
  assert.match(source, /method: 'PATCH', body: \{ name \}/);
  assert.match(source, /\/archive`, \{[\s\S]*method: 'POST', body: \{ archived: true \}/);
  assert.match(source, /method: 'DELETE'/);
  assert.doesNotMatch(source, /project-schedules|ScheduledTask|createProjectScheduledTask|runProjectScheduledTask/);
  assert.doesNotMatch(source, /<h2>Scheduled<\/h2>/);
});

test('Connection administration no longer occupies the narrow Project rail', () => {
  const aside = source.match(/<aside className="project-detail-panel">([\s\S]*?)<\/aside>/)?.[1] ?? '';
  assert.match(aside, /<h2>Instructions<\/h2>/);
  assert.match(aside, /<h2>Context<\/h2>/);
  assert.doesNotMatch(aside, /ProjectConnectionsPanel/);
  assert.doesNotMatch(aside, /Search context/);
  assert.match(source, /aria-label="Project model and connections"/);
  assert.match(source, /<ProjectConnectionsPanel project=\{props\.project\}/);
});

test('Project actions and instruction cancellation are functional', () => {
  for (const label of ['Rename…', 'Model & connections', 'Archive', 'Delete…']) {
    assert.ok(source.includes(`>${label}<`), `missing Project action: ${label}`);
  }
  assert.match(source, /function cancelInstructions\(\)[\s\S]*setInstructions\(props\.project\.instructions \?\? ''\)/);
  assert.match(source, /setGoal\(''\)/);
});
