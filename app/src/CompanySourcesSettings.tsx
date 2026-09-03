import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Inbox, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react';

import type {
  ProviderConnectionView,
  WorkHubSnapshotView,
  WorkHubSourceKind,
  WorkHubSourceView
} from './native.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

const SOURCE_KINDS: Array<{ kind: WorkHubSourceKind; label: string; description: string }> = [
  { kind: 'calendar', label: 'Calendar', description: 'Meetings and events from the account’s connected calendars.' },
  { kind: 'tickets', label: 'My Work', description: 'Assigned work from Jira, Linear and other supported trackers.' },
  { kind: 'messages', label: 'Inbox', description: 'Attention-worthy Jira comments and Slack messages.' }
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'source';
}

function kindLabel(kind: WorkHubSourceKind): string {
  return SOURCE_KINDS.find((entry) => entry.kind === kind)?.label ?? kind;
}

function SourceIcon({ kind }: { kind: WorkHubSourceKind }) {
  if (kind === 'calendar') return <CalendarDays size={15} />;
  if (kind === 'messages') return <Inbox size={15} />;
  return <Wrench size={15} />;
}

export function CompanySourcesSettings({ companyId, companyName }: { companyId: string; companyName: string }) {
  const bridge = window.lc;
  const [snapshot, setSnapshot] = useState<WorkHubSnapshotView>();
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [adding, setAdding] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [selectedKinds, setSelectedKinds] = useState<WorkHubSourceKind[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function load() {
    if (!bridge) return;
    const [nextSnapshot, nextConnections] = await Promise.all([
      bridge.workHubSnapshot(),
      bridge.providerConnections()
    ]);
    const scopedConnections = nextConnections.filter((connection) =>
      connection.companyId === companyId && connection.supportsMcpSources
    );
    setSnapshot(nextSnapshot);
    setConnections(scopedConnections);
    setConnectionId((current) => current && scopedConnections.some((connection) => connection.id === current)
      ? current
      : scopedConnections[0]?.id ?? '');
  }

  useEffect(() => {
    void load().catch((next) => setError(errorMessage(next)));
  }, [companyId]);

  const scopedSources = useMemo(() => (snapshot?.sources ?? []).filter((source) => source.companyId === companyId), [companyId, snapshot]);
  const stateBySource = useMemo(() => new Map((snapshot?.sourceStates ?? []).map((state) => [state.sourceId, state])), [snapshot]);
  const connectionById = useMemo(() => new Map(connections.map((connection) => [connection.id, connection])), [connections]);
  const connectionOptions = useMemo<UiSelectOption[]>(() => connections.map((connection) => ({
    value: connection.id,
    label: connection.label,
    description: `${connection.providerFamily} · ${connection.auth === 'claude-account' ? 'Claude Account' : 'ChatGPT / Codex Account'}`
  })), [connections]);

  function openAdd() {
    const selectedConnectionId = connectionId || connections[0]?.id || '';
    setConnectionId(selectedConnectionId);
    const existing = new Set(scopedSources.filter((source) => source.connectionId === selectedConnectionId).map((source) => source.kind));
    const firstAvailable = SOURCE_KINDS.find((entry) => !existing.has(entry.kind))?.kind;
    setSelectedKinds(firstAvailable ? [firstAvailable] : []);
    setAdding(true);
    setError(undefined);
  }

  function changeConnection(nextConnectionId: string) {
    setConnectionId(nextConnectionId);
    const existing = new Set(scopedSources.filter((source) => source.connectionId === nextConnectionId).map((source) => source.kind));
    const firstAvailable = SOURCE_KINDS.find((entry) => !existing.has(entry.kind))?.kind;
    setSelectedKinds(firstAvailable ? [firstAvailable] : []);
  }

  function toggleKind(kind: WorkHubSourceKind) {
    const alreadyExists = scopedSources.some((source) => source.connectionId === connectionId && source.kind === kind);
    if (alreadyExists) return;
    setSelectedKinds((current) => current.includes(kind)
      ? current.filter((candidate) => candidate !== kind)
      : [...current, kind]);
  }

  async function saveSources() {
    if (!bridge || !connectionId || selectedKinds.length === 0) return;
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (!connection || connection.companyId !== companyId) {
      setError('The selected connection does not belong to this Company.');
      return;
    }
    setBusy('add');
    setError(undefined);
    try {
      for (const kind of selectedKinds) {
        const existing = scopedSources.some((source) => source.connectionId === connection.id && source.kind === kind);
        if (existing) continue;
        await bridge.upsertWorkHubSource({
          id: `${slug(connection.id)}-${kind}`,
          label: `${connection.label} · ${kindLabel(kind)}`,
          connectionId: connection.id,
          kind,
          system: 'Connected services',
          toolAllowlist: [],
          retention: 'local'
        });
      }
      setAdding(false);
      await load();
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(undefined);
    }
  }

  async function refreshSource(source: WorkHubSourceView) {
    if (!bridge || source.companyId !== companyId) return;
    setBusy(`refresh:${source.id}`);
    setError(undefined);
    try {
      setSnapshot(await bridge.refreshWorkHub(source.id));
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(undefined);
    }
  }

  async function removeSource(source: WorkHubSourceView) {
    if (!bridge || source.companyId !== companyId) return;
    setBusy(`remove:${source.id}`);
    setError(undefined);
    try {
      await bridge.removeWorkHubSource(source.id);
      await load();
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(undefined);
    }
  }

  return <section className="connection-section company-source-settings" aria-label={`${companyName} Work Hub sources`}>
    <div className="connection-section-heading">
      <div>
        <h2>Work Hub sources</h2>
        <p>Choose which read-only account data this Company contributes to the single global Work Hub. Source ownership stays here.</p>
      </div>
      <button type="button" className="settings-save-button" disabled={!connections.length || busy !== undefined} onClick={openAdd}><Plus size={13} />Add source</button>
    </div>

    {error ? <div className="settings-inline-message" role="status">{error}</div> : null}

    <div className="connection-list">
      {scopedSources.map((source) => {
        const state = stateBySource.get(source.id);
        const connection = connectionById.get(source.connectionId);
        const refreshing = busy === `refresh:${source.id}` || state?.status === 'syncing';
        return <article className="connection-card" key={source.id} data-source-id={source.id} data-company-id={source.companyId}>
          <div className="connection-card-main">
            <span className="connection-icon"><SourceIcon kind={source.kind} /></span>
            <div className="connection-copy">
              <div className="connection-title-row"><strong>{kindLabel(source.kind)}</strong><span>{source.companyName}</span></div>
              <small>{connection?.label ?? source.connectionId} · {source.system}</small>
              <span className={`connection-state ${state?.status === 'ready' ? 'ready' : ''}`}>{state?.status ?? 'idle'}{state?.itemCount !== undefined ? ` · ${state.itemCount} items` : ''}</span>
            </div>
            <div className="connection-actions">
              <button type="button" className="btn-secondary" disabled={busy !== undefined} onClick={() => void refreshSource(source)}><RefreshCw size={12} className={refreshing ? 'spin' : ''} />{refreshing ? 'Syncing…' : 'Sync'}</button>
              <button type="button" className="btn-secondary danger" disabled={busy !== undefined} onClick={() => void removeSource(source)}><Trash2 size={12} />Remove</button>
            </div>
          </div>
        </article>;
      })}
      {scopedSources.length === 0 ? <div className="connection-empty-state">No Work Hub sources are configured for {companyName}. Add one from a Company-owned account connection.</div> : null}
    </div>

    {adding ? <div className="nested-settings-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAdding(false); }}>
      <div className="nested-settings-dialog" role="dialog" aria-modal="true" aria-label={`Add ${companyName} Work Hub source`}>
        <header><h2>Add Work Hub sources</h2><p>Sources created here are permanently owned by {companyName} through the selected connection.</p></header>
        <label><span>Account connection</span><UiSelect ariaLabel={`${companyName} Work Hub account`} value={connectionId} options={connectionOptions} onChange={changeConnection} /></label>
        <div className="settings-option-group">
          {SOURCE_KINDS.map((entry) => {
            const alreadyExists = scopedSources.some((source) => source.connectionId === connectionId && source.kind === entry.kind);
            const selected = selectedKinds.includes(entry.kind);
            return <button type="button" key={entry.kind} disabled={alreadyExists} className={`${selected ? 'selected' : ''}${alreadyExists ? ' added' : ''}`} onClick={() => toggleKind(entry.kind)}>
              <SourceIcon kind={entry.kind} /><span><strong>{entry.label}{alreadyExists ? ' · added' : ''}</strong><small>{entry.description}</small></span>
            </button>;
          })}
        </div>
        <div className="nested-settings-dialog-actions">
          <button type="button" onClick={() => setAdding(false)}>Cancel</button>
          <button type="button" className="settings-save-button" disabled={busy !== undefined || !connectionId || selectedKinds.length === 0} onClick={() => void saveSources()}>{busy === 'add' ? 'Adding…' : 'Add sources'}</button>
        </div>
      </div>
    </div> : null}
  </section>;
}
