import { ProviderConnectionRuntime, type ProviderConnectionView } from './provider-connections.js';
import type {
  PersonalChatCatalog,
  PersonalChatCatalogModel,
  PersonalChatCatalogProvider
} from './project-provider-runtime.js';
import type { InferenceProvider, ModelDefinition } from './providers/types.js';

function isConversational(view: ProviderConnectionView, model: ModelDefinition): boolean {
  if (view.auth === 'claude-account' || view.auth === 'chatgpt-account' || view.auth === 'local') return true;
  const id = model.id.toLowerCase();
  if (view.providerFamily === 'anthropic') return /^claude-/i.test(model.id);
  if (view.providerFamily === 'openai' && /(?:sora|babbage|davinci|instruct|search)/i.test(model.id)) return false;
  if (view.providerFamily === 'openai' && /^gpt-4(?:[.-]|$)/i.test(model.id)) return false;
  if (view.providerFamily === 'openai' && /-\d{4}-\d{2}-\d{2}$/i.test(model.id)) return false;
  return !/(?:image|audio|realtime|transcrib|tts|embedding|moderation|whisper)/.test(id);
}

function catalogModel(model: ModelDefinition): PersonalChatCatalogModel {
  return {
    id: model.id,
    displayName: model.displayName,
    createdAt: model.createdAt,
    available: true,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    providerDefault: false,
    projectDefault: false
  };
}

function providerView(view: ProviderConnectionView, models: PersonalChatCatalogModel[], reason?: string): PersonalChatCatalogProvider {
  return {
    id: view.id,
    label: view.label,
    providerFamily: view.providerFamily,
    auth: view.auth,
    billing: view.billing,
    organizationLabel: view.organizationLabel,
    kind: view.auth === 'local' ? 'local' : 'cloud',
    ready: view.available && models.length > 0,
    reason: view.available && models.length > 0 ? undefined : reason ?? view.reason ?? `${view.label} has no available Chat models.`,
    models
  };
}

/**
 * Projectless corporate Chat is still Company-scoped. This adapter deliberately
 * reuses the same connection-isolation check as Projects instead of resolving a
 * provider by brand or trusting a renderer-supplied credential identity.
 */
export class CompanyChatRuntime {
  constructor(private readonly connections: ProviderConnectionRuntime) {}

  async catalog(companyId: string): Promise<PersonalChatCatalog> {
    const providers: PersonalChatCatalogProvider[] = [];
    for (const view of this.connections.viewsForOrganization(companyId)) {
      if (!view.available) {
        providers.push(providerView(view, [], view.reason));
        continue;
      }
      try {
        const provider = this.connections.providerForProject(view.id, companyId);
        const models = (await provider.listModels()).filter((model) => isConversational(view, model)).map(catalogModel);
        providers.push(providerView(view, models));
      } catch (error) {
        providers.push(providerView(view, [], error instanceof Error ? error.message : String(error)));
      }
    }
    return { scope: 'personal', projectId: '', defaultModel: { mode: 'auto' }, providers };
  }

  async modelDefinition(companyId: string, connectionId: string, modelId: string): Promise<{ provider: InferenceProvider; model: ModelDefinition }> {
    const allowed = this.connections.viewsForOrganization(companyId).some((view) => view.id === connectionId);
    if (!allowed) throw new Error(`Connection ${connectionId} is not available in Company ${companyId}.`);
    const provider = this.connections.providerForProject(connectionId, companyId);
    const view = this.connections.view(connectionId);
    const model = (await provider.listModels()).find((candidate) => candidate.id === modelId && (!view || isConversational(view, candidate)));
    if (!model) throw new Error(`Model ${modelId} is not available through ${connectionId} in Company ${companyId}.`);
    return { provider, model };
  }
}
