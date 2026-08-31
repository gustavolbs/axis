import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptUrl = new URL('../scripts/eval-multi-provider.mjs', import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const script = fs.readFileSync(scriptUrl, 'utf8');

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

test('default comparative eval dry-run executes without inference or real workspace configuration', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--variants', 'qwen'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: ''
    },
    timeout: 15_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    mode?: string;
    safety?: { executionUsesDetachedWorktrees?: boolean; sourceNodeModulesReuse?: string };
  };
  assert.equal(output.mode, 'dry-run');
  assert.equal(output.safety?.executionUsesDetachedWorktrees, true);
  assert.equal(output.safety?.sourceNodeModulesReuse, 'disabled');
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
