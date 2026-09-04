import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CodexAccountProfileStore,
  CodexAccountRuntime,
  simplifyCodexUsageLimitError
} from '../src/codex-account-profiles.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

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

test('Codex invocation replaces a usage-limit CLI dump before provider/UI error handling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-codex-usage-limit-'));
  const profiles = new CodexAccountProfileStore(root);
  profiles.create({ id: 'personal', name: 'Personal' });
  const runtime = new CodexAccountRuntime(profiles, {
    codexBinary: process.execPath,
    commandPrefixArgs: [fixture],
    terminationGraceMs: 50
  });

  const result = await runtime.invoke('personal', 'USAGE_LIMIT');
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'ChatGPT Account usage limit reached. Try again at Sep 7th, 2026 6:00 AM.'
  );
  assert.doesNotMatch(result.stderr, /SYSTEM INSTRUCTIONS|runtime-cwd|gpt-5\.6-sol|Upgrade to Pro|purchase more credits/);
});

test('Codex usage-limit simplification stays narrow and leaves unknown failures alone', () => {
  assert.equal(
    simplifyCodexUsageLimitError('ERROR: transport disconnected unexpectedly'),
    undefined
  );
});
