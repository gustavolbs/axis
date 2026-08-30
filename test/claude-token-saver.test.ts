import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = path.join(projectRoot, 'scripts', 'compact-claude-bash-output.mjs');
const installerPath = path.join(projectRoot, 'scripts', 'install-claude-token-saver.mjs');

test('compacts only noisy successful validation-shaped Bash output', () => {
  const stdout = `HEAD\n${'x'.repeat(8_000)}\nTAIL`;
  const input = {
    tool_input: { command: 'npm test' },
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false }
  };

  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput?: { updatedToolOutput?: { stdout?: string } };
  };
  const compacted = parsed.hookSpecificOutput?.updatedToolOutput?.stdout ?? '';
  assert.ok(compacted.length < stdout.length);
  assert.match(compacted, /successful command output compacted locally/);
  assert.match(compacted, /HEAD/);
  assert.match(compacted, /TAIL/);
});

test('leaves small or unrelated Bash output untouched', () => {
  const input = {
    tool_input: { command: 'git status' },
    tool_response: { stdout: 'clean', stderr: '', interrupted: false, isImage: false }
  };

  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('installer preserves existing settings and installs user-level token guards', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-claude-home-'));
  const claudeDir = path.join(home, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  try {
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        env: { EXISTING_SETTING: 'keep-me' },
        hooks: {
          PostToolUse: [
            {
              matcher: 'Write',
              hooks: [{ type: 'command', command: '/tmp/existing-hook' }]
            }
          ]
        }
      }),
      'utf8'
    );

    const result = spawnSync(process.execPath, [installerPath], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
      env: Record<string, string>;
      hooks: { PostToolUse: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    assert.equal(settings.env.EXISTING_SETTING, 'keep-me');
    assert.equal(settings.env.ENABLE_TOOL_SEARCH, 'true');
    assert.equal(settings.env.MAX_MCP_OUTPUT_TOKENS, '8000');
    assert.ok(settings.hooks.PostToolUse.some((entry) => entry.matcher === 'Write'));
    assert.ok(
      settings.hooks.PostToolUse.some((entry) =>
        entry.hooks?.some((hook) => hook.command?.includes('compact-claude-bash-output.mjs'))
      )
    );

    const installedHook = path.join(
      home,
      '.local-coder-mcp',
      'hooks',
      'compact-claude-bash-output.mjs'
    );
    assert.equal((await fs.stat(installedHook)).isFile(), true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
