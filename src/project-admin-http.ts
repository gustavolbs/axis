import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ModelPricing } from './pricing-store.js';
import {
  ProjectAdminService,
  type CreateCredentialInput
} from './project-admin.js';
import type {
  CreateProjectInput,
  ModelSelection,
  ProjectBudgetPolicy,
  ProjectPrivacyPolicy,
  RoutingPolicy
} from './project-store.js';
import type {
  ModelRoutingProfile,
  ProviderRuntimeSettingsPatch
} from './provider-settings.js';

const ROUTING_POLICIES = new Set<RoutingPolicy>([
  'auto', 'local-first', 'balanced', 'speed-first', 'deep', 'frontier-only'
]);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 200_000
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error(`Request exceeds ${maxBytes} bytes.`);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object.');
  }
  return parsed as Record<string, unknown>;
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.toLowerCase();
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function requestAllowed(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  if (!MUTATING.has(request.method ?? 'GET')) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required.`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
  return value;
}

function optionalInteger(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer.`);
  return value;
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new Error(`${label}.${key} must be a string.`);
    result[key] = item;
  }
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value as string[];
}

function routingPolicy(value: unknown): RoutingPolicy {
  if (typeof value !== 'string' || !ROUTING_POLICIES.has(value as RoutingPolicy)) {
    throw new Error('defaultRoutingPolicy is invalid.');
  }
  return value as RoutingPolicy;
}

function modelSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('defaultModel must be an object.');
  }
  const item = value as Record<string, unknown>;
  if (item.mode === 'auto') return { mode: 'auto' };
  if (
    item.mode === 'explicit' &&
    typeof item.providerId === 'string' &&
    typeof item.modelId === 'string'
  ) {
    return { mode: 'explicit', providerId: item.providerId, modelId: item.modelId };
  }
  throw new Error('defaultModel must be Auto or an explicit provider/model selection.');
}

function privacyPolicy(value: unknown): ProjectPrivacyPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('privacy must be an object.');
  }
  const item = value as Record<string, unknown>;
  if (typeof item.cloudAllowed !== 'boolean') throw new Error('privacy.cloudAllowed must be boolean.');
  return {
    cloudAllowed: item.cloudAllowed,
    allowedProviderIds: stringArray(item.allowedProviderIds, 'privacy.allowedProviderIds')
  };
}

