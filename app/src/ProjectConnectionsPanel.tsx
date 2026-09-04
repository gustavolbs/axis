import { useEffect, useMemo, useState } from 'react';
import { Check, Database, RefreshCw, ShieldCheck } from 'lucide-react';

import type {
  AdminProject,
  ModelSelection,
  ProjectConnectionPolicy,
  ProviderConnectionView,
  WorkHubSourceSummary
} from './app-types.js';

interface CatalogModel {
  id: string;
  displayName: string;
  available: boolean;
}
interface CatalogProvider {
  id: string;
  label?: string;
  providerFamily?: string;
  organizationId?: string;
  ready: boolean;
  reason?: string;
  models: CatalogModel[];
}
interface ProjectCatalog {
  chatDefaultModel?: ModelSelection;
  coworkDefaultModel: ModelSelection;
  connectionPolicy: ProjectConnectionPolicy;
  providers: CatalogProvider[];
}

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function canonicalProject(project: AdminProject): AdminProject {
  const companyId = project.companyId || project.organizationId || 'personal';
  return {
    ...project,
    companyId,
    companyName: project.companyName ?? project.organizationName ?? (companyId === 'personal' ? 'Personal' : companyId)
  };
}

function canonicalConnection(connection: ProviderConnectionView): ProviderConnectionView {
  if (connection.auth === 'local') return { ...connection, companyId: undefined, companyName: undefined };
  const companyId = connection.companyId ?? connection.organizationId;
  return {
    ...connection,
    companyId,
    companyName: connection.companyName ?? connection.organizationLabel ?? companyId
  };
}

