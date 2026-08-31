import type {
  InferenceProvider,
  ModelDefinition,
  ProviderHealth
} from './types.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, InferenceProvider>();

  constructor(providers: InferenceProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: InferenceProvider): void {
    if (!provider.id.trim()) throw new Error('Provider id is required.');
    if (this.providers.has(provider.id)) {
      throw new Error(`Inference provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): InferenceProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Inference provider is not registered: ${id}`);
    return provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): InferenceProvider[] {
    return [...this.providers.values()];
  }

  async listModels(): Promise<ModelDefinition[]> {
    const groups = await Promise.all(this.list().map((provider) => provider.listModels()));
    return groups.flat();
  }

  async health(): Promise<ProviderHealth[]> {
    return await Promise.all(
      this.list().map(async (provider) => {
        try {
          return await provider.health();
        } catch (error) {
          return {
            providerId: provider.id,
            ok: false,
            checkedAt: new Date().toISOString(),
            latencyMs: 0,
            message: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
  }
}
