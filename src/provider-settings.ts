import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ModelRoutingProfile {
  enabled?: boolean;
  frontier?: boolean;
  qualityScore?: number;
}

export interface ProviderRuntimeSettings {
  enabled: boolean;
  /** Model selected from provider discovery; no provider-specific model id is hardcoded here. */
  defaultModelId?: string;
  /** Undefined means unlimited provider API spend. */
  monthlyBudgetUsd?: number;
  models: Record<string, ModelRoutingProfile>;
}

export interface ProviderRuntimeSettingsPatch {
  enabled?: boolean;
  /** `null` clears the provider default and returns selection to Auto. */
  defaultModelId?: string | null;
  /** `null` disables the provider budget and returns usage to Unlimited. */
  monthlyBudgetUsd?: number | null;
  models?: Record<string, ModelRoutingProfile>;
}

interface ProviderSettingsFile {
  version: 1;
  providers: Record<string, ProviderRuntimeSettings>;
  updatedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeProviderId(value: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID.test(trimmed)) throw new Error('Provider id contains unsupported characters.');
  return trimmed;
}

function modelId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240 || /[\r\n\0]/.test(trimmed)) {
    throw new Error('Model id must be 1-240 characters without control line breaks.');
  }
  return trimmed;
}

function monthlyBudget(value: number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Provider monthly budget must be a positive USD amount.');
  }
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeProfile(input: ModelRoutingProfile = {}): ModelRoutingProfile {
  const qualityScore = input.qualityScore;
  if (qualityScore !== undefined && (!Number.isFinite(qualityScore) || qualityScore < 0 || qualityScore > 100)) {
    throw new Error('Model quality score must be between 0 and 100.');
  }
  return {
    enabled: input.enabled ?? true,
    frontier: input.frontier === true,
    qualityScore
  };
}

function normalizeSettings(input: Partial<ProviderRuntimeSettings> = {}): ProviderRuntimeSettings {
  const models: Record<string, ModelRoutingProfile> = {};
  for (const [id, profile] of Object.entries(input.models ?? {})) {
    models[modelId(id)] = normalizeProfile(profile);
  }
  const defaultModelId = input.defaultModelId ? modelId(input.defaultModelId) : undefined;
  if (defaultModelId && models[defaultModelId]?.enabled === false) {
    throw new Error(`Default model ${defaultModelId} is disabled in provider settings.`);
  }
  return {
    enabled: input.enabled ?? true,
    defaultModelId,
    monthlyBudgetUsd: monthlyBudget(input.monthlyBudgetUsd),
    models
  };
}

export function providerSettingsPath(): string {
  return process.env.LOCAL_CODER_PROVIDER_SETTINGS_PATH?.trim() ||
    path.join(os.homedir(), '.local-coder-mcp', 'providers.json');
}

export class ProviderSettingsStore {
  constructor(private readonly file = providerSettingsPath()) {}

  get(providerId: string): ProviderRuntimeSettings | undefined {
    const value = this.read().providers[safeProviderId(providerId)];
    return value ? structuredClone(value) : undefined;
  }

  list(): Record<string, ProviderRuntimeSettings> {
    return structuredClone(this.read().providers);
  }

  update(providerId: string, patch: ProviderRuntimeSettingsPatch): ProviderRuntimeSettings {
    const id = safeProviderId(providerId);
    const state = this.read();
    const current = state.providers[id] ?? { enabled: true, models: {} };
    const mergedModels = patch.models
      ? { ...current.models, ...patch.models }
      : current.models;
    const next = normalizeSettings({
      enabled: patch.enabled ?? current.enabled,
      defaultModelId:
        patch.defaultModelId === undefined
          ? current.defaultModelId
          : patch.defaultModelId === null
            ? undefined
            : patch.defaultModelId,
      monthlyBudgetUsd:
        patch.monthlyBudgetUsd === undefined
          ? current.monthlyBudgetUsd
          : patch.monthlyBudgetUsd === null
            ? undefined
            : patch.monthlyBudgetUsd,
      models: mergedModels
    });
    state.providers[id] = next;
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return structuredClone(next);
  }

  remove(providerId: string): boolean {
    const id = safeProviderId(providerId);
    const state = this.read();
    if (!(id in state.providers)) return false;
    delete state.providers[id];
    state.updatedAt = new Date().toISOString();
    this.write(state);
    return true;
  }

  private read(): ProviderSettingsFile {
    if (!fs.existsSync(this.file)) {
      return { version: 1, providers: {}, updatedAt: new Date(0).toISOString() };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Could not read provider settings: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Provider settings file must be a JSON object.');
    }
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
      throw new Error(`Unsupported provider settings version: ${String(value.version)}`);
    }
    const providers: Record<string, ProviderRuntimeSettings> = {};
    for (const [id, raw] of Object.entries(value.providers as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`Invalid provider settings for ${id}.`);
      }
      providers[safeProviderId(id)] = normalizeSettings(raw as Partial<ProviderRuntimeSettings>);
    }
    return {
      version: 1,
      providers,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
  }

  private write(state: ProviderSettingsFile): void {
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
