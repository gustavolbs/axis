import { useEffect, useMemo, useState, type FormEvent } from 'react';

export type RoutingPolicy = 'auto' | 'local-first' | 'balanced' | 'speed-first' | 'deep' | 'frontier-only';
export type ModelSelection = { mode: 'auto' } | { mode: 'explicit'; providerId: string; modelId: string };

export interface AdminProject {
  id: string;
  name: string;
  workspace: string;
  organizationId: string;
  organizationName?: string;
  defaultRoutingPolicy: RoutingPolicy;
  defaultModel: ModelSelection;
  privacy: { cloudAllowed: boolean; allowedProviderIds: string[] };
  credentialProfileIds: Record<string, string>;
  budgets: {
    monthlyUsd?: number;
    dailyUsd?: number;
    perJobUsd?: number;
    warningFractions: number[];
    hardStopFraction: number;
  };
  concurrency: number;
  createdAt: string;
  updatedAt: string;
}

interface Credential {
  id: string;
  providerId: string;
  label: string;
  organizationId?: string;
  backend: 'macos-keychain' | 'environment';
  environmentVariable?: string;
  available: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  source?: string;
  verifiedAt?: string;
}

interface ModelRoutingProfile {
  enabled?: boolean;
  frontier?: boolean;
  qualityScore?: number;
}

interface ProviderAdmin {
  id: string;
  kind: 'local' | 'cloud';
  builtIn: boolean;
  settings: {
    enabled: boolean;
    defaultModelId?: string;
    models: Record<string, ModelRoutingProfile>;
  };
  credentials: Credential[];
  pricing: Record<string, ModelPricing>;
}

interface CatalogModel {
  id: string;
  displayName: string;
  available: boolean;
  routing: ModelRoutingProfile;
  pricing?: ModelPricing;
  providerDefault: boolean;
  projectDefault: boolean;
}

interface CatalogProvider {
  id: string;
  kind: 'local' | 'cloud';
  enabled: boolean;
  ready: boolean;
  reason?: string;
  credentialProfileId?: string;
  credentialAvailable?: boolean;
  models: CatalogModel[];
}

interface ProjectCatalog {
  projectId: string;
  defaultRoutingPolicy: RoutingPolicy;
  defaultModel: ModelSelection;
  providers: CatalogProvider[];
}

interface UsagePeriod {
  events: number;
  cloudEvents: number;
  localEvents: number;
  knownCostUsd: number;
  unknownCostEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
}

interface ProjectUsage {
  projectId: string;
  budgets: AdminProject['budgets'];
  daily: UsagePeriod;
  monthly: UsagePeriod;
  activeReservations: { count: number; upperBoundUsd: number };
}

interface ProjectDraft {
  name: string;
  workspace: string;
  organizationId: string;
  organizationName: string;
  defaultRoutingPolicy: RoutingPolicy;
  defaultModel: string;
  cloudAllowed: boolean;
  allowedProviderIds: string[];
  credentialProfileIds: Record<string, string>;
  monthlyUsd: string;
  dailyUsd: string;
  perJobUsd: string;
  concurrency: string;
}

interface CredentialDraft {
  id: string;
  providerId: string;
  label: string;
  organizationId: string;
  backend: 'macos-keychain' | 'environment';
  secret: string;
  environmentVariable: string;
}

interface PricingDraft {
  providerId: string;
  modelId: string;
  inputPerMillionUsd: string;
  outputPerMillionUsd: string;
  cacheReadPerMillionUsd: string;
  cacheWritePerMillionUsd: string;
  source: string;
}

const policies: RoutingPolicy[] = ['auto', 'local-first', 'balanced', 'speed-first', 'deep', 'frontier-only'];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function usd(value?: number): string {
  if (value === undefined) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function optionalPositive(value: string, label: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive or blank.`);
  return parsed;
}

function optionalNonNegative(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be non-negative.`);
  return parsed;
}

function modelValue(selection: ModelSelection): string {
  return selection.mode === 'auto' ? 'auto' : `${selection.providerId}\0${selection.modelId}`;
}

function parseModelValue(value: string): ModelSelection {
  if (value === 'auto') return { mode: 'auto' };
  const split = value.indexOf('\0');
  if (split <= 0) throw new Error('Invalid model selection.');
  return { mode: 'explicit', providerId: value.slice(0, split), modelId: value.slice(split + 1) };
}

