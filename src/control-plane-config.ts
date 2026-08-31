import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ControlPlaneConfigFile {
  executionMode?: 'remote' | 'auto' | 'local';
  remoteWorkerUrl?: string;
  remoteWorkerToken?: string;
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
  return {
    executionMode,
    remoteWorkerUrl: typeof value.remoteWorkerUrl === 'string' ? value.remoteWorkerUrl.trim() : undefined,
    remoteWorkerToken:
      typeof value.remoteWorkerToken === 'string' ? value.remoteWorkerToken.trim() : undefined,
    model: typeof value.model === 'string' ? value.model.trim() : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined
  };
}
