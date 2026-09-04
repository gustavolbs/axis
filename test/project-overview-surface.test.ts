import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync('app/src/ProjectDetail.tsx', 'utf8');

test('Project overview follows the Claude project information hierarchy', () => {
  assert.match(source, /All projects/);
  assert.match(source, /<h2>Recent<\/h2>/);
  assert.match(source, /<h2>Instructions<\/h2>/);
  assert.match(source, /<h2>Project knowledge<\/h2>/);
  assert.doesNotMatch(source, /<h2>Scheduled<\/h2>/);
  assert.doesNotMatch(source, /<ProjectGitReview/);
  assert.doesNotMatch(source, /<ProjectConnectionsPanel project=\{props\.project\}[\s\S]*<section className="project-detail-context">/);
});

test('Project overview controls are wired instead of decorative placeholders', () => {
  assert.match(source, /pickDirectory\(props\.project\.workspace \|\| undefined\)/);
  assert.match(source, /body: \{ workspace: selected \}/);
  assert.match(source, /body: \{ instructions \}/);
  assert.match(source, /PINNED_PROJECTS_KEY/);
  assert.match(source, /local-coder:pinned-projects-changed/);
  assert.match(source, /setConnectionsOpen\(true\)/);
  assert.match(source, /\/archive`, \{ method: 'POST', body: \{ archived: true \} \}/);
  assert.match(source, /method: 'DELETE'/);
  assert.match(source, /method: 'PATCH', body: \{ name: nextName \}/);
});

test('Connection policy stays available without occupying the project overview sidebar', () => {
  const aside = source.match(/<aside className="project-detail-panel">([\s\S]*?)<\/aside>/)?.[1] ?? '';
  assert.doesNotMatch(aside, /ProjectConnectionsPanel/);
  assert.match(source, /aria-label="Project model and connections"/);
  assert.match(source, /<ProjectConnectionsPanel project=\{props\.project\}/);
});
