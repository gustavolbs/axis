import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ControlPlaneConfigFile {
  version?: 1 | 2;
  executionMode?: 'remote' | 'auto' | 'local';
  remoteWorkerUrl?: string;
  /**
   * Legacy v0.14 field. Read-only compatibility: new writers must use
   * `remoteWorkerCredentialRef` instead of persisting bearer tokens here.
   */
  remoteWorkerToken?: string;
  /** Secret id stored in macOS Keychain. */
  remoteWorkerCredentialRef?: string;
  model?: string;
  updatedAt?: string;
}

export function controlPlaneConfigPath(): string {
  return process.env.LOCAL_CODER_CONTROL_PLANE_CONFIG_PATH?.trim() ||
    path.join(os.homedir(), '.local-coder-mcp', 'control-plane.json');
}

export function readControlPlaneConfig(): ControlPlaneConfigFile | undefined {
  const file = controlPlaneConfigPath();
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return undefined;
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read Local Coder control-plane config at ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Local Coder control-plane config at ${file} must be a JSON object.`);
  }
  const value = parsed as Record<string, unknown>;
  const executionMode =
    value.executionMode === 'remote' || value.executionMode === 'auto' || value.executionMode === 'local'
      ? value.executionMode
      : undefined;
  const version = value.version === 2 ? 2 : value.version === 1 ? 1 : undefined;
  return {
    version,
    executionMode,
    remoteWorkerUrl: typeof value.remoteWorkerUrl === 'string' ? value.remoteWorkerUrl.trim() : undefined,
    remoteWorkerToken:
      typeof value.remoteWorkerToken === 'string' ? value.remoteWorkerToken.trim() : undefined,
    remoteWorkerCredentialRef:
      typeof value.remoteWorkerCredentialRef === 'string'
        ? value.remoteWorkerCredentialRef.trim()
        : undefined,
    model: typeof value.model === 'string' ? value.model.trim() : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined
  };
}

/**
 * Writes only non-secret control-plane configuration. Legacy inline bearer tokens are
 * intentionally excluded even if a caller passes an object read from a v1 installation.
 */
export function writeControlPlaneConfig(config: ControlPlaneConfigFile): void {
  const file = controlPlaneConfigPath();
  const safe: ControlPlaneConfigFile = {
    version: 2,
    executionMode: config.executionMode,
    remoteWorkerUrl: config.remoteWorkerUrl?.trim() || undefined,
    remoteWorkerCredentialRef: config.remoteWorkerCredentialRef?.trim() || undefined,
    model: config.model?.trim() || undefined,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on non-POSIX */ }
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}
