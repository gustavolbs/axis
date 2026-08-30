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
const model =
  readArg('--model') ?? process.env.LOCAL_CODER_WINDOWS_MODEL ?? 'qwen3.6:35b-a3b-coding';
const projectRoot = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(projectRoot, 'dist', 'index.js');
const claudeConfigPath =
  process.env.LOCAL_CODER_CLAUDE_CONFIG_PATH ?? path.join(os.homedir(), '.claude.json');

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

config.mcpServers ??= {};
config.mcpServers['local-coder'] = {
  type: 'stdio',
  command: process.execPath,
  args: [serverPath],
  env: {
    LOCAL_CODER_EXECUTION_MODE: 'remote',
    LOCAL_CODER_REMOTE_WORKER_URL: `http://${host}:${port}`,
    LOCAL_CODER_REMOTE_WORKER_TOKEN: token,
    LOCAL_CODER_REMOTE_WORKER_TIMEOUT_MS: '1800000',
    LOCAL_CODER_REMOTE_MAX_DELTA_BYTES: '8000000',
    LOCAL_CODER_ADAPTIVE_MODELS: 'false',
    LOCAL_CODER_MODEL: model,
    LOCAL_CODER_FAST_MODEL: model,
    LOCAL_CODER_STRONG_MODEL: model,
    LOCAL_CODER_NUM_CTX: '16384',
    LOCAL_CODER_MAX_CONTEXT_BYTES: '96000',
    LOCAL_CODER_TIMEOUT_MS: '600000'
  }
};

fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
fs.writeFileSync(claudeConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

console.log(`Configured local-coder in strict remote-worker mode at http://${host}:${port}.`);
console.log(`Expected worker model: ${model}`);
console.log('The bearer token was written only to the user Claude config and is not printed here.');
console.log('Remote mode does not silently fall back to local Mac inference if the worker is unavailable.');
console.log('Fully quit and reopen Claude Code Desktop before testing local_coder_health.');
