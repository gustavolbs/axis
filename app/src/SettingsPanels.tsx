import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, Plus, Trash2 } from 'lucide-react';

import type { AdminProject, ModelSelection, RoutingPolicy } from './app-types.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

interface Credential {
  id: string;
  providerId: string;
  label: string;
  organizationId?: string;
  backend: 'macos-keychain' | 'environment';
  environmentVariable?: string;
  available: boolean;
}

interface ProviderAdmin {
  id: string;
  kind: 'local' | 'cloud';
  settings: { enabled: boolean; defaultModelId?: string };
}

interface CatalogModel {
  id: string;
  displayName: string;
  available: boolean;
}

interface CatalogProvider {
  id: string;
  kind: 'local' | 'cloud';
  enabled: boolean;
  ready: boolean;
  reason?: string;
  models: CatalogModel[];
}

interface ProjectCatalog {
  projectId: string;
  providers: CatalogProvider[];
}

const policyOptions: UiSelectOption[] = [
  { value: 'auto', label: 'Auto', description: 'Choose policy from task signals' },
  { value: 'local-first', label: 'Local first', description: 'Prefer local inference when it is suitable' },
  { value: 'balanced', label: 'Balanced', description: 'Balance quality, speed and cost' },
  { value: 'speed-first', label: 'Speed first', description: 'Prefer the fastest allowed route' },
  { value: 'deep', label: 'Deep', description: 'Prefer stronger reasoning for complex work' },
  { value: 'frontier-only', label: 'Frontier only', description: 'Use only explicitly frontier-capable models' }
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function modelValue(selection: ModelSelection): string {
  return selection.mode === 'auto' ? 'auto' : `${selection.providerId}\0${selection.modelId}`;
}

function parseModel(value: string): ModelSelection {
  if (value === 'auto') return { mode: 'auto' };
  const index = value.indexOf('\0');
  if (index <= 0) return { mode: 'auto' };
  return { mode: 'explicit', providerId: value.slice(0, index), modelId: value.slice(index + 1) };
}

function optionalBudget(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Where the local runtime looks for Ollama. Until this was editable, a wrong or
 * moved endpoint could only be fixed with an environment variable, and the only
 * symptom was a toast saying the address could not be reached.
 */
type ExecutionMode = 'local' | 'remote' | 'auto';

interface RuntimeSettingsResponse {
  ollamaBaseUrl: string;
  executionMode: ExecutionMode;
  requiresWorkerToken: boolean;
  restartRequired?: boolean;
}

export function OllamaEndpointSetting() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [mode, setMode] = useState<ExecutionMode>('local');
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [busy, setBusy] = useState<'saving' | 'probing' | 'mode'>();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    void api<{ settings: RuntimeSettingsResponse }>('/api/settings')
      .then(({ settings }) => {
        setValue(settings.ollamaBaseUrl);
        setSaved(settings.ollamaBaseUrl);
        setMode(settings.executionMode);
      })
      .catch(() => undefined);
  }, []);

  async function chooseMode(next: ExecutionMode) {
    if (next === mode) return;
    setBusy('mode');
    setResult(undefined);
    try {
      const { settings } = await api<{ settings: RuntimeSettingsResponse }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ executionMode: next })
      });
      setMode(settings.executionMode);
      setRestartNeeded(Boolean(settings.restartRequired));
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  const dirty = value.trim().replace(/\/+$/, '') !== saved;

  async function save() {
    setBusy('saving');
    setResult(undefined);
    try {
      const { settings } = await api<{ settings: RuntimeSettingsResponse }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ ollamaBaseUrl: value })
      });
      setValue(settings.ollamaBaseUrl);
      setSaved(settings.ollamaBaseUrl);
      setResult({ ok: true, message: 'Saved. New requests use this address.' });
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function test() {
    setBusy('probing');
    setResult(undefined);
    try {
      const probe = await api<{ reachable: boolean; models?: number; error?: string }>('/api/settings/probe-ollama', {
        method: 'POST',
        body: JSON.stringify({ ollamaBaseUrl: value })
      });
      setResult(probe.reachable
        ? { ok: true, message: `Reachable — ${probe.models ?? 0} model${probe.models === 1 ? '' : 's'} installed.` }
        : { ok: false, message: probe.error ?? 'Not reachable.' });
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  return <>
    <div className="settings-card settings-card-column">
      <div>
        <strong>Where work runs</strong>
        <p>Direct talks straight to Ollama over the network — no worker and no bearer token. Windows worker runs the whole agent on the other machine and needs one.</p>
      </div>
      <div className="settings-mode-choice" role="radiogroup" aria-label="Execution mode">
        {([
          ['local', 'Direct to Ollama', 'No token'],
          ['auto', 'Worker, fall back to direct', 'Needs a token'],
          ['remote', 'Windows worker only', 'Needs a token']
        ] as const).map(([id, label, note]) => <button
          key={id}
          role="radio"
          aria-checked={mode === id}
          className={mode === id ? 'selected' : ''}
          disabled={busy !== undefined}
          onClick={() => void chooseMode(id)}
        ><strong>{label}</strong><small>{note}</small></button>)}
      </div>
      {restartNeeded ? <p className="settings-endpoint-result" role="status">Restart Local Coder to apply.</p> : null}
    </div>

    <div className="settings-card settings-card-column">
      <div>
        <strong>Ollama endpoint</strong>
        <p>Default is http://127.0.0.1:11434. For an Ollama on another machine, use its address — that host needs OLLAMA_HOST=0.0.0.0 to accept connections.</p>
      </div>
      <div className="settings-endpoint-row">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && dirty) void save(); }}
        placeholder="http://127.0.0.1:11434"
        spellCheck={false}
        autoCapitalize="off"
        aria-label="Ollama base URL"
      />
      <button className="btn-secondary" onClick={() => void test()} disabled={!value.trim() || busy !== undefined}>
        {busy === 'probing' ? 'Testing…' : 'Test'}
      </button>
      <button className="btn-primary" onClick={() => void save()} disabled={!dirty || busy !== undefined}>
        {busy === 'saving' ? 'Saving…' : 'Save'}
      </button>
    </div>
      {result ? <p className={`settings-endpoint-result ${result.ok ? 'ok' : 'error'}`} role="status">
        {result.ok ? <CheckCircle2 size={13} /> : null}{result.message}
      </p> : null}
    </div>
  </>;
}

