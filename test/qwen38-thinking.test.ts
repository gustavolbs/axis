import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codingThinkingForModel,
  normalizeThinkingForModel
} from '../src/ollama.js';

test('Qwen3.8 maps maximum reasoning intent to native default xhigh mode', () => {
  assert.equal(normalizeThinkingForModel('qwen3.8:27b', 'high'), true);
  assert.equal(normalizeThinkingForModel('qwen3.8', 'high'), true);
});

test('Qwen3.8 preserves medium, low, and disabled thinking intents', () => {
  assert.equal(normalizeThinkingForModel('qwen3.8:27b', 'medium'), 'medium');
  assert.equal(normalizeThinkingForModel('qwen3.8:27b', 'low'), 'low');
  assert.equal(normalizeThinkingForModel('qwen3.8:27b', false), false);
});

test('bounded coding uses low Qwen3.8 reasoning without changing legacy models', () => {
  assert.equal(codingThinkingForModel('qwen3.8:27b'), 'low');
  assert.equal(codingThinkingForModel('qwen3.8'), 'low');
  assert.equal(codingThinkingForModel('qwen3.6:35b-a3b-coding'), undefined);
  assert.equal(codingThinkingForModel('qwen2.5-coder:14b'), undefined);
});

test('other models keep the existing high thinking value', () => {
  assert.equal(normalizeThinkingForModel('qwen3.6:35b-a3b-coding', 'high'), 'high');
  assert.equal(normalizeThinkingForModel('qwen2.5-coder:14b', undefined), undefined);
});
