import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTaskPrompt } from '../src/prompt.js';

test('buildTaskPrompt emits bounded task sections', () => {
  const prompt = buildTaskPrompt({
    task: 'Add a typed sum function.',
    language: 'TypeScript',
    context: 'Existing utilities use named exports.',
    constraints: ['No dependencies', 'Do not change public APIs'],
    output: 'implementation'
  });

  assert.match(prompt, /# Task\nAdd a typed sum function\./);
  assert.match(prompt, /# Language \/ stack\nTypeScript/);
  assert.match(prompt, /# Context\nExisting utilities use named exports\./);
  assert.match(prompt, /- No dependencies/);
  assert.match(prompt, /- Do not change public APIs/);
  assert.match(prompt, /# Expected output\nimplementation/);
});

test('buildTaskPrompt omits absent optional sections', () => {
  const prompt = buildTaskPrompt({ task: 'Return hello.' });

  assert.equal(prompt, '# Task\nReturn hello.\n\n# Expected output\nimplementation');
});