export function ModelRoutingSettings() {
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [providers, setProviders] = useState<ProviderAdmin[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [activeId, setActiveId] = useState('');
  const [catalog, setCatalog] = useState<ProjectCatalog>();
  const [draft, setDraft] = useState<AdminProject>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [dailyUsd, setDailyUsd] = useState('');
  const [monthlyUsd, setMonthlyUsd] = useState('');
  const [perJobUsd, setPerJobUsd] = useState('');

  async function load() {
    const [{ projects: nextProjects }, { providers: nextProviders }, { credentials: nextCredentials }] = await Promise.all([
      api<{ projects: AdminProject[] }>('/api/projects'),
      api<{ providers: ProviderAdmin[] }>('/api/providers'),
      api<{ credentials: Credential[] }>('/api/credentials')
    ]);
    setProjects(nextProjects);
    setProviders(nextProviders);
    setCredentials(nextCredentials);
    setActiveId((current) => current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id ?? '');
  }

  useEffect(() => {
    void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    const project = projects.find((item) => item.id === activeId);
    if (!project) {
      setDraft(undefined);
      setCatalog(undefined);
      return;
    }
    setDraft(structuredClone(project));
    setDailyUsd(project.budgets.dailyUsd?.toString() ?? '');
    setMonthlyUsd(project.budgets.monthlyUsd?.toString() ?? '');
    setPerJobUsd(project.budgets.perJobUsd?.toString() ?? '');
    void api<{ catalog: ProjectCatalog }>(`/api/projects/${encodeURIComponent(project.id)}/catalog`)
      .then(({ catalog: next }) => setCatalog(next))
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [activeId, projects]);

  const projectOptions = useMemo<UiSelectOption[]>(() => projects.map((project) => ({
    value: project.id,
    label: project.name,
    description: project.workspace
  })), [projects]);

  const modelOptions = useMemo<UiSelectOption[]>(() => {
    const result: UiSelectOption[] = [{ value: 'auto', label: 'Auto', description: 'Use this project’s routing policy' }];
    for (const provider of catalog?.providers ?? []) {
      for (const model of provider.models) {
        result.push({
          value: `${provider.id}\0${model.id}`,
          label: model.displayName,
          description: `${provider.id} · ${provider.kind}`,
          disabled: !provider.ready || !model.available
        });
      }
    }
    return result;
  }, [catalog]);

  function toggleProvider(providerId: string) {
    if (!draft) return;
    const exists = draft.privacy.allowedProviderIds.includes(providerId);
    setDraft({
      ...draft,
      privacy: {
        ...draft.privacy,
        allowedProviderIds: exists
          ? draft.privacy.allowedProviderIds.filter((id) => id !== providerId)
          : [...draft.privacy.allowedProviderIds, providerId]
      }
    });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const credentialProfileIds = Object.fromEntries(Object.entries(draft.credentialProfileIds).filter(([, value]) => value));
      await api(`/api/projects/${encodeURIComponent(draft.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          defaultRoutingPolicy: draft.defaultRoutingPolicy,
          defaultModel: draft.defaultModel,
          privacy: draft.privacy,
          credentialProfileIds,
          budgets: {
            dailyUsd: optionalBudget(dailyUsd),
            monthlyUsd: optionalBudget(monthlyUsd),
            perJobUsd: optionalBudget(perJobUsd)
          },
          concurrency: draft.concurrency
        })
      });
      await load();
      setMessage('Routing settings saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return <div className="focused-settings-page routing-settings-page">
    <header><div><h1>Model routing</h1><p>Choose how this project routes work across local and cloud models.</p></div>{draft ? <button className="settings-save-button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button> : null}</header>

    {message ? <div className="settings-inline-message">{message}</div> : null}

    {projects.length === 0 ? <div className="settings-empty-state">Create a project first to configure model routing.</div> : <>
      <section className="settings-form-section">
        <div className="settings-section-copy"><strong>Project</strong><p>Routing, credentials and budgets are isolated per project.</p></div>
        <UiSelect ariaLabel="Project" value={activeId} options={projectOptions} onChange={setActiveId} />
      </section>

      {draft ? <>
        <section className="settings-form-section">
          <div className="settings-section-copy"><strong>Routing policy</strong><p>Auto can adapt by task stage; explicit policies keep routing predictable.</p></div>
          <UiSelect ariaLabel="Routing policy" value={draft.defaultRoutingPolicy} options={policyOptions} onChange={(value) => setDraft({ ...draft, defaultRoutingPolicy: value as RoutingPolicy })} />
        </section>

        <section className="settings-form-section">
          <div className="settings-section-copy"><strong>Default model</strong><p>Auto keeps stage-level routing. An explicit model is an exact selection.</p></div>
          <UiSelect ariaLabel="Default model" value={modelValue(draft.defaultModel)} options={modelOptions} onChange={(value) => setDraft({ ...draft, defaultModel: parseModel(value) })} />
        </section>

        <section className="settings-form-section settings-toggle-section">
          <div className="settings-section-copy"><strong>Allow cloud inference</strong><p>Hard privacy boundary for this project.</p></div>
          <button className={`settings-toggle ${draft.privacy.cloudAllowed ? 'on' : ''}`} aria-pressed={draft.privacy.cloudAllowed} onClick={() => setDraft({ ...draft, privacy: { ...draft.privacy, cloudAllowed: !draft.privacy.cloudAllowed } })}><i /></button>
        </section>

        <section className="settings-stacked-section">
          <div className="settings-section-copy"><strong>Allowed providers</strong><p>Only checked providers are eligible for this project.</p></div>
          <div className="provider-choice-grid">{providers.map((provider) => {
            const checked = draft.privacy.allowedProviderIds.includes(provider.id);
            const runtime = catalog?.providers.find((item) => item.id === provider.id);
            return <button key={provider.id} className={checked ? 'selected' : ''} onClick={() => toggleProvider(provider.id)}>
              <span className="provider-choice-check">{checked ? <CheckCircle2 size={15} /> : null}</span>
              <span><strong>{provider.id}</strong><small>{provider.kind} · {runtime?.ready ? 'ready' : runtime?.reason ?? (provider.settings.enabled ? 'configured' : 'disabled')}</small></span>
            </button>;
          })}</div>
        </section>

        {draft.privacy.allowedProviderIds.filter((id) => providers.find((provider) => provider.id === id)?.kind === 'cloud').map((providerId) => {
          const matching = credentials.filter((credential) => credential.providerId === providerId && credential.organizationId === draft.organizationId);
          const options: UiSelectOption[] = [{ value: '', label: 'Not bound', description: 'Cloud calls will remain unavailable for this provider' }, ...matching.map((credential) => ({ value: credential.id, label: credential.label, description: credential.available ? 'Available' : 'Unavailable', disabled: !credential.available }))];
          return <section className="settings-form-section" key={providerId}>
            <div className="settings-section-copy"><strong>{providerId} credential</strong><p>Credential binding stays inside this project’s organization boundary.</p></div>
            <UiSelect ariaLabel={`${providerId} credential`} value={draft.credentialProfileIds[providerId] ?? ''} options={options} onChange={(value) => setDraft({ ...draft, credentialProfileIds: { ...draft.credentialProfileIds, [providerId]: value } })} />
          </section>;
        })}

        <section className="settings-stacked-section">
          <div className="settings-section-copy"><strong>Spend limits</strong><p>Leave blank for unlimited. Budget admission remains fail-closed when configured pricing is missing.</p></div>
          <div className="budget-input-grid">
            <label><span>Per job</span><div><em>$</em><input inputMode="decimal" value={perJobUsd} onChange={(event) => setPerJobUsd(event.target.value)} placeholder="Unlimited" /></div></label>
            <label><span>Daily</span><div><em>$</em><input inputMode="decimal" value={dailyUsd} onChange={(event) => setDailyUsd(event.target.value)} placeholder="Unlimited" /></div></label>
            <label><span>Monthly</span><div><em>$</em><input inputMode="decimal" value={monthlyUsd} onChange={(event) => setMonthlyUsd(event.target.value)} placeholder="Unlimited" /></div></label>
          </div>
        </section>
      </> : null}
    </>}
  </div>;
}

export function ApiKeySettings() {
  const [providers, setProviders] = useState<ProviderAdmin[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [providerId, setProviderId] = useState('anthropic');
  const [backend, setBackend] = useState<'macos-keychain' | 'environment'>('macos-keychain');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [secret, setSecret] = useState('');
  const [environmentVariable, setEnvironmentVariable] = useState('');

  async function load() {
    const [{ providers: nextProviders }, { credentials: nextCredentials }] = await Promise.all([
      api<{ providers: ProviderAdmin[] }>('/api/providers'),
      api<{ credentials: Credential[] }>('/api/credentials')
    ]);
    const clouds = nextProviders.filter((provider) => provider.kind === 'cloud');
    setProviders(clouds);
    setCredentials(nextCredentials);
    setProviderId((current) => clouds.some((provider) => provider.id === current) ? current : clouds[0]?.id ?? '');
  }

  useEffect(() => {
    void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const providerOptions = providers.map((provider) => ({ value: provider.id, label: provider.id, description: provider.settings.enabled ? 'Cloud provider enabled' : 'Provider currently disabled' }));
  const backendOptions: UiSelectOption[] = [
    { value: 'macos-keychain', label: 'macOS Keychain', description: 'Recommended · secret stays in Keychain' },
    { value: 'environment', label: 'Environment variable', description: 'Store only a reference to an environment variable' }
  ];

  function resetForm() {
    setId('');
    setLabel('');
    setOrganizationId('');
    setSecret('');
    setEnvironmentVariable('');
    setBackend('macos-keychain');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!id.trim() || !label.trim() || !providerId) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await api('/api/credentials', {
        method: 'POST',
        body: JSON.stringify(backend === 'macos-keychain'
          ? { id: id.trim(), providerId, label: label.trim(), organizationId: organizationId.trim() || undefined, backend, secret }
          : { id: id.trim(), providerId, label: label.trim(), organizationId: organizationId.trim() || undefined, backend, environmentVariable: environmentVariable.trim() })
      });
      await load();
      resetForm();
      setAdding(false);
      setMessage('API key saved. Secret values are never returned by the control plane.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(credentialId: string) {
    if (!window.confirm(`Remove “${credentialId}”?`)) return;
    try {
      await api(`/api/credentials/${encodeURIComponent(credentialId)}`, { method: 'DELETE' });
      await load();
      setMessage('API key removed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return <div className="focused-settings-page api-key-settings-page">
    <header><div><h1>API keys</h1><p>Credentials stay in macOS Keychain or as environment references. Raw secrets never enter project metadata.</p></div><button className="settings-save-button" onClick={() => setAdding(true)}><Plus size={14} />Add key</button></header>
    {message ? <div className="settings-inline-message">{message}</div> : null}

    <div className="credential-card-list">{credentials.map((credential) => <article className="credential-card" key={credential.id}>
      <span className="credential-provider-icon"><KeyRound size={15} /></span>
      <div><strong>{credential.label}</strong><p>{credential.providerId} · {credential.organizationId ?? 'Personal'} · {credential.backend === 'macos-keychain' ? 'Keychain' : credential.environmentVariable ?? 'Environment'}</p></div>
      <span className={`credential-availability ${credential.available ? 'ready' : ''}`}>{credential.available ? 'Available' : 'Missing'}</span>
      <button className="credential-remove" aria-label={`Remove ${credential.label}`} onClick={() => void remove(credential.id)}><Trash2 size={15} /></button>
    </article>)}</div>
    {credentials.length === 0 ? <div className="settings-empty-state">No API keys configured.</div> : null}

    {adding ? <div className="nested-settings-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setAdding(false); }}>
      <form className="nested-settings-dialog" onSubmit={(event) => void save(event)}>
        <header><div><h2>Add API key</h2><p>Choose a provider and a secure secret backend.</p></div></header>
        <label><span>Provider</span><UiSelect ariaLabel="Provider" value={providerId} options={providerOptions} onChange={setProviderId} /></label>
        <label><span>Backend</span><UiSelect ariaLabel="Backend" value={backend} options={backendOptions} onChange={(value) => setBackend(value as 'macos-keychain' | 'environment')} /></label>
        <label><span>ID</span><input autoFocus required value={id} onChange={(event) => setId(event.target.value)} placeholder="acme-anthropic" /></label>
        <label><span>Label</span><input required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Acme Anthropic" /></label>
        <label><span>Organization ID <small>optional</small></span><input value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="Must match the project organization" /></label>
        {backend === 'macos-keychain' ? <label><span>Secret</span><input type="password" required value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" /></label> : <label><span>Environment variable</span><input required value={environmentVariable} onChange={(event) => setEnvironmentVariable(event.target.value)} placeholder="ANTHROPIC_API_KEY" /></label>}
        <div className="nested-settings-dialog-actions"><button type="button" onClick={() => setAdding(false)}>Cancel</button><button className="settings-save-button" disabled={busy}>{busy ? 'Saving…' : 'Save key'}</button></div>
      </form>
    </div> : null}
  </div>;
}
