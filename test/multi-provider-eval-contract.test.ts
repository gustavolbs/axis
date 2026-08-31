import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const script = fs.readFileSync(new URL('../scripts/eval-multi-provider.mjs', import.meta.url), 'utf8');

test('comparative eval uses disposable worktrees and never resets the source repository', () => {
  assert.match(script, /worktree', 'add', '--detach'/);
  assert.match(script, /worktree', 'remove', '--force'/);
  assert.match(script, /status', '--porcelain'/);
  assert.doesNotMatch(script, /reset', '--hard/);
  assert.doesNotMatch(script, /clean', '-[a-z]*f/i);
});

test('source node_modules reuse is disabled by default and requires an explicit flag', () => {
  assert.match(script, /reuseNodeModules: false/);
  assert.match(script, /--reuse-node-modules/);
  assert.match(script, /if \(reuseNodeModules\)/);
  assert.match(script, /sourceNodeModulesReuse: args\.reuseNodeModules \? 'explicitly enabled' : 'disabled'/);
});

test('example workspace placeholders are allowed only for non-executing dry runs', () => {
  assert.match(script, /readCases\(args\.file, \{ allowPlaceholders: !args\.execute \}\)/);
  assert.match(script, /!allowPlaceholders && item\.workspace\.includes\('REPLACE_WITH_REAL_WORKSPACE'\)/);
});

test('cloud eval models are explicit configuration rather than hardcoded provider model ids', () => {
  assert.match(script, /LOCAL_CODER_EVAL_ANTHROPIC_MODEL/);
  assert.match(script, /LOCAL_CODER_EVAL_OPENAI_MODEL/);
  assert.match(script, /LOCAL_CODER_EVAL_OLLAMA_MODEL/);
  assert.match(script, /ANTHROPIC_API_KEY/);
  assert.match(script, /OPENAI_API_KEY/);
  assert.doesNotMatch(script, /gpt-[0-9]/i);
  assert.doesNotMatch(script, /claude-[a-z0-9.-]+/i);
});

test('eval state uses environment credential references and temporary ledgers/history', () => {
  assert.match(script, /addEnvironmentCredential/);
  assert.match(script, /CredentialProfileStore\(path\.join\(stateRoot, 'credentials\.json'\)\)/);
  assert.match(script, /UsageLedger\(path\.join\(stateRoot, 'usage'\)\)/);
  assert.match(script, /RoutingHistoryStore\(path\.join\(stateRoot, 'routing-history'\)\)/);
  assert.doesNotMatch(script, /writeFileSync\([^\n]*API_KEY/);
});

test('quality profile mutation requires an explicit execute-time flag and minimum evidence', () => {
  assert.match(script, /--apply-quality-profiles requires --execute/);
  assert.match(script, /if \(scores\.length < 3\) continue/);
  assert.match(script, /qualityProfilesApplied: args\.applyQualityProfiles/);
});
