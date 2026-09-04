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

test('Project overview reuses the New Chat composer presentation instead of maintaining a second styled composer', () => {
  assert.match(source, /className="lc-agent-composer-wrap"/);
  assert.match(source, /className="lc-agent-composer"/);
  assert.match(source, /className="lc-agent-prompt-input"/);
  assert.match(source, /className="composer-toolbar"/);
  assert.match(source, /className="composer-mode-switch"/);
  assert.match(source, /className="model-effort-trigger"/);
  assert.match(source, /className="lc-agent-send-button"/);
  assert.doesNotMatch(source, /project-detail-composer/);
  assert.match(source, /function onComposerKeyDown\(event: KeyboardEvent<HTMLTextAreaElement>\)/);
  assert.match(source, /Math\.min\(element\.scrollHeight, Math\.min\(320, window\.innerHeight \* 0\.4\)\)/);
});

test('Project model control uses the inline New Chat model popover and never opens a Connections modal', () => {
  assert.match(source, /\/api\/projects\/\$\{encodeURIComponent\(props\.project\.id\)\}\/catalog/);
  assert.match(source, /className="lc-agent-popover model-popover"/);
  assert.match(source, /className="model-provider-label">Provider or account/);
  assert.match(source, /className="popover-back"/);
  assert.match(source, /aria-haspopup="menu"/);
  assert.doesNotMatch(source, /ProjectConnectionsPanel/);
  assert.doesNotMatch(source, /connectionsOpen|setConnectionsOpen/);
  assert.doesNotMatch(source, /Project model and connections|Model & connections/);
  assert.doesNotMatch(source, /aria-haspopup="dialog"/);
});

test('Project overview wires existing controls instead of inventing a scheduler', () => {
  assert.match(source, /pickDirectory\(props\.project\.workspace \|\| undefined\)/);
  assert.match(source, /method: 'PATCH', body: \{ workspace: selected \}/);
  assert.match(source, /body: \{ instructions \}/);
  assert.match(source, /modelSelection/);
  assert.match(source, /method: 'PATCH', body: \{ name \}/);
  assert.match(source, /\/archive`, \{[\s\S]*method: 'POST', body: \{ archived: true \}/);
  assert.match(source, /method: 'DELETE'/);
  assert.doesNotMatch(source, /project-schedules|ScheduledTask|createProjectScheduledTask|runProjectScheduledTask/);
  assert.doesNotMatch(source, /<h2>Scheduled<\/h2>/);
});

test('Connection administration does not occupy the Project overview rail or composer', () => {
  const aside = source.match(/<aside className="project-detail-panel">([\s\S]*?)<\/aside>/)?.[1] ?? '';
  assert.match(aside, /<h2>Instructions<\/h2>/);
  assert.match(aside, /<h2>Context<\/h2>/);
  assert.doesNotMatch(aside, /ProjectConnectionsPanel|Connections/);
  assert.doesNotMatch(aside, /Search context/);
});

test('Project actions and instruction cancellation are functional', () => {
  for (const label of ['Rename…', 'Archive', 'Delete…']) {
    assert.ok(source.includes(`>${label}<`), `missing Project action: ${label}`);
  }
  assert.ok(!source.includes('>Model & connections<'), 'Project menu must not expose the removed Connections modal');
  assert.match(source, /function cancelInstructions\(\)[\s\S]*setInstructions\(props\.project\.instructions \?\? ''\)/);
  assert.match(source, /setGoal\(''\)/);
});


test('Project overview model catalog enforces Chat and Cowork connection scopes', () => {
  assert.match(source, /connectionPolicy\?: ProjectConnectionPolicy/);
  assert.match(source, /mode === 'chat'[\s\S]{0,120}policy\.chat\.allowedConnectionIds[\s\S]{0,120}policy\.inference\.allowedConnectionIds/);
  assert.match(source, /catalogHasSelection\(next, current, mode\)/);
  assert.match(source, /firstCatalogSelection\(next, mode\)/);
  assert.match(source, /projectCatalogProviderAllowed\(catalog, provider\.id, mode\)/);
  assert.match(source, /catalogHasSelection\(catalog, modelSelection, next\)/);
});
