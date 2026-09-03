import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EnvironmentSecretStore,
  MacOSKeychainSecretStore,
  providerSecretId,
  resolveSecretReference,
  type SecretReference,
  type SecretStore
} from './secret-store.js';

export interface CredentialProfile {
  id: string;
  providerId: string;
  label: string;
  /** Isolation boundary such as a company/account id. Corporate projects must match it exactly. */
  organizationId?: string;
  secret: SecretReference;
  createdAt: string;
  updatedAt: string;
}

interface CredentialStoreFile {
  version: 1;
  credentials: CredentialProfile[];
  updatedAt: string;
}

export interface CredentialManagerOptions {
  keychain?: SecretStore;
  environment?: SecretStore;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID.test(trimmed)) throw new Error(`${label} contains unsupported characters.`);
  return trimmed;
}

function assertLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) throw new Error('Credential label must be 1-160 characters.');
  return trimmed;
}

function validateProfile(value: unknown): CredentialProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    typeof item.providerId !== 'string' ||
    typeof item.label !== 'string' ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string' ||
    !item.secret ||
    typeof item.secret !== 'object' ||
    Array.isArray(item.secret)
  ) return undefined;
  const secret = item.secret as Record<string, unknown>;
  if (
    (secret.backend !== 'macos-keychain' && secret.backend !== 'environment') ||
    typeof secret.id !== 'string'
  ) return undefined;
  try {
    return {
      id: assertId(item.id, 'Credential id'),
      providerId: assertId(item.providerId, 'Provider id'),
      label: assertLabel(item.label),
      organizationId:
        typeof item.organizationId === 'string'
          ? assertId(item.organizationId, 'Organization id')
          : undefined,
      secret: { backend: secret.backend, id: secret.id },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  } catch {
    return undefined;
  }
}

export function credentialStorePath(): string {
  return process.env.LOCAL_CODER_CREDENTIALS_PATH?.trim() ||
    path.join(os.homedir(), '.local-coder-mcp', 'credentials.json');
}

export class CredentialProfileStore {
  constructor(private readonly file = credentialStorePath()) {}

  list(): CredentialProfile[] {
    return this.read().credentials.map((credential) => ({ ...credential, secret: { ...credential.secret } }));
  }

  get(id: string): CredentialProfile | undefined {
    const credentialId = assertId(id, 'Credential id');
    const found = this.read().credentials.find((credential) => credential.id === credentialId);
    return found ? { ...found, secret: { ...found.secret } } : undefined;
  }

  upsert(input: Omit<CredentialProfile, 'createdAt' | 'updatedAt'>): CredentialProfile {
    const id = assertId(input.id, 'Credential id');
    const providerId = assertId(input.providerId, 'Provider id');
    const label = assertLabel(input.label);
    const organizationId = input.organizationId
      ? assertId(input.organizationId, 'Organization id')
      : undefined;
    const state = this.read();
    const current = state.credentials.find((credential) => credential.id === id);
    if (current && current.providerId !== providerId) {
      throw new Error(`Credential ${id} already belongs to provider ${current.providerId}.`);
    }
    const now = new Date().toISOString();
    const profile: CredentialProfile = {
      id,
      providerId,
      label,
      organizationId,
      secret: { ...input.secret },
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    state.credentials = [profile, ...state.credentials.filter((credential) => credential.id !== id)];
    state.updatedAt = now;
    this.write(state);
    return { ...profile, secret: { ...profile.secret } };
  }

  remove(id: string): CredentialProfile | undefined {
    const credentialId = assertId(id, 'Credential id');
    const state = this.read();
    const current = state.credentials.find((credential) => credential.id === credentialId);
    if (!current) return undefined;
    state.credentials = state.credentials.filter((credential) => credential.id !== credentialId);
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return { ...current, secret: { ...current.secret } };
  }

  private read(): CredentialStoreFile {
    if (!fs.existsSync(this.file)) {
      return { version: 1, credentials: [], updatedAt: new Date(0).toISOString() };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read Local Coder credentials metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Local Coder credentials metadata must be a JSON object.');
    }
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Array.isArray(value.credentials)) {
      throw new Error(`Unsupported Local Coder credentials metadata version: ${String(value.version)}`);
    }
    const credentials = value.credentials.map(validateProfile);
    if (credentials.some((credential) => !credential)) {
      throw new Error('Local Coder credentials metadata contains an invalid credential profile.');
    }
    return {
      version: 1,
      credentials: credentials as CredentialProfile[],
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: CredentialStoreFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on non-POSIX */ }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }
}

