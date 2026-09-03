import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  formatAttachmentSize,
  presentAgentLifecycle
} from '../app/src/agent-runtime-presentation.js';
import {
  runtimeUiActiveEvents,
  runtimeUiAllEvents,
  runtimeUiFailureEvents,
  runtimeUiOutcomeEvents
} from '../app/src/agent-runtime-ui-fixtures.js';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const componentSource = read('app/src/AgentRuntimeActivity.tsx');
const previewSource = read('app/src/RuntimeUiPreview.tsx');
const mainSource = read('app/src/main.tsx');

test('canonical lifecycle events project into provider-neutral runtime activity', () => {
  const activity = presentAgentLifecycle(runtimeUiAllEvents);
  assert.ok(activity.length > 0);

  const provider = activity.find((item) => item.kind === 'provider' && item.state === 'running');
  assert.equal(provider?.title, 'Provider running');
  assert.equal(provider?.provider?.connectionId, 'connection-account-2');
  assert.equal(provider?.provider?.modelId, 'model-code-large');
  assert.doesNotMatch(provider?.title ?? '', /claude|anthropic|openai|codex|ollama/i);

  const progress = activity.find((item) => item.kind === 'provider' && item.state === 'progress');
  assert.equal(progress?.progress?.percent, 50);
  assert.equal(progress?.progress?.completed, 2);
  assert.equal(progress?.progress?.total, 4);
});

test('read mutation command and validation retain canonical semantics', () => {
  const activity = presentAgentLifecycle([...runtimeUiActiveEvents, ...runtimeUiOutcomeEvents]);
  const readItem = activity.find((item) => item.kind === 'read' && item.state === 'success');
  const mutation = activity.find((item) => item.kind === 'mutation' && item.state === 'success');
  const command = activity.find((item) => item.kind === 'command' && item.state === 'success');
  const validation = activity.find((item) => item.kind === 'validation' && item.state === 'success');

  assert.equal(readItem?.title, 'Read completed');
  assert.match(readItem?.detail ?? '', /agent-runtime\/index\.ts/);
  assert.equal(mutation?.mutationStatus, 'committed');
  assert.equal(mutation?.title, 'Mutation completed');
  assert.equal(command?.title, 'Command completed');
  assert.match(command?.detail ?? '', /exit 0/);
  assert.equal(validation?.title, 'Validation passed');
});

test('permission and decision requests stay actionable until canonical resolution', () => {
  const active = presentAgentLifecycle(runtimeUiActiveEvents);
  const resolved = presentAgentLifecycle(runtimeUiOutcomeEvents);
  const permission = active.find((item) => item.kind === 'permission' && item.state === 'waiting');
  const decision = active.find((item) => item.kind === 'decision' && item.state === 'waiting');
  const permissionResolution = resolved.find((item) => item.kind === 'permission');
  const decisionResolution = resolved.find((item) => item.kind === 'decision');

  assert.deepEqual(permission?.permissions, ['process.execute', 'workspace.read']);
  assert.equal(permission?.call?.id, 'call-command');
  assert.equal(decision?.decisionRequest?.id, 'decision-runtime-ui');
  assert.equal(decision?.decisionRequest?.options?.length, 2);
  assert.equal(permissionResolution?.state, 'allowed');
  assert.equal(decisionResolution?.decisionResolution?.requestId, 'decision-runtime-ui');
});

test('error cancelled paused and completed states are distinct', () => {
  const failures = presentAgentLifecycle(runtimeUiFailureEvents);
  const outcomes = presentAgentLifecycle(runtimeUiOutcomeEvents);

  assert.ok(failures.some((item) => item.kind === 'error' && item.state === 'error' && item.title === 'browser_timeout'));
  assert.ok(failures.some((item) => item.kind === 'cancelled' && item.state === 'cancelled'));
  assert.ok(failures.some((item) => item.kind === 'paused' && item.state === 'paused'));
  assert.ok(outcomes.some((item) => item.kind === 'completed' && item.state === 'completed'));
});

test('attachment metadata is rendered without requiring binary payloads', () => {
  const activity = presentAgentLifecycle(runtimeUiActiveEvents);
  const attachments = activity.find((item) => item.kind === 'attachment')?.attachments;
  assert.equal(attachments?.length, 2);
  assert.equal(attachments?.[0]?.name, 'runtime-notes.md');
  assert.equal(formatAttachmentSize(18432), '18.0 KB');
  assert.equal(formatAttachmentSize(483120), '471.8 KB');
});

test('timeline approvals progress and evidence panes expose accessible native controls', () => {
  assert.match(componentSource, /aria-label="Agent activity"/);
  assert.match(componentSource, /role="list"/);
  assert.match(componentSource, /role="listitem"/);
  assert.match(componentSource, /aria-live="polite"/);
  assert.match(componentSource, /<progress[\s\S]*aria-label=\{label\}/);

  assert.match(componentSource, /role="group" aria-label="Decision options"/);
  assert.match(componentSource, /Or answer directly/);
  assert.match(componentSource, /event\.key === 'Enter'/);
  assert.match(componentSource, /event\.nativeEvent\.isComposing/);
  assert.match(componentSource, /role="group" aria-label="Approval actions"/);
  assert.match(componentSource, />Allow</);
  assert.match(componentSource, />Deny</);

  assert.match(componentSource, /role="tablist"/);
  assert.match(componentSource, /role="tab"/);
  assert.match(componentSource, /role="tabpanel"/);
  assert.match(componentSource, /ArrowLeft/);
  assert.match(componentSource, /ArrowRight/);
  assert.match(componentSource, /event\.key === 'Home'/);
  assert.match(componentSource, /event\.key === 'End'/);
});

test('runtime UI reuses the established design-system surfaces instead of adding a stylesheet', () => {
  for (const className of [
    'assistant-stream-state',
    'progress-list',
    'progress-row',
    'progress-index',
    'inline-decision',
    'inline-choice-list',
    'inline-guidance-input',
    'progress-panel',
    'context-list'
  ]) assert.match(componentSource, new RegExp(className));

  assert.doesNotMatch(componentSource, /style=\{/);
  assert.doesNotMatch(previewSource, /style=\{/);
  assert.doesNotMatch(mainSource, /agent-runtime[^'\"]*\.css/);
});

test('visual fixture is isolated from normal Chat and Cowork composition', () => {
  assert.match(mainSource, /has\('runtime-ui-preview'\)/);
  assert.match(mainSource, /import\('\.\/RuntimeUiPreview\.js'\)/);
  const previewBranch = mainSource.slice(mainSource.indexOf('if (runtimeUiPreview)'), mainSource.indexOf('} else {'));
  assert.doesNotMatch(previewBranch, /installRuntimeTransport/);
  assert.doesNotMatch(previewBranch, /<AppRoot/);
  assert.match(previewSource, /No backend wiring is used/);
});