function draftFromProject(project: AdminProject): ProjectDraft {
  return {
    name: project.name,
    workspace: project.workspace,
    organizationId: project.organizationId,
    organizationName: project.organizationName ?? '',
    defaultRoutingPolicy: project.defaultRoutingPolicy,
    defaultModel: modelValue(project.defaultModel),
    cloudAllowed: project.privacy.cloudAllowed,
    allowedProviderIds: [...project.privacy.allowedProviderIds],
    credentialProfileIds: { ...project.credentialProfileIds },
    monthlyUsd: project.budgets.monthlyUsd?.toString() ?? '',
    dailyUsd: project.budgets.dailyUsd?.toString() ?? '',
    perJobUsd: project.budgets.perJobUsd?.toString() ?? '',
    concurrency: project.concurrency.toString()
  };
}

function emptyCredential(providerId = 'anthropic'): CredentialDraft {
  return {
    id: '',
    providerId,
    label: '',
    organizationId: '',
    backend: 'macos-keychain',
    secret: '',
    environmentVariable: ''
  };
}

function emptyPricing(providerId = 'anthropic'): PricingDraft {
  return {
    providerId,
    modelId: '',
    inputPerMillionUsd: '',
    outputPerMillionUsd: '',
    cacheReadPerMillionUsd: '',
    cacheWritePerMillionUsd: '',
    source: ''
  };
}