function legacyPolicy(project: AdminProject): ProjectConnectionPolicy {
  const allowed = project.privacy.allowedProviderIds.length ? project.privacy.allowedProviderIds : ['ollama'];
  const explicit = project.defaultModel.mode === 'explicit' ? project.defaultModel : undefined;
  const local = project.defaultModel.mode === 'local-first' ? project.defaultModel : undefined;
  const defaultConnectionId = explicit?.providerId ?? (local ? 'ollama' : allowed[0]);
  return {
    chat: {
      defaultConnectionId,
      defaultModelId: explicit?.modelId ?? local?.modelId,
      allowedConnectionIds: [...allowed]
    },
    inference: {
      allowedConnectionIds: [...allowed],
      preferredConnectionId: defaultConnectionId
    },
    workSourceIds: []
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function connectionAuthLabel(auth: ProviderConnectionView['auth']): string {
  if (auth === 'api-key') return 'API key';
  if (auth === 'claude-account') return 'Claude account';
  if (auth === 'chatgpt-account') return 'ChatGPT account';
  return 'Local';
}

export function ProjectConnectionsPanel({
  project,
  onProjectChanged
}: {
  project: AdminProject;
  onProjectChanged: (project: AdminProject) => void;
}) {
  const scopedProject = canonicalProject(project);
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [sources, setSources] = useState<WorkHubSourceSummary[]>([]);
  const [catalog, setCatalog] = useState<ProjectCatalog>();
  const [policy, setPolicy] = useState<ProjectConnectionPolicy>(() => structuredClone(scopedProject.connectionPolicy ?? legacyPolicy(scopedProject)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    setPolicy(structuredClone(scopedProject.connectionPolicy ?? legacyPolicy(scopedProject)));
  }, [scopedProject.id, scopedProject.updatedAt]);

  async function refresh() {
    setBusy(true);
    setMessage(undefined);
    try {
      const bridge = window.lc;
      const [connectionItems, sourceSnapshot, catalogResult] = await Promise.all([
        bridge?.providerConnections() ?? Promise.resolve([]),
        bridge?.workHubSnapshot() ?? Promise.resolve(undefined),
        api<{ catalog: ProjectCatalog }>(`/api/projects/${encodeURIComponent(scopedProject.id)}/catalog`)
      ]);
      setConnections((connectionItems as ProviderConnectionView[]).map(canonicalConnection));
      setSources((sourceSnapshot?.sources ?? []) as WorkHubSourceSummary[]);
      setCatalog(catalogResult.catalog);
      setPolicy(structuredClone(catalogResult.catalog.connectionPolicy));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, [scopedProject.id]);

  const connectionById = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections]
  );
  const catalogById = useMemo(
    () => new Map((catalog?.providers ?? []).map((provider) => [provider.id, provider])),
    [catalog]
  );

  function belongs(connection: ProviderConnectionView): boolean {
    if (connection.auth === 'local') return true;
    if (connection.companyId === scopedProject.companyId) return true;
    return policy.chat.allowedConnectionIds.includes(connection.id) || policy.inference.allowedConnectionIds.includes(connection.id);
  }

  function toggle(scope: 'chat' | 'inference', connectionId: string) {
    setPolicy((current) => {
      const next = structuredClone(current);
      const target = scope === 'chat' ? next.chat.allowedConnectionIds : next.inference.allowedConnectionIds;
      const exists = target.includes(connectionId);
      const values = exists ? target.filter((id) => id !== connectionId) : [...target, connectionId];
      if (scope === 'chat') {
        next.chat.allowedConnectionIds = values;
        if (next.chat.defaultConnectionId && !values.includes(next.chat.defaultConnectionId)) {
          next.chat.defaultConnectionId = values[0];
          next.chat.defaultModelId = undefined;
        }
      } else {
        if (values.length === 0) return current;
        next.inference.allowedConnectionIds = values;
        if (next.inference.preferredConnectionId && !values.includes(next.inference.preferredConnectionId)) {
          next.inference.preferredConnectionId = values[0];
        }
      }
      return next;
    });
  }

  function toggleSource(sourceId: string) {
    setPolicy((current) => ({
      ...current,
      workSourceIds: current.workSourceIds.includes(sourceId)
        ? current.workSourceIds.filter((id) => id !== sourceId)
        : [...current.workSourceIds, sourceId]
    }));
  }

  async function save() {
    if (policy.inference.allowedConnectionIds.length === 0) {
      setMessage('Cowork requires at least one allowed inference connection.');
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const selectedConnections = unique([
        ...policy.chat.allowedConnectionIds,
        ...policy.inference.allowedConnectionIds
      ]);
      const known = selectedConnections.map((id) => connectionById.get(id)).filter(Boolean) as ProviderConnectionView[];
      const customProviderIds = selectedConnections.filter((id) => !connectionById.has(id) && id !== 'ollama');
      const allowedProviderIds = unique([
        ...known.map((connection) => connection.providerFamily),
        ...(selectedConnections.includes('ollama') ? ['ollama'] : []),
        ...customProviderIds
      ]);
      const cloudAllowed = known.some((connection) => connection.providerFamily !== 'ollama') || customProviderIds.length > 0;
      const { project: updated } = await api<{ project: AdminProject }>(`/api/projects/${encodeURIComponent(scopedProject.id)}`, {
        method: 'PATCH',
        body: {
          connectionPolicy: policy,
          privacy: { cloudAllowed, allowedProviderIds: allowedProviderIds.length ? allowedProviderIds : ['ollama'] }
        }
      });
      onProjectChanged(canonicalProject(updated));
      window.dispatchEvent(new CustomEvent('local-coder:projects-changed'));
      setMessage('Project connection policy saved. Existing conversations keep their selected identity.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const chatModels = policy.chat.defaultConnectionId
    ? catalogById.get(policy.chat.defaultConnectionId)?.models.filter((model) => model.available) ?? []
    : [];

  return <section className="project-connection-policy">
    <style>{`
      .project-connection-policy{border-top:1px solid var(--lc-border);padding-top:14px;display:grid;gap:12px}
      .project-connection-policy>header{display:flex;justify-content:space-between;align-items:center;gap:8px}.project-connection-policy h2{margin:0;font-size:13px}
      .project-connection-policy button.icon{border:0;background:transparent;color:var(--lc-muted);padding:4px}
      .pcp-note{font-size:9.5px;line-height:1.45;color:var(--lc-muted);margin:0}.pcp-group{display:grid;gap:6px}.pcp-group>strong{font-size:10px;color:var(--lc-text-soft)}
      .pcp-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px 8px;border:1px solid var(--lc-border);border-radius:8px;background:var(--lc-surface)}
      .pcp-row.disabled{opacity:.5}.pcp-check{width:17px;height:17px;border:1px solid var(--lc-border);border-radius:4px;display:grid;place-items:center;background:transparent;color:var(--lc-positive)}
      .pcp-copy strong,.pcp-copy small{display:block}.pcp-copy strong{font-size:10px}.pcp-copy small{font-size:9px;color:var(--lc-muted);margin-top:1px}.pcp-kind{font-size:8px;color:var(--lc-muted)}
      .pcp-select{width:100%;font-size:10px;min-height:32px}.pcp-actions{display:flex;justify-content:flex-end;gap:7px}.pcp-message{font-size:9px;color:var(--lc-muted)}
    `}</style>
    <header><h2>Connections</h2><button className="icon" aria-label="Refresh connections" onClick={() => void refresh()} disabled={busy}><RefreshCw size={14}/></button></header>
    <p className="pcp-note">This Project belongs to <strong>{scopedProject.companyName ?? scopedProject.companyId}</strong>. Connections owned by another Company are visible but cannot be newly enabled. Shared local execution remains company-neutral.</p>

    <div className="pcp-group"><strong>Allowed Chat identities</strong>
      {connections.map((connection) => {
        const compatible = belongs(connection);
        const checked = policy.chat.allowedConnectionIds.includes(connection.id);
        const owner = connection.auth === 'local' ? 'Shared local' : connection.companyName ?? connection.companyId ?? 'Unassigned';
        return <button type="button" key={`chat:${connection.id}`} className={`pcp-row ${compatible ? '' : 'disabled'}`} disabled={!compatible || busy} onClick={() => toggle('chat', connection.id)}>
          <span className="pcp-check">{checked ? <Check size={11}/> : null}</span><span className="pcp-copy"><strong>{connection.label}</strong><small>{connectionAuthLabel(connection.auth)} · {owner}</small></span><span className="pcp-kind">{connection.providerFamily}</span>
        </button>;
      })}
    </div>

    <div className="pcp-group"><strong>Default Chat identity</strong>
      <select className="pcp-select" value={policy.chat.defaultConnectionId ?? ''} onChange={(event) => setPolicy((current) => ({ ...current, chat: { ...current.chat, defaultConnectionId: event.target.value || undefined, defaultModelId: undefined } }))}>
        <option value="">Choose connection</option>{policy.chat.allowedConnectionIds.map((id) => <option key={id} value={id}>{connectionById.get(id)?.label ?? id}</option>)}
      </select>
      {policy.chat.defaultConnectionId ? <select className="pcp-select" value={policy.chat.defaultModelId ?? ''} onChange={(event) => setPolicy((current) => ({ ...current, chat: { ...current.chat, defaultModelId: event.target.value || undefined } }))}>
        <option value="">Choose model</option>{chatModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
      </select> : null}
    </div>

    <div className="pcp-group"><strong>Allowed Cowork identities</strong>
      {connections.map((connection) => {
        const compatible = belongs(connection);
        const checked = policy.inference.allowedConnectionIds.includes(connection.id);
        const owner = connection.auth === 'local' ? 'Shared local' : connection.companyName ?? connection.companyId ?? 'Unassigned';
        return <button type="button" key={`cowork:${connection.id}`} className={`pcp-row ${compatible ? '' : 'disabled'}`} disabled={!compatible || busy} onClick={() => toggle('inference', connection.id)}>
          <span className="pcp-check">{checked ? <Check size={11}/> : null}</span><span className="pcp-copy"><strong>{connection.label}</strong><small>{connectionAuthLabel(connection.auth)} · {owner}</small></span><span className="pcp-kind">{connection.providerFamily}</span>
        </button>;
      })}
      <select className="pcp-select" value={policy.inference.preferredConnectionId ?? ''} onChange={(event) => setPolicy((current) => ({ ...current, inference: { ...current.inference, preferredConnectionId: event.target.value || undefined } }))}>
        <option value="">No preferred connection</option>{policy.inference.allowedConnectionIds.map((id) => <option key={id} value={id}>{connectionById.get(id)?.label ?? id}</option>)}
      </select>
    </div>

    <div className="pcp-group"><strong>Work Hub sources</strong>
      {sources.filter((source) => {
        const connection = connectionById.get(source.connectionId);
        return connection?.companyId === scopedProject.companyId;
      }).map((source) => <button type="button" key={source.id} className="pcp-row" disabled={busy} onClick={() => toggleSource(source.id)}>
        <span className="pcp-check">{policy.workSourceIds.includes(source.id) ? <Check size={11}/> : null}</span><span className="pcp-copy"><strong>{source.label}</strong><small>{source.system} · {source.kind}</small></span><span className="pcp-kind"><Database size={11}/></span>
      </button>)}
      {sources.length === 0 ? <p className="pcp-note">Create Calendar/Jira/Teams/etc. sources in Work Hub first. Source binding remains independent from model routing.</p> : null}
    </div>

    <p className="pcp-note"><ShieldCheck size={11}/> Identity fallback is fail-closed: if the selected company-owned connection is unavailable, Axis reports it instead of switching to another account.</p>
    {message ? <div className="pcp-message" role="status">{message}</div> : null}
    <div className="pcp-actions"><button className="btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save connections'}</button></div>
  </section>;
}
