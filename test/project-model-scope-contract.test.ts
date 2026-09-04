import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const detail = fs.readFileSync('app/src/ProjectDetail.tsx', 'utf8');
const connections = fs.readFileSync('app/src/ProjectConnectionsPanel.tsx', 'utf8');
const runtime = fs.readFileSync('src/agent-product-runtime.ts', 'utf8');

test('Project Overview Chat is not seeded with the Cowork compatibility default', () => {
  assert.match(detail, /useState<ModelSelection>\(\{ mode: 'auto' \}\)/);
  assert.match(detail, /setModelSelection\(\{ mode: 'auto' \}\)/);
  assert.match(detail, /\/api\/projects\/\$\{encodeURIComponent\(props\.project\.id\)\}\/catalog/);
});

test('saving Chat connection policy cannot overwrite the Cowork default model', () => {
  const saveStart = connections.indexOf('async function save()');
  const saveEnd = connections.indexOf('const chatModels', saveStart);
  const saveBody = connections.slice(saveStart, saveEnd);
  assert.match(saveBody, /connectionPolicy: policy/);
  assert.doesNotMatch(saveBody, /defaultModel/);
});

test('runtime resolves explicit user choice first, then mode-specific Project defaults', () => {
  const explicit = runtime.indexOf('const requested = exactSelection(input.modelSelection);');
  const chat = runtime.indexOf('this.options.providers.projectChatSelection(project)');
  const cowork = runtime.indexOf('const projectDefault = exactSelection(project.defaultModel);');
  assert.ok(explicit >= 0, 'explicit per-conversation selection must win');
  assert.ok(chat > explicit, 'Chat must resolve its own projectChatSelection after no explicit override');
  assert.ok(cowork > chat, 'Cowork defaultModel must only be considered after the Chat branch');
});
