import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

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
const secretStorePath = path.join(projectRoot, 'dist', 'secret-store.js');
const controlPlaneConfigModulePath = path.join(projectRoot, 'dist', 'control-plane-config.js');
const claudeRemoteConfigPath = path.join(projectRoot, 'dist', 'claude-remote-config.js');
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
for (const required of [
  serverPath,
  secretStorePath,
  controlPlaneConfigModulePath,
  claudeRemoteConfigPath
]) {
  if (!fs.existsSync(required)) {
    console.error(`Missing ${required}. Run "npm run build" first.`);
    process.exit(1);
  }
}
if (process.platform !== 'darwin') {
  console.error('This control-plane installer now requires macOS Keychain and must run on the Mac control plane.');
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

const [
  { MacOSKeychainSecretStore, remoteWorkerSecretId },
  { writeControlPlaneConfig },
  { buildClaudeRemoteWorkerConfig }
] = await Promise.all([
  import(pathToFileURL(secretStorePath).href),
  import(pathToFileURL(controlPlaneConfigModulePath).href),
  import(pathToFileURL(claudeRemoteConfigPath).href)
]);

const keychain = new MacOSKeychainSecretStore();
if (!keychain.isAvailable()) {
  console.error('macOS Keychain is unavailable. Refusing to persist the worker bearer token in plaintext.');
  process.exit(1);
}

const remoteWorkerUrl = `http://${host}:${port}`;
const credentialRef = remoteWorkerSecretId('default');
keychain.set(credentialRef, token);

// v2 control-plane files contain only a Keychain reference. readControlPlaneConfig still
// accepts the legacy v0.14 inline token field so existing installations remain usable.
writeControlPlaneConfig({
  version: 2,
  executionMode: 'remote',
  remoteWorkerUrl,
  remoteWorkerCredentialRef: credentialRef,
  model
});

config = buildClaudeRemoteWorkerConfig(config, {
  serverPath,
  remoteWorkerUrl,
  credentialRef,
  model
});

fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
fs.writeFileSync(claudeConfigPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
try {
  fs.chmodSync(claudeConfigPath, 0o600);
} catch {
  // Non-POSIX filesystems may not honor chmod. This installer is intended for macOS.
}

console.log(`Configured local-coder in strict remote-worker mode at ${remoteWorkerUrl}.`);
console.log(`Expected worker model: ${model}`);
console.log(`Shared control-plane config: ${controlPlaneConfigPath}`);
console.log(`Worker credential: macOS Keychain reference ${credentialRef}`);
console.log('The bearer token is not stored in control-plane.json, Claude MCP env, logs, or shell profiles.');
console.log('Claude and the standalone Console resolve the same Keychain-backed worker credential.');
console.log('Remote mode does not silently fall back to local Mac inference if the worker is unavailable.');
console.log('Fully quit and reopen Claude before testing local_coder_health. The standalone Console can be started with npm run console.');