export function AdminPanel({ onRunProject }: { onRunProject: (project: AdminProject) => void }) {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [providers, setProviders] = useState<ProviderAdmin[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [catalog, setCatalog] = useState<ProjectCatalog>();
  const [usage, setUsage] = useState<ProjectUsage>();
  const [draft, setDraft] = useState<ProjectDraft>();
  const [newProject, setNewProject] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState<CredentialDraft>(emptyCredential);
  const [pricingDraft, setPricingDraft] = useState<PricingDraft>(emptyPricing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const active = projects.find((project) => project.id === activeId) ?? projects[0];
  const cloudProviders = providers.filter((provider) => provider.kind === 'cloud');

  async function loadGlobal(preferredId?: string) {
    const [{ projects: nextProjects }, { providers: nextProviders }, { credentials: nextCredentials }] = await Promise.all([
      requestJson<{ projects: AdminProject[] }>('/api/projects'),
      requestJson<{ providers: ProviderAdmin[] }>('/api/providers'),
      requestJson<{ credentials: Credential[] }>('/api/credentials')
    ]);
    setProjects(nextProjects);
    setProviders(nextProviders);
    setCredentials(nextCredentials);
    if (nextProviders.some((provider) => provider.id === credentialDraft.providerId) === false && nextProviders[0]) {
      setCredentialDraft((current) => ({ ...current, providerId: nextProviders.find((provider) => provider.kind === 'cloud')?.id ?? current.providerId }));
    }
    const targetId = preferredId ?? activeId ?? nextProjects[0]?.id;
    setActiveId(targetId && nextProjects.some((project) => project.id === targetId) ? targetId : nextProjects[0]?.id);
  }

  async function loadProject(id: string) {
    const [{ catalog: nextCatalog }, { usage: nextUsage }] = await Promise.all([
      requestJson<{ catalog: ProjectCatalog }>(`/api/projects/${encodeURIComponent(id)}/catalog`),
      requestJson<{ usage: ProjectUsage }>(`/api/projects/${encodeURIComponent(id)}/usage`)
    ]);
    setCatalog(nextCatalog);
    setUsage(nextUsage);
  }

  useEffect(() => {
    void loadGlobal().catch((next) => setError(next instanceof Error ? next.message : String(next)));
  }, []);

  useEffect(() => {
    if (!active) {
      setCatalog(undefined);
      setUsage(undefined);
      setDraft(undefined);
      return;
    }
    setDraft(draftFromProject(active));
    void loadProject(active.id).catch((next) => setError(next instanceof Error ? next.message : String(next)));
  }, [active?.id, active?.updatedAt]);

  const modelOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [{ value: 'auto', label: 'Auto' }];
    for (const provider of catalog?.providers ?? []) {
      for (const model of provider.models) {
        options.push({
          value: `${provider.id}\0${model.id}`,
          label: `${provider.id} / ${model.displayName}${model.available ? '' : ' (unavailable)'}`
        });
      }
    }
    return options;
  }, [catalog]);

  function updateDraft(patch: Partial<ProjectDraft>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }

  async function mutate<T>(run: () => Promise<T>, message: string, preferredId?: string): Promise<T | undefined> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await run();
      await loadGlobal(preferredId);
      if (preferredId) await loadProject(preferredId);
      setNotice(message);
      return result;
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function saveProject() {
    if (!active || !draft) return;
    try {
      const concurrency = Number(draft.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
        throw new Error('Concurrency must be an integer between 1 and 32.');
      }
      if (draft.allowedProviderIds.length === 0) throw new Error('At least one provider must be allowed.');
      const credentialProfileIds = Object.fromEntries(
        Object.entries(draft.credentialProfileIds).filter(([, value]) => Boolean(value))
      );
      await mutate(
        () => requestJson(`/api/projects/${encodeURIComponent(active.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: draft.name,
            workspace: draft.workspace,
            organizationId: draft.organizationId,
            organizationName: draft.organizationName || undefined,
            defaultRoutingPolicy: draft.defaultRoutingPolicy,
            defaultModel: parseModelValue(draft.defaultModel),
            privacy: { cloudAllowed: draft.cloudAllowed, allowedProviderIds: draft.allowedProviderIds },
            credentialProfileIds,
            budgets: {
              monthlyUsd: optionalPositive(draft.monthlyUsd, 'Monthly budget'),
              dailyUsd: optionalPositive(draft.dailyUsd, 'Daily budget'),
              perJobUsd: optionalPositive(draft.perJobUsd, 'Per-job budget')
            },
            concurrency
          })
        }),
        'Project settings saved.',
        active.id
      );
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const workspace = String(form.get('workspace') ?? '').trim();
    const organizationId = String(form.get('organizationId') ?? '').trim();
    const organizationName = String(form.get('organizationName') ?? '').trim();
    if (!name || !workspace || !organizationId) return;
    setBusy(true);
    setError(undefined);
    try {
      const { project } = await requestJson<{ project: AdminProject }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name,
          workspace,
          organizationId,
          organizationName: organizationName || undefined,
          defaultRoutingPolicy: 'local-first',
          defaultModel: { mode: 'auto' },
          privacy: { cloudAllowed: false, allowedProviderIds: ['ollama'] },
          concurrency: 1
        })
      });
      await loadGlobal(project.id);
      await loadProject(project.id);
      setNewProject(false);
      setNotice('Project created with local-only defaults.');
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    } finally {
      setBusy(false);
    }
  }

  async function removeProject() {
    if (!active || !window.confirm(`Delete Project “${active.name}”? This does not delete the repository.`)) return;
    await mutate(() => requestJson(`/api/projects/${encodeURIComponent(active.id)}`, { method: 'DELETE' }), 'Project removed.');
  }

  async function saveProvider(provider: ProviderAdmin, patch: Record<string, unknown>) {
    await mutate(
      () => requestJson(`/api/providers/${encodeURIComponent(provider.id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      `${provider.id} settings updated.`,
      active?.id
    );
  }

  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = credentialDraft.backend === 'macos-keychain'
      ? {
          backend: credentialDraft.backend,
          id: credentialDraft.id,
          providerId: credentialDraft.providerId,
          label: credentialDraft.label,
          organizationId: credentialDraft.organizationId || undefined,
          secret: credentialDraft.secret
        }
      : {
          backend: credentialDraft.backend,
          id: credentialDraft.id,
          providerId: credentialDraft.providerId,
          label: credentialDraft.label,
          organizationId: credentialDraft.organizationId || undefined,
          environmentVariable: credentialDraft.environmentVariable
        };
    const result = await mutate(
      () => requestJson('/api/credentials', { method: 'POST', body: JSON.stringify(input) }),
      'Credential saved. Secret values remain outside Project metadata.',
      active?.id
    );
    if (result) setCredentialDraft(emptyCredential(cloudProviders[0]?.id));
  }

  async function removeCredential(id: string) {
    if (!window.confirm(`Delete credential profile “${id}”?`)) return;
    await mutate(() => requestJson(`/api/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Credential removed.', active?.id);
  }

  function editPricing(providerId: string, model: CatalogModel) {
    setPricingDraft({
      providerId,
      modelId: model.id,
      inputPerMillionUsd: model.pricing?.inputPerMillionUsd?.toString() ?? '',
      outputPerMillionUsd: model.pricing?.outputPerMillionUsd?.toString() ?? '',
      cacheReadPerMillionUsd: model.pricing?.cacheReadPerMillionUsd?.toString() ?? '',
      cacheWritePerMillionUsd: model.pricing?.cacheWritePerMillionUsd?.toString() ?? '',
      source: model.pricing?.source ?? ''
    });
  }

  async function savePricing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const input = optionalNonNegative(pricingDraft.inputPerMillionUsd, 'Input price');
      const output = optionalNonNegative(pricingDraft.outputPerMillionUsd, 'Output price');
      if (!pricingDraft.providerId || !pricingDraft.modelId || input === undefined || output === undefined) {
        throw new Error('Provider, model, input price and output price are required.');
      }
      await mutate(
        () => requestJson('/api/pricing', {
          method: 'PUT',
          body: JSON.stringify({
            providerId: pricingDraft.providerId,
            modelId: pricingDraft.modelId,
            inputPerMillionUsd: input,
            outputPerMillionUsd: output,
            cacheReadPerMillionUsd: optionalNonNegative(pricingDraft.cacheReadPerMillionUsd, 'Cache read price'),
            cacheWritePerMillionUsd: optionalNonNegative(pricingDraft.cacheWritePerMillionUsd, 'Cache write price'),
            source: pricingDraft.source || undefined,
            verifiedAt: new Date().toISOString()
          })
        }),
        'Pricing saved. Budget admission will use this price sheet.',
        active?.id
      );
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next));
    }
  }

  async function removePricing() {
    if (!pricingDraft.providerId || !pricingDraft.modelId) return;
    const result = await mutate(
      () => requestJson(`/api/pricing?providerId=${encodeURIComponent(pricingDraft.providerId)}&modelId=${encodeURIComponent(pricingDraft.modelId)}`, { method: 'DELETE' }),
      'Pricing removed.',
      active?.id
    );
    if (result) setPricingDraft(emptyPricing(cloudProviders[0]?.id));
  }

  function toggleAllowedProvider(providerId: string, checked: boolean) {
    if (!draft) return;
    updateDraft({
      allowedProviderIds: checked
        ? [...new Set([...draft.allowedProviderIds, providerId])]
        : draft.allowedProviderIds.filter((id) => id !== providerId)
    });
  }

  return <div className="admin-shell">
    <div className="admin-toolbar">
      <div><span className="eyebrow">CONTROL PLANE</span><h2>Projects & model routing</h2><p>Isolation, providers, credentials and spend controls are enforced by the local backend.</p></div>
      <button className="primary" onClick={() => setNewProject((value) => !value)}>{newProject ? 'Close' : 'New Project'}</button>
    </div>

    {error ? <div className="error-banner">{error}</div> : null}
    {notice ? <div className="notice-banner">{notice}</div> : null}

    {newProject ? <form className="panel admin-create" onSubmit={(event) => void createProject(event)}>
      <div className="panel-heading"><div><span className="eyebrow">NEW PROJECT</span><strong>Local-only by default</strong></div></div>
      <div className="form-grid four">
        <label>Name<input name="name" required placeholder="Acme Dashboard" /></label>
        <label>Workspace<input name="workspace" required placeholder="/Users/you/work/acme" /></label>
        <label>Organization ID<input name="organizationId" required placeholder="acme" /></label>
        <label>Organization name<input name="organizationName" placeholder="Acme Inc." /></label>
      </div>
      <button className="primary" disabled={busy}>Create Project</button>
    </form> : null}

    <div className="admin-layout">
      <aside className="project-rail panel">
        <div className="panel-heading"><span className="eyebrow">PROJECTS</span><strong>{projects.length}</strong></div>
        {projects.length === 0 ? <p className="muted small">Create a Project to isolate a workspace, credentials and budget.</p> : projects.map((project) => (
          <button key={project.id} className={`project-row ${active?.id === project.id ? 'active' : ''}`} onClick={() => setActiveId(project.id)}>
            <div><strong>{project.name}</strong><span>{project.organizationName ?? project.organizationId}</span></div>
            <span className={`status-pill ${project.privacy.cloudAllowed ? 'live' : 'good'}`}>{project.defaultRoutingPolicy}</span>
          </button>
        ))}
      </aside>

      <div className="admin-main">
        {!active || !draft ? <section className="panel empty"><p>Select or create a Project.</p></section> : <>
          <section className="panel project-hero">
            <div><span className="eyebrow">{active.organizationName ?? active.organizationId}</span><h2>{active.name}</h2><p>{active.workspace}</p></div>
            <div className="project-actions"><button className="secondary" onClick={() => onRunProject(active)}>Run agent</button><button className="danger" onClick={() => void removeProject()}>Delete</button></div>
          </section>

          <div className="cards four admin-metrics">
            <section className="panel metric-card"><span>Today</span><strong>{usd(usage?.daily.knownCostUsd)}</strong><small>{usage?.daily.events ?? 0} events · {usage?.daily.unknownCostEvents ?? 0} unpriced</small></section>
            <section className="panel metric-card"><span>This month</span><strong>{usd(usage?.monthly.knownCostUsd)}</strong><small>{usage?.monthly.cloudEvents ?? 0} cloud calls</small></section>
            <section className="panel metric-card"><span>Reservations</span><strong>{usage?.activeReservations.count ?? 0}</strong><small>{usd(usage?.activeReservations.upperBoundUsd)} upper bound</small></section>
            <section className="panel metric-card"><span>Default model</span><strong className="metric-model">{active.defaultModel.mode === 'auto' ? 'Auto' : active.defaultModel.modelId}</strong><small>{active.defaultModel.mode === 'auto' ? active.defaultRoutingPolicy : active.defaultModel.providerId}</small></section>
          </div>

          <section className="panel admin-section">
            <div className="panel-heading"><div><span className="eyebrow">PROJECT POLICY</span><strong>Routing, privacy and budgets</strong></div><button className="primary" disabled={busy} onClick={() => void saveProject()}>Save Project</button></div>
            <div className="form-grid three">
              <label>Name<input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} /></label>
              <label>Workspace<input value={draft.workspace} onChange={(event) => updateDraft({ workspace: event.target.value })} /></label>
              <label>Organization ID<input value={draft.organizationId} onChange={(event) => updateDraft({ organizationId: event.target.value })} /></label>
              <label>Organization name<input value={draft.organizationName} onChange={(event) => updateDraft({ organizationName: event.target.value })} /></label>
              <label>Routing policy<select value={draft.defaultRoutingPolicy} onChange={(event) => updateDraft({ defaultRoutingPolicy: event.target.value as RoutingPolicy })}>{policies.map((policy) => <option key={policy}>{policy}</option>)}</select></label>
              <label>Default model<select value={draft.defaultModel} onChange={(event) => updateDraft({ defaultModel: event.target.value })}>{modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label>Concurrency<input type="number" min="1" max="32" value={draft.concurrency} onChange={(event) => updateDraft({ concurrency: event.target.value })} /></label>
              <label>Daily budget USD<input type="number" min="0.01" step="0.01" value={draft.dailyUsd} onChange={(event) => updateDraft({ dailyUsd: event.target.value })} placeholder="unlimited" /></label>
              <label>Monthly budget USD<input type="number" min="0.01" step="0.01" value={draft.monthlyUsd} onChange={(event) => updateDraft({ monthlyUsd: event.target.value })} placeholder="unlimited" /></label>
              <label>Per-job budget USD<input type="number" min="0.01" step="0.01" value={draft.perJobUsd} onChange={(event) => updateDraft({ perJobUsd: event.target.value })} placeholder="unlimited" /></label>
            </div>
            <label className="check-row cloud-policy"><input type="checkbox" checked={draft.cloudAllowed} onChange={(event) => updateDraft({ cloudAllowed: event.target.checked })} /><span>Allow cloud inference<small>Hard Project privacy boundary. Provider allowlist and credentials still apply.</small></span></label>
            <div className="provider-allowlist">
              <strong>Allowed providers</strong>
              {providers.map((provider) => <label className="check-row" key={provider.id}><input type="checkbox" checked={draft.allowedProviderIds.includes(provider.id)} onChange={(event) => toggleAllowedProvider(provider.id, event.target.checked)} /><span>{provider.id}<small>{provider.kind}{provider.settings.enabled ? '' : ' · globally disabled'}</small></span></label>)}
            </div>
            {draft.allowedProviderIds.filter((id) => providers.find((provider) => provider.id === id)?.kind === 'cloud').map((providerId) => {
              const matches = credentials.filter((credential) => credential.providerId === providerId && credential.organizationId === draft.organizationId);
              return <label className="credential-binding" key={providerId}><span>{providerId} credential</span><select value={draft.credentialProfileIds[providerId] ?? ''} onChange={(event) => updateDraft({ credentialProfileIds: { ...draft.credentialProfileIds, [providerId]: event.target.value } })}><option value="">Not bound</option>{matches.map((credential) => <option key={credential.id} value={credential.id}>{credential.label}{credential.available ? '' : ' (unavailable)'}</option>)}</select></label>;
            })}
          </section>

          <section className="panel admin-section">
            <div className="panel-heading"><div><span className="eyebrow">MODEL CATALOG</span><strong>Actual runtime availability</strong></div><span className="muted small">Cloud Auto uses only a provider default or explicitly configured model profile.</span></div>
            <div className="catalog-list">{(catalog?.providers ?? []).map((provider) => {
              const adminProvider = providers.find((item) => item.id === provider.id);
              const defaultModelId = adminProvider?.settings.defaultModelId ?? '';
              return <div className="catalog-provider" key={provider.id}>
                <div className="catalog-provider-head">
                  <div><i className={`dot ${provider.ready ? 'good' : 'bad'}`} /><strong>{provider.id}</strong><span>{provider.kind}</span></div>
                  <div><label className="switch-label"><input type="checkbox" checked={adminProvider?.settings.enabled ?? provider.enabled} onChange={(event) => adminProvider && void saveProvider(adminProvider, { enabled: event.target.checked })} />enabled</label><span className={`status-pill ${provider.ready ? 'good' : 'warn'}`}>{provider.ready ? 'ready' : provider.reason ?? 'unavailable'}</span></div>
                </div>
                {adminProvider ? <label className="provider-default">Auto default<select value={defaultModelId} onChange={(event) => void saveProvider(adminProvider, { defaultModelId: event.target.value || null })}><option value="">None</option>{provider.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label> : null}
                {provider.models.length === 0 ? <p className="muted small">No discovered/configured models.</p> : <div className="model-table">{provider.models.map((model) => {
                  const configuredProfile = adminProvider?.settings.models[model.id];
                  const autoRoutable = provider.kind === 'local'
                    ? model.routing.enabled !== false
                    : defaultModelId === model.id || Boolean(configuredProfile && configuredProfile.enabled !== false);
                  return <div className="model-row" key={model.id}>
                    <div className="model-name"><strong>{model.displayName}</strong><span>{model.id}</span></div>
                    <span className={`status-pill ${model.available ? 'good' : 'warn'}`}>{model.available ? 'available' : 'configured only'}</span>
                    <label className="switch-label"><input type="checkbox" checked={autoRoutable} onChange={(event) => adminProvider && void saveProvider(adminProvider, { models: { [model.id]: { ...(configuredProfile ?? model.routing), enabled: event.target.checked } } })} />route</label>
                    <label className="switch-label"><input type="checkbox" checked={configuredProfile?.frontier === true} onChange={(event) => adminProvider && void saveProvider(adminProvider, { models: { [model.id]: { ...(configuredProfile ?? model.routing), frontier: event.target.checked } } })} />frontier</label>
                    <span className="model-price">{model.pricing ? `${usd(model.pricing.inputPerMillionUsd)} in / ${usd(model.pricing.outputPerMillionUsd)} out` : 'pricing missing'}</span>
                    <button className="secondary small-button" onClick={() => editPricing(provider.id, model)}>Pricing</button>
                  </div>;
                })}</div>}
              </div>;
            })}</div>
          </section>

          <section className="panel admin-section">
            <div className="panel-heading"><div><span className="eyebrow">PRICING</span><strong>Cost sheet used by budget admission</strong></div></div>
            <form className="form-grid pricing-grid" onSubmit={(event) => void savePricing(event)}>
              <label>Provider<input value={pricingDraft.providerId} onChange={(event) => setPricingDraft((current) => ({ ...current, providerId: event.target.value }))} /></label>
              <label>Model<input value={pricingDraft.modelId} onChange={(event) => setPricingDraft((current) => ({ ...current, modelId: event.target.value }))} /></label>
              <label>Input / 1M<input type="number" min="0" step="0.0001" value={pricingDraft.inputPerMillionUsd} onChange={(event) => setPricingDraft((current) => ({ ...current, inputPerMillionUsd: event.target.value }))} /></label>
              <label>Output / 1M<input type="number" min="0" step="0.0001" value={pricingDraft.outputPerMillionUsd} onChange={(event) => setPricingDraft((current) => ({ ...current, outputPerMillionUsd: event.target.value }))} /></label>
              <label>Cache read / 1M<input type="number" min="0" step="0.0001" value={pricingDraft.cacheReadPerMillionUsd} onChange={(event) => setPricingDraft((current) => ({ ...current, cacheReadPerMillionUsd: event.target.value }))} /></label>
              <label>Cache write / 1M<input type="number" min="0" step="0.0001" value={pricingDraft.cacheWritePerMillionUsd} onChange={(event) => setPricingDraft((current) => ({ ...current, cacheWritePerMillionUsd: event.target.value }))} /></label>
              <label className="grow-two">Source<input value={pricingDraft.source} onChange={(event) => setPricingDraft((current) => ({ ...current, source: event.target.value }))} placeholder="Provider pricing page / manual" /></label>
              <div className="pricing-actions"><button className="primary" disabled={busy}>Save pricing</button><button type="button" className="danger" disabled={busy || !pricingDraft.modelId} onClick={() => void removePricing()}>Remove</button></div>
            </form>
          </section>
        </>}
      </div>
    </div>

    <section className="panel admin-section credentials-section">
      <div className="panel-heading"><div><span className="eyebrow">CREDENTIALS</span><strong>Keychain or environment references</strong></div><span className="muted small">Raw Keychain secrets are never returned by this API.</span></div>
      <div className="credential-list">{credentials.map((credential) => <div className="credential-row" key={credential.id}><i className={`dot ${credential.available ? 'good' : 'warn'}`} /><div><strong>{credential.label}</strong><span>{credential.id} · {credential.providerId} · {credential.organizationId ?? 'personal'} · {credential.backend}</span></div><span className={`status-pill ${credential.available ? 'good' : 'warn'}`}>{credential.available ? 'available' : 'missing'}</span><button className="danger ghost" onClick={() => void removeCredential(credential.id)}>Remove</button></div>)}</div>
      <form className="credential-form" onSubmit={(event) => void saveCredential(event)}>
        <label>ID<input required value={credentialDraft.id} onChange={(event) => setCredentialDraft((current) => ({ ...current, id: event.target.value }))} placeholder="acme-anthropic" /></label>
        <label>Provider<select value={credentialDraft.providerId} onChange={(event) => setCredentialDraft((current) => ({ ...current, providerId: event.target.value }))}>{cloudProviders.map((provider) => <option key={provider.id}>{provider.id}</option>)}</select></label>
        <label>Label<input required value={credentialDraft.label} onChange={(event) => setCredentialDraft((current) => ({ ...current, label: event.target.value }))} /></label>
        <label>Organization ID<input value={credentialDraft.organizationId} onChange={(event) => setCredentialDraft((current) => ({ ...current, organizationId: event.target.value }))} placeholder="must match Project" /></label>
        <label>Backend<select value={credentialDraft.backend} onChange={(event) => setCredentialDraft((current) => ({ ...current, backend: event.target.value as CredentialDraft['backend'] }))}><option value="macos-keychain">macOS Keychain</option><option value="environment">Environment</option></select></label>
        {credentialDraft.backend === 'macos-keychain' ? <label>Secret<input type="password" required value={credentialDraft.secret} onChange={(event) => setCredentialDraft((current) => ({ ...current, secret: event.target.value }))} autoComplete="new-password" /></label> : <label>Environment variable<input required value={credentialDraft.environmentVariable} onChange={(event) => setCredentialDraft((current) => ({ ...current, environmentVariable: event.target.value }))} placeholder="ANTHROPIC_API_KEY" /></label>}
        <button className="primary align-end" disabled={busy || cloudProviders.length === 0}>Save credential</button>
      </form>
    </section>
  </div>;
}
