import { spawnSync } from 'node:child_process';

export type SecretBackend = 'macos-keychain' | 'environment';

export interface SecretReference {
  backend: SecretBackend;
  id: string;
}

export interface SecretStore {
  readonly backend: SecretBackend;
  isAvailable(): boolean;
  get(id: string): string | undefined;
  set(id: string, value: string): void;
  delete(id: string): boolean;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type KeychainCommandRunner = (args: string[], input?: string) => CommandResult;

const DEFAULT_KEYCHAIN_SERVICE = 'com.local-coder-mcp.secrets';
const KEYCHAIN_COMMAND_TIMEOUT_MS = 8_000;
const SAFE_SECRET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

function assertSecretId(id: string): string {
  const trimmed = id.trim();
  if (!SAFE_SECRET_ID.test(trimmed)) {
    throw new Error('Secret id must be 1-200 safe identifier characters.');
  }
  return trimmed;
}

function assertSecretValue(value: string): string {
  if (!value) throw new Error('Secret value cannot be empty.');
  if (value.includes('\0')) throw new Error('Secret value cannot contain NUL bytes.');
  return value;
}

function defaultRunner(args: string[], input?: string): CommandResult {
  const result = spawnSync('/usr/bin/security', args, {
    encoding: 'utf8',
    input,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error
  };
}

function missingItem(result: CommandResult): boolean {
  const message = result.stderr.toLowerCase();
  return (
    result.status === 44 ||
    message.includes('could not be found') ||
    message.includes('item not found') ||
    message.includes('errsecitemnotfound')
  );
}

function commandFailure(action: string, result: CommandResult, secret?: string): Error {
  const raw = result.error?.message || result.stderr.trim() || `exit status ${String(result.status)}`;
  const safe = secret ? raw.split(secret).join('[REDACTED]') : raw;
  return new Error(`macOS Keychain ${action} failed: ${safe}`);
}

/**
 * Stores small Local Coder secrets as generic password items in the user's macOS keychain.
 *
 * Apple's `security add-generic-password` does not read the password value from stdin when
 * `-w` is supplied without an argument; a bare `-w` opens an interactive prompt on the
 * controlling terminal instead. The desktop app has no terminal interaction contract, so
 * writes must supply the value as the `-w` argument. The command is spawned directly (no
 * shell), its arguments are never logged, failures redact the secret, and the subprocess has
 * a hard timeout so a Keychain prompt can never leave Settings stuck on "Saving…" forever.
 */
export class MacOSKeychainSecretStore implements SecretStore {
  readonly backend = 'macos-keychain' as const;

  constructor(
    private readonly service = DEFAULT_KEYCHAIN_SERVICE,
    private readonly runner: KeychainCommandRunner = defaultRunner,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  isAvailable(): boolean {
    if (this.platform !== 'darwin') return false;
    const result = this.runner(['help', 'find-generic-password']);
    return !result.error && result.status === 0;
  }

  get(id: string): string | undefined {
    this.assertAvailable();
    const account = assertSecretId(id);
    const result = this.runner([
      'find-generic-password',
      '-a', account,
      '-s', this.service,
      '-w'
    ]);
    if (missingItem(result)) return undefined;
    if (result.error || result.status !== 0) throw commandFailure('read', result);
    return result.stdout.replace(/\r?\n$/, '');
  }

  set(id: string, value: string): void {
    this.assertAvailable();
    const account = assertSecretId(id);
    const secret = assertSecretValue(value);
    const result = this.runner([
      'add-generic-password',
      '-a', account,
      '-s', this.service,
      '-U',
      '-w', secret
    ]);
    if (result.error || result.status !== 0) throw commandFailure('write', result, secret);
  }

  delete(id: string): boolean {
    this.assertAvailable();
    const account = assertSecretId(id);
    const result = this.runner([
      'delete-generic-password',
      '-a', account,
      '-s', this.service
    ]);
    if (missingItem(result)) return false;
    if (result.error || result.status !== 0) throw commandFailure('delete', result);
    return true;
  }

  private assertAvailable(): void {
    if (this.platform !== 'darwin') {
      throw new Error('macOS Keychain secret storage is only available on macOS.');
    }
  }
}

/** Read-only secret source for headless/CI use. Secret ids are environment variable names. */
export class EnvironmentSecretStore implements SecretStore {
  readonly backend = 'environment' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  isAvailable(): boolean {
    return true;
  }

  get(id: string): string | undefined {
    const name = assertSecretId(id);
    const value = this.env[name]?.trim();
    return value || undefined;
  }

  set(): void {
    throw new Error('EnvironmentSecretStore is read-only.');
  }

  delete(): boolean {
    throw new Error('EnvironmentSecretStore is read-only.');
  }
}

export function resolveSecretReference(
  reference: SecretReference,
  options: {
    keychain?: SecretStore;
    environment?: SecretStore;
  } = {}
): string | undefined {
  if (reference.backend === 'macos-keychain') {
    return (options.keychain ?? new MacOSKeychainSecretStore()).get(reference.id);
  }
  return (options.environment ?? new EnvironmentSecretStore()).get(reference.id);
}

export function providerSecretId(providerId: string, credentialId: string): string {
  const provider = assertSecretId(providerId);
  const credential = assertSecretId(credentialId);
  return `provider/${provider}/${credential}`;
}

export function remoteWorkerSecretId(profile = 'default'): string {
  return `remote-worker/${assertSecretId(profile)}`;
}
