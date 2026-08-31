import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const host = readArg('--host') ?? process.env.LOCAL_CODER_WINDOWS_HOST;
const port = readArg('--port') ?? process.env.LOCAL_CODER_WINDOWS_WORKER_PORT ?? '7337';
const token = readArg('--token') ?? process.env.LOCAL_CODER_WINDOWS_WORKER_TOKEN;
const model = readArg('--model') ?? process.env.LOCAL_CODER_WINDOWS_MODEL ?? 'qwen3.8:27b';
const projectRoot = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(projectRoot, 'dist', 'index.js');
const claudeConfigPath =
  process.env.LOCAL_CODER_CLAUDE_CONFIG_PATH ?? path.join(os.homedir(), '.claude.json');
const controlPlaneConfigPath =
  process.env.LOCAL_CODER_CONTROL_PLANE_CONFIG_PATH ??
  path.join(os.homedir(), '.local-coder-mcp', 'control-plane.json');

if (!host) {
  console.error('Missing Windows host. Use --host <IP-or-hostname> or LOCAL_CODER_WINDOWS_HOST.');
  process.exit(1);
}
if (!token) {
  console.error('Missing worker token. Use --token <token> or LOCAL_CODER_WINDOWS_WORKER_TOKEN.');
  process.exit(1);
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error(`Invalid worker port: ${port}`);
  process.exit(1);
}
if (!fs.existsSync(serverPath)) {
  console.error(`Missing ${serverPath}. Run "npm run build" first.`);
  process.exit(1);
}

let config = {};
if (fs.existsSync(claudeConfigPath)) {
  const raw = fs.readFileSync(claudeConfigPath, 'utf8').trim();
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch (error) {
      console.error(`Could not parse ${claudeConfigPath}. No changes were made.`);
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${claudeConfigPath}.local-coder-backup-${timestamp}`;
  fs.copyFileSync(claudeConfigPath, backupPath);
  console.error(`Backup created: ${backupPath}`);
}

const remoteWorkerUrl = `http://${host}:${port}`;
const controlPlaneConfig = {
  executionMode: 'remote',
  remoteWorkerUrl,
  remoteWorkerToken: token,
  model,
  updatedAt: new Date().toISOString()
};

// This file is the canonical control-plane credential/config shared by Claude's MCP
// process and the standalone Local Coder Console. Keep the bearer token out of shell
// profiles and browser code; environment variables may still override it deliberately.
fs.mkdirSync(path.dirname(controlPlaneConfigPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600
});
try {
  fs.chmodSync(controlPlaneConfigPath, 0o600);
} catch {
  // Windows/non-POSIX filesystems may not honor chmod. This installer normally runs on Mac.
}

config.mcpServers ??= {};
config.mcpServers['local-coder'] = {
  type: 'stdio',
  command: process.execPath,
  args: [serverPath],
  env: {
    LOCAL_CODER_EXECUTION_MODE: 'remote',
    LOCAL_CODER_REMOTE_WORKER_URL: remoteWorkerUrl,
    LOCAL_CODER_REMOTE_WORKER_TOKEN: token,
    LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS: '7200000',
    LOCAL_CODER_REMOTE_MAX_DELTA_BYTES: '8000000',
    LOCAL_CODER_ADAPTIVE_MODELS: 'false',
    LOCAL_CODER_MODEL: model,
    LOCAL_CODER_FAST_MODEL: model,
    LOCAL_CODER_STRONG_MODEL: model,
    LOCAL_CODER_NUM_CTX: '16384',
    LOCAL_CODER_MAX_CONTEXT_BYTES: '96000',
    LOCAL_CODER_TIMEOUT_MS: '600000',
    LOCAL_CODER_COGNITIVE_MODE: 'adaptive',
    LOCAL_CODER_MAX_DELIBERATION_PASSES: '3',
    LOCAL_CODER_QUALITY_GATE_MIN_SCORE: '80',
    LOCAL_CODER_RESEARCH_ENABLED: 'true',
    LOCAL_CODER_MICROSOFT_LEARN_RESEARCH_ENABLED: 'true'
  }
};

fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
fs.writeFileSync(claudeConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log(`Configured local-coder in strict remote-worker mode at ${remoteWorkerUrl}.`);
console.log(`Expected worker model: ${model}`);
console.log(`Shared control-plane config: ${controlPlaneConfigPath}`);
console.log('The bearer token was written to the protected shared control-plane config and Claude config; it is not printed here.');
console.log('Claude and the standalone Console now resolve the same worker URL/token/model by default.');
console.log('Remote mode does not silently fall back to local Mac inference if the worker is unavailable.');
console.log('Fully quit and reopen Claude before testing local_coder_health. The standalone Console can be started with npm run console.');