function optionalMoney(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a number or null.`);
  return value;
}

function budgetPatch(value: unknown): Partial<ProjectBudgetPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('budgets must be an object.');
  }
  const item = value as Record<string, unknown>;
  const result: Partial<ProjectBudgetPolicy> = {};
  if ('monthlyUsd' in item) result.monthlyUsd = optionalMoney(item.monthlyUsd, 'budgets.monthlyUsd');
  if ('dailyUsd' in item) result.dailyUsd = optionalMoney(item.dailyUsd, 'budgets.dailyUsd');
  if ('perJobUsd' in item) result.perJobUsd = optionalMoney(item.perJobUsd, 'budgets.perJobUsd');
  if ('warningFractions' in item) {
    if (!Array.isArray(item.warningFractions) || item.warningFractions.some((v) => typeof v !== 'number')) {
      throw new Error('budgets.warningFractions must be a number array.');
    }
    result.warningFractions = item.warningFractions as number[];
  }
  if ('hardStopFraction' in item) {
    if (typeof item.hardStopFraction !== 'number') throw new Error('budgets.hardStopFraction must be a number.');
    result.hardStopFraction = item.hardStopFraction;
  }
  return result;
}

function createProjectInput(body: Record<string, unknown>): CreateProjectInput {
  return {
    id: optionalString(body, 'id'),
    name: requiredString(body, 'name'),
    workspace: requiredString(body, 'workspace'),
    organizationId: requiredString(body, 'organizationId'),
    organizationName: optionalString(body, 'organizationName'),
    defaultRoutingPolicy:
      body.defaultRoutingPolicy === undefined ? undefined : routingPolicy(body.defaultRoutingPolicy),
    defaultModel: body.defaultModel === undefined ? undefined : modelSelection(body.defaultModel),
    privacy: body.privacy === undefined ? undefined : privacyPolicy(body.privacy),
    credentialProfileIds:
      body.credentialProfileIds === undefined
        ? undefined
        : stringMap(body.credentialProfileIds, 'credentialProfileIds'),
    budgets: body.budgets === undefined ? undefined : budgetPatch(body.budgets),
    concurrency: optionalInteger(body, 'concurrency')
  };
}

function projectPatch(body: Record<string, unknown>): Partial<Omit<CreateProjectInput, 'id'>> {
  const patch: Partial<Omit<CreateProjectInput, 'id'>> = {};
  if ('name' in body) patch.name = requiredString(body, 'name');
  if ('workspace' in body) patch.workspace = requiredString(body, 'workspace');
  if ('organizationId' in body) patch.organizationId = requiredString(body, 'organizationId');
  if ('organizationName' in body) patch.organizationName = optionalString(body, 'organizationName');
  if ('defaultRoutingPolicy' in body) patch.defaultRoutingPolicy = routingPolicy(body.defaultRoutingPolicy);
  if ('defaultModel' in body) patch.defaultModel = modelSelection(body.defaultModel);
  if ('privacy' in body) patch.privacy = privacyPolicy(body.privacy);
  if ('credentialProfileIds' in body) {
    patch.credentialProfileIds = stringMap(body.credentialProfileIds, 'credentialProfileIds');
  }
  if ('budgets' in body) patch.budgets = budgetPatch(body.budgets);
  if ('concurrency' in body) patch.concurrency = optionalInteger(body, 'concurrency');
  return patch;
}

function modelRoutingProfile(value: unknown, label: string): ModelRoutingProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const item = value as Record<string, unknown>;
  const profile: ModelRoutingProfile = {};
  if ('enabled' in item) {
    if (typeof item.enabled !== 'boolean') throw new Error(`${label}.enabled must be boolean.`);
    profile.enabled = item.enabled;
  }
  if ('frontier' in item) {
    if (typeof item.frontier !== 'boolean') throw new Error(`${label}.frontier must be boolean.`);
    profile.frontier = item.frontier;
  }
  if ('qualityScore' in item) {
    if (typeof item.qualityScore !== 'number') throw new Error(`${label}.qualityScore must be a number.`);
    profile.qualityScore = item.qualityScore;
  }
  return profile;
}

function providerPatch(body: Record<string, unknown>): ProviderRuntimeSettingsPatch {
  const patch: ProviderRuntimeSettingsPatch = {};
  if ('enabled' in body) patch.enabled = optionalBoolean(body, 'enabled');
  if ('defaultModelId' in body) {
    if (body.defaultModelId !== null && typeof body.defaultModelId !== 'string') {
      throw new Error('defaultModelId must be a string or null.');
    }
    patch.defaultModelId = body.defaultModelId as string | null;
  }
  if ('models' in body) {
    if (!body.models || typeof body.models !== 'object' || Array.isArray(body.models)) {
      throw new Error('models must be an object.');
    }
    patch.models = Object.fromEntries(
      Object.entries(body.models as Record<string, unknown>).map(([id, value]) => [
        id,
        modelRoutingProfile(value, `models.${id}`)
      ])
    );
  }
  return patch;
}

function credentialInput(body: Record<string, unknown>): CreateCredentialInput {
  const backend = requiredString(body, 'backend');
  const base = {
    id: requiredString(body, 'id'),
    providerId: requiredString(body, 'providerId'),
    label: requiredString(body, 'label'),
    organizationId: optionalString(body, 'organizationId')
  };
  if (backend === 'macos-keychain') {
    return { ...base, backend, secret: requiredString(body, 'secret') };
  }
  if (backend === 'environment') {
    return {
      ...base,
      backend,
      environmentVariable: requiredString(body, 'environmentVariable')
    };
  }
  throw new Error('backend must be macos-keychain or environment.');
}

function pricingInput(body: Record<string, unknown>): {
  providerId: string;
  modelId: string;
  pricing: ModelPricing;
} {
  const price = (key: string, required = false): number | undefined => {
    const value = body[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number.`);
    return value;
  };
  return {
    providerId: requiredString(body, 'providerId'),
    modelId: requiredString(body, 'modelId'),
    pricing: {
      inputPerMillionUsd: price('inputPerMillionUsd', true)!,
      outputPerMillionUsd: price('outputPerMillionUsd', true)!,
      cacheReadPerMillionUsd: price('cacheReadPerMillionUsd'),
      cacheWritePerMillionUsd: price('cacheWritePerMillionUsd'),
      source: optionalString(body, 'source'),
      verifiedAt: optionalString(body, 'verifiedAt')
    }
  };
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('Path id is not valid URL encoding.');
  }
}

