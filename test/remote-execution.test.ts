import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, type LocalCoderConfig } from '../src/config.js';
import { applyRemoteChanges, hashWorkspaceContent, prepareRemoteWorkspace } from '../src/remote-workspace.js';

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}: ${output.stderr}`));
    });
  });
}

function testConfig(root: string): LocalCoderConfig {
  return {
    ...loadConfig({}),
    maxFileBytes: 100_000,
    remoteMaxDeltaBytes: 1_000_000,
    telemetryEnabled: false,
    telemetryPath: path.join(root, 'telemetry.jsonl'),
    runStorePath: path.join(root, 'runs'),
    contextIndexPath: path.join(root, 'indexes'),
    workerStatePath: path.join(root, 'worker')
  };
}

async function createGitWorkspace(): Promise<{ root: string; workspace: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-remote-'));
  const workspace = path.join(root, 'app');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await run('git', ['init'], { cwd: workspace });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
  await run('git', ['config', 'user.name', 'Remote Test'], { cwd: workspace });
  await fs.writeFile(path.join(workspace, 'src', 'value.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(workspace, '.env'), 'DO_NOT_SEND=secret\n');
  await run('git', ['add', 'src/value.ts'], { cwd: workspace });
  await run('git', ['commit', '-m', 'initial'], { cwd: workspace });
  await run('git', ['remote', 'add', 'origin', 'https://github.com/example/remote-test.git'], {
    cwd: workspace
  });
  return { root, workspace };
}

test('remote configuration is strict and has no implicit local fallback', () => {
  const config = loadConfig({
    LOCAL_CODER_EXECUTION_MODE: 'remote',
    LOCAL_CODER_REMOTE_WORKER_URL: 'http://192.168.1.50:7337/',
    LOCAL_CODER_REMOTE_WORKER_TOKEN: 'secret-token',
    LOCAL_CODER_WORKER_PORT: '7444',
    LOCAL_CODER_WORKER_BOOTSTRAP: 'auto',
    LOCAL_CODER_WORKER_ALLOWED_GIT_HOSTS: 'github.com,git.example.com'
  });

  assert.equal(config.executionMode, 'remote');
  assert.equal(config.remoteWorkerUrl, 'http://192.168.1.50:7337');
  assert.equal(config.remoteWorkerToken, 'secret-token');
  assert.equal(config.workerPort, 7444);
  assert.equal(config.workerBootstrap, 'auto');
  assert.deepEqual([...config.workerAllowedGitHosts], ['github.com', 'git.example.com']);
  assert.throws(
    () => loadConfig({ LOCAL_CODER_EXECUTION_MODE: 'somewhere' }),
    /Invalid LOCAL_CODER_EXECUTION_MODE/
  );
});

test('remote workspace captures dirty tracked and safe untracked state without secrets', async () => {
  const { root, workspace } = await createGitWorkspace();
  try {
    await fs.writeFile(path.join(workspace, 'src', 'value.ts'), 'export const value = 2;\n');
    await fs.writeFile(path.join(workspace, 'src', 'new.ts'), 'export const added = true;\n');
    await fs.writeFile(path.join(workspace, '.env.local'), 'ALSO_SECRET=yes\n');

    const snapshot = await prepareRemoteWorkspace(
      workspace,
      ['src/value.ts', 'src/new.ts'],
      testConfig(root)
    );

    assert.equal(snapshot.repositoryUrl, 'https://github.com/example/remote-test.git');
    assert.match(snapshot.baseSha, /^[0-9a-f]{40}$/);
    assert.equal(snapshot.workspaceRelativePath, '');

    const patch = Buffer.from(snapshot.dirtyPatchBase64, 'base64').toString('utf8');
    assert.match(patch, /src\/value\.ts/);
    assert.doesNotMatch(patch, /\.env/);

    assert.deepEqual(snapshot.untrackedFiles.map((file) => file.path), ['src/new.ts']);
    const expected = new Map(snapshot.expectedFiles.map((file) => [file.path, file.sha256]));
    assert.equal(expected.get('src/value.ts'), hashWorkspaceContent('export const value = 2;\n'));
    assert.equal(expected.get('src/new.ts'), hashWorkspaceContent('export const added = true;\n'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remote result apply is compare-and-swap and refuses stale worker output', async () => {
  const { root, workspace } = await createGitWorkspace();
  try {
    const config = testConfig(root);
    const original = 'export const value = 1;\n';
    await applyRemoteChanges(
      workspace,
      [
        {
          path: 'src/value.ts',
          beforeSha256: hashWorkspaceContent(original),
          contentBase64: Buffer.from('export const value = 2;\n').toString('base64')
        }
      ],
      config
    );
    assert.equal(
      await fs.readFile(path.join(workspace, 'src', 'value.ts'), 'utf8'),
      'export const value = 2;\n'
    );

    await fs.writeFile(path.join(workspace, 'src', 'value.ts'), 'export const value = 99;\n');
    await assert.rejects(
      applyRemoteChanges(
        workspace,
        [
          {
            path: 'src/value.ts',
            beforeSha256: hashWorkspaceContent('export const value = 2;\n'),
            contentBase64: Buffer.from('export const value = 3;\n').toString('base64')
          }
        ],
        config
      ),
      /Remote apply conflict/
    );
    assert.equal(
      await fs.readFile(path.join(workspace, 'src', 'value.ts'), 'utf8'),
      'export const value = 99;\n'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Claude remote-worker installer preserves unrelated MCPs and writes strict remote mode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coder-remote-installer-'));
  try {
    const configPath = path.join(root, '.claude.json');
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'existing' } } })}\n`
    );

    await run(
      process.execPath,
      [
        'scripts/install-claude-remote-worker.mjs',
        '--host',
        '192.168.1.50',
        '--token',
        'worker-secret',
        '--model',
        'qwen3.6:35b-a3b-coding'
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOCAL_CODER_CLAUDE_CONFIG_PATH: configPath
        }
      }
    );

    const installed = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    assert.ok(installed.mcpServers.existing);
    const env = installed.mcpServers['local-coder']?.env ?? {};
    assert.equal(env.LOCAL_CODER_EXECUTION_MODE, 'remote');
    assert.equal(env.LOCAL_CODER_REMOTE_WORKER_URL, 'http://192.168.1.50:7337');
    assert.equal(env.LOCAL_CODER_REMOTE_WORKER_TOKEN, 'worker-secret');
    assert.equal(env.LOCAL_CODER_MODEL, 'qwen3.6:35b-a3b-coding');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