export class CredentialManager {
  private readonly keychain: SecretStore;
  private readonly environment: SecretStore;

  constructor(
    private readonly profiles = new CredentialProfileStore(),
    options: CredentialManagerOptions = {}
  ) {
    this.keychain = options.keychain ?? new MacOSKeychainSecretStore();
    this.environment = options.environment ?? new EnvironmentSecretStore();
  }

  addOrReplaceKeychainCredential(input: {
    id: string;
    providerId: string;
    label: string;
    organizationId?: string;
    secret: string;
  }): CredentialProfile {
    if (!this.keychain.isAvailable()) {
      throw new Error('macOS Keychain is not available for persistent credential storage.');
    }

    // Validate metadata before mutating Keychain. Disk failures can still happen after the
    // secret write, so replacement also snapshots the previous secret for rollback.
    const id = assertId(input.id, 'Credential id');
    const providerId = assertId(input.providerId, 'Provider id');
    const label = assertLabel(input.label);
    const organizationId = input.organizationId
      ? assertId(input.organizationId, 'Organization id')
      : undefined;
    const secretId = providerSecretId(providerId, id);
    const existingProfile = this.profiles.get(id);
    if (existingProfile && existingProfile.providerId !== providerId) {
      throw new Error(`Credential ${id} already belongs to provider ${existingProfile.providerId}.`);
    }
    const previousSecret =
      existingProfile?.secret.backend === 'macos-keychain' && existingProfile.secret.id === secretId
        ? this.keychain.get(secretId)
        : undefined;

    this.keychain.set(secretId, input.secret);
    try {
      return this.profiles.upsert({
        id,
        providerId,
        label,
        organizationId,
        secret: { backend: 'macos-keychain', id: secretId }
      });
    } catch (error) {
      try {
        if (previousSecret !== undefined) this.keychain.set(secretId, previousSecret);
        else this.keychain.delete(secretId);
      } catch {
        // Do not mask the metadata failure. The caller can retry Replace/Remove and the
        // secret itself is never copied into the thrown error.
      }
      throw error;
    }
  }

  addEnvironmentCredential(input: {
    id: string;
    providerId: string;
    label: string;
    environmentVariable: string;
    organizationId?: string;
  }): CredentialProfile {
    return this.profiles.upsert({
      id: input.id,
      providerId: input.providerId,
      label: input.label,
      organizationId: input.organizationId,
      secret: { backend: 'environment', id: input.environmentVariable }
    });
  }

  updateMetadata(idValue: string, patch: { label?: string }): CredentialProfile {
    const profile = this.profiles.get(idValue);
    if (!profile) throw new Error(`Unknown credential: ${idValue}`);
    return this.profiles.upsert({
      id: profile.id,
      providerId: profile.providerId,
      label: patch.label === undefined ? profile.label : assertLabel(patch.label),
      organizationId: profile.organizationId,
      secret: { ...profile.secret }
    });
  }

  rotateKeychainCredential(idValue: string, secret: string): CredentialProfile {
    const profile = this.profiles.get(idValue);
    if (!profile) throw new Error(`Unknown credential: ${idValue}`);
    if (profile.secret.backend !== 'macos-keychain') {
      throw new Error(`Credential ${profile.id} is not stored in macOS Keychain and cannot be rotated here.`);
    }
    if (!secret.trim()) throw new Error('Replacement API key is required.');
    return this.addOrReplaceKeychainCredential({
      id: profile.id,
      providerId: profile.providerId,
      label: profile.label,
      organizationId: profile.organizationId,
      secret: secret.trim()
    });
  }

  resolve(id: string): string | undefined {
    const profile = this.profiles.get(id);
    if (!profile) return undefined;
    return resolveSecretReference(profile.secret, {
      keychain: this.keychain,
      environment: this.environment
    });
  }

  remove(id: string): boolean {
    const profile = this.profiles.get(id);
    if (!profile) return false;
    if (profile.secret.backend === 'macos-keychain') {
      this.keychain.delete(profile.secret.id);
    }
    this.profiles.remove(id);
    return true;
  }

  list(): CredentialProfile[] {
    return this.profiles.list();
  }

  getProfile(id: string): CredentialProfile | undefined {
    return this.profiles.get(id);
  }
}
