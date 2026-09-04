import assert from 'node:assert/strict';
import { test } from 'node:test';

import { simplifyCodexUsageLimitError } from '../src/codex-account-profiles.js';

test('Codex usage-limit errors collapse raw CLI dumps into one clear account message', () => {
  const raw = [
    'Reading additional input from stdin...',
    'OpenAI Codex v0.153.1 -------- workdir: /Users/example/.local-coder/runtime-cwd model: gpt-5.6-sol provider: openai',
    '# SYSTEM INSTRUCTIONS',
    'private prompt material that must never become the user-facing error',
    "ERROR: You've hit your usage limit. Upgrade to Pro, visit settings to purchase more credits or try again at Sep 7th, 2026 6:00 AM.",
    "ERROR: You've hit your usage limit. Upgrade to Pro, visit settings to purchase more credits or try again at Sep 7th, 2026 6:00 AM."
  ].join('\n');

  assert.equal(
    simplifyCodexUsageLimitError(raw),
    'ChatGPT Account usage limit reached. Try again at Sep 7th, 2026 6:00 AM.'
  );
});

test('Codex usage-limit simplification stays narrow and leaves unknown failures alone', () => {
  assert.equal(
    simplifyCodexUsageLimitError('ERROR: transport disconnected unexpectedly'),
    undefined
  );
});
