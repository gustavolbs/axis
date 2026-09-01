import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppSettingsFile {
  version?: 1;
  executionMode?: 'remote' | 'auto' | 'local';
  remoteWorkerUrl?: string;
  remoteWorkerCredentialRef?: string;
  /** Base URL of the Ollama the runtime talks to when running locally. */
  ollamaBaseUrl?: string;
  /**
   * Route the worker answers its health check on. Not ours to assume: a
   * different deployment can serve it anywhere, and a hardcoded path 404s.
   */
  workerHealthPath?: string;
  model?: string;
  updatedAt?: string;
}

export function appHomePath(): string {
  return process.env.LOCAL_CODER_HOME?.trim() || path.join(os.homedir(), '.local-coder');
}

export function appSettingsPath(): string {
  return process.env.LOCAL_CODER_SETTINGS_PATH?.trim() || path.join(appHomePath(), 'settings.json');
}

function parseSettings(raw: string, source: string): AppSettingsFile | undefined {
  if (!raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Could not read Local Coder settings at ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Local Coder settings at ${source} must be a JSON object.`);
  }
  const value = parsed as Record<string, unknown>;
  const executionMode = value.executionMode === 'remote' || value.executionMode === 'auto' || value.executionMode === 'local'
    ? value.executionMode
    : undefined;
  return {
    version: 1,
    executionMode,
    remoteWorkerUrl: typeof value.remoteWorkerUrl === 'string' ? value.remoteWorkerUrl.trim() : undefined,
    remoteWorkerCredentialRef: typeof value.remoteWorkerCredentialRef === 'string' ? value.remoteWorkerCredentialRef.trim() : undefined,
    ollamaBaseUrl: typeof value.ollamaBaseUrl === 'string' ? value.ollamaBaseUrl.trim() : undefined,
    workerHealthPath: typeof value.workerHealthPath === 'string' ? value.workerHealthPath.trim() : undefined,
    model: typeof value.model === 'string' ? value.model.trim() : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined
  };
}

export function readAppSettings(): AppSettingsFile | undefined {
  const file = appSettingsPath();
  if (!fs.existsSync(file)) return undefined;
  return parseSettings(fs.readFileSync(file, 'utf8'), file);
}

export function writeAppSettings(settings: AppSettingsFile): void {
  const file = appSettingsPath();
  const safe: AppSettingsFile = {
    version: 1,
    executionMode: settings.executionMode,
    remoteWorkerUrl: settings.remoteWorkerUrl?.trim() || undefined,
    remoteWorkerCredentialRef: settings.remoteWorkerCredentialRef?.trim() || undefined,
    ollamaBaseUrl: settings.ollamaBaseUrl?.trim() || undefined,
    workerHealthPath: settings.workerHealthPath?.trim() || undefined,
    model: settings.model?.trim() || undefined,
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