function notFound(response: ServerResponse, message: string): true {
  sendJson(response, 404, { error: message });
  return true;
}

/** Returns true when the request belonged to the administrative API namespace. */
export async function handleProjectAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  admin: ProjectAdminService
): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://local-coder-console');
  const isAdminPath =
    url.pathname === '/api/projects' ||
    url.pathname.startsWith('/api/projects/') ||
    url.pathname === '/api/providers' ||
    url.pathname.startsWith('/api/providers/') ||
    url.pathname === '/api/credentials' ||
    url.pathname.startsWith('/api/credentials/') ||
    url.pathname === '/api/pricing';
  if (!isAdminPath) return false;

  if (!requestAllowed(request)) {
    sendJson(response, 403, {
      error: 'Project/provider/credential administration is restricted to loopback clients.'
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/projects') {
    sendJson(response, 200, { projects: admin.listProjects() });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/projects') {
    const project = admin.createProject(createProjectInput(await readJson(request)));
    sendJson(response, 201, { project });
    return true;
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(url.pathname);
  if (projectMatch) {
    const id = decodeId(projectMatch[1]);
    if (request.method === 'GET') {
      try {
        sendJson(response, 200, { project: admin.getProject(id) });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Project not found:')) {
          return notFound(response, error.message);
        }
        throw error;
      }
      return true;
    }
    if (request.method === 'PATCH') {
      sendJson(response, 200, { project: admin.updateProject(id, projectPatch(await readJson(request))) });
      return true;
    }
    if (request.method === 'DELETE') {
      if (!admin.removeProject(id)) return notFound(response, `Project not found: ${id}`);
      sendJson(response, 200, { removed: true });
      return true;
    }
  }

  const catalogMatch = /^\/api\/projects\/([^/]+)\/catalog$/.exec(url.pathname);
  if (request.method === 'GET' && catalogMatch) {
    sendJson(response, 200, { catalog: await admin.catalog(decodeId(catalogMatch[1])) });
    return true;
  }

  const usageMatch = /^\/api\/projects\/([^/]+)\/usage$/.exec(url.pathname);
  if (request.method === 'GET' && usageMatch) {
    sendJson(response, 200, { usage: admin.usage(decodeId(usageMatch[1])) });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/providers') {
    sendJson(response, 200, { providers: admin.listProviders() });
    return true;
  }
  const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(url.pathname);
  if (providerMatch && request.method === 'PATCH') {
    sendJson(response, 200, {
      provider: admin.updateProvider(decodeId(providerMatch[1]), providerPatch(await readJson(request)))
    });
    return true;
  }
  if (providerMatch && request.method === 'DELETE') {
    sendJson(response, 200, { removed: admin.removeProviderSettings(decodeId(providerMatch[1])) });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/credentials') {
    sendJson(response, 200, { credentials: admin.listCredentials() });
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/credentials') {
    sendJson(response, 201, {
      credential: admin.createCredential(credentialInput(await readJson(request)))
    });
    return true;
  }
  const credentialMatch = /^\/api\/credentials\/([^/]+)$/.exec(url.pathname);
  if (credentialMatch && request.method === 'DELETE') {
    const id = decodeId(credentialMatch[1]);
    if (!admin.removeCredential(id)) return notFound(response, `Credential not found: ${id}`);
    sendJson(response, 200, { removed: true });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/pricing') {
    sendJson(response, 200, { pricing: admin.listPricing() });
    return true;
  }
  if (request.method === 'PUT' && url.pathname === '/api/pricing') {
    const input = pricingInput(await readJson(request));
    sendJson(response, 200, {
      pricing: admin.setPricing(input.providerId, input.modelId, input.pricing)
    });
    return true;
  }
  if (request.method === 'DELETE' && url.pathname === '/api/pricing') {
    const providerId = url.searchParams.get('providerId');
    const modelId = url.searchParams.get('modelId');
    if (!providerId || !modelId) throw new Error('providerId and modelId query parameters are required.');
    sendJson(response, 200, { removed: admin.removePricing(providerId, modelId) });
    return true;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
  return true;
}
