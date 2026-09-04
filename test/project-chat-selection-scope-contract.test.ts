import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src/agent-product-runtime.ts'), 'utf8');

test('Project Chat resolves its Chat default before the Cowork default', () => {
  const requested = source.indexOf('const requested = exactSelection(input.modelSelection);');
  const chatDefault = source.indexOf('this.options.providers.projectChatSelection(project)');
  const coworkDefault = source.indexOf('const projectDefault = exactSelection(project.defaultModel);');
  assert.ok(requested >= 0, 'explicit user selection must still be honored');
  assert.ok(chatDefault > requested, 'Project Chat must resolve through projectChatSelection');
  assert.ok(coworkDefault > chatDefault, 'Cowork default must only be considered after the Chat branch');
});
