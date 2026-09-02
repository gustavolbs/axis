import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  Inbox,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X
} from 'lucide-react';

import type {
  ProviderConnectionView,
  WorkHubSnapshotView,
  WorkHubSourceKind,
  WorkHubSourceView
} from './native.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

interface GlobalWorkHubLauncherProps {
  open: boolean;
  onClose: () => void;
}

type WorkHubTab = 'today' | 'calendar' | 'work' | 'inbox' | 'sources';

const SYNC_KINDS: Array<{ kind: WorkHubSourceKind; label: string; description: string }> = [
  { kind: 'calendar', label: 'Calendar', description: 'Meetings and events from connected calendars' },
  { kind: 'tickets', label: 'My work', description: 'Assigned tickets from Jira, Linear and other trackers' },
  { kind: 'messages', label: 'Messages', description: 'Useful threads from Teams, Slack, mail and other inboxes' }
];

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function slug(value: string): string { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'source'; }
function localDate(value: string): string { return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function localTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function todayKey(date = new Date()): string { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function sameLocalDay(value: string, date = new Date()): boolean { const d = new Date(value); return todayKey(d) === todayKey(date); }
function stateLabel(status: string): string { return status === 'in-progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1); }
function kindLabel(kind: WorkHubSourceKind): string { return SYNC_KINDS.find((entry) => entry.kind === kind)?.label ?? kind; }

export function GlobalWorkHubLauncher({ open, onClose }: GlobalWorkHubLauncherProps) {
  const bridge = window.lc;
  const [tab, setTab] = useState<WorkHubTab>('today');
  const [snapshot, setSnapshot] = useState<WorkHubSnapshotView>();
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [selectedKinds, setSelectedKinds] = useState<WorkHubSourceKind[]>(['calendar']);

  async function load() {
    if (!bridge) return;
    const [nextSnapshot, nextConnections] = await Promise.all([bridge.workHubSnapshot(), bridge.providerConnections()]);
    setSnapshot(nextSnapshot);
    const mcpConnections = nextConnections.filter((connection) => connection.supportsMcpSources);
    setConnections(mcpConnections);
    setConnectionId((current) => current && mcpConnections.some((connection) => connection.id === current) ? current : mcpConnections[0]?.id ?? '');
  }

  useEffect(() => { if (open) void load().catch((next) => setError(errorMessage(next))); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const connectionOptions = useMemo<UiSelectOption[]>(() => connections.map((connection) => ({
    value: connection.id,
    label: connection.label,
    description: `${connection.providerFamily} · ${connection.organizationLabel ?? 'personal'}`
  })), [connections]);
  const sourcesById = useMemo(() => new Map((snapshot?.sources ?? []).map((source) => [source.id, source])), [snapshot]);
  const todayEvents = useMemo(() => (snapshot?.events ?? []).filter((event) => sameLocalDay(event.start)), [snapshot]);
  const activeTickets = useMemo(() => (snapshot?.tickets ?? []).filter((ticket) => !['done', 'cancelled'].includes(ticket.normalizedStatus)), [snapshot]);
  const attentionMessages = useMemo(() => (snapshot?.messages ?? []).filter((item) => item.unread || item.requiresAttention), [snapshot]);
  const ticketGroups = useMemo(() => {
    const groups = new Map<string, typeof activeTickets>();
    for (const ticket of activeTickets) groups.set(ticket.normalizedStatus, [...(groups.get(ticket.normalizedStatus) ?? []), ticket]);
    return [...groups.entries()];
  }, [activeTickets]);

  async function refresh(sourceId?: string) {
    if (!bridge) return;
    setBusy(sourceId ? `refresh:${sourceId}` : 'refresh');
    setError(undefined);
    try { setSnapshot(await bridge.refreshWorkHub(sourceId)); }
    catch (next) { setError(errorMessage(next)); }
    finally { setBusy(undefined); }
  }

  function toggleKind(kind: WorkHubSourceKind) {
    setSelectedKinds((current) => current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind]);
  }

  async function saveSources(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !connectionId || selectedKinds.length === 0) return;
    const connection = connections.find((candidate) => candidate.id === connectionId);
    if (!connection) return;
    const existing = new Set((snapshot?.sources ?? []).filter((source) => source.connectionId === connectionId).map((source) => source.kind));
    const kinds = selectedKinds.filter((kind) => !existing.has(kind));
    if (kinds.length === 0) {
      setError('Everything selected for this account is already in Work Hub.');
      return;
    }
    setBusy('save-source'); setError(undefined);
    try {
      let nextSnapshot = snapshot;
      for (const kind of kinds) {
        const id = `${slug(connection.id)}-${kind}`;
        const source = await bridge.upsertWorkHubSource({
          id,
          label: `${connection.label} · ${kindLabel(kind)}`,
          connectionId,
          kind,
          system: 'Connected services',
          toolAllowlist: [],
          retention: 'memory'
        });
        nextSnapshot = await bridge.refreshWorkHub(source.id);
      }
      if (nextSnapshot) setSnapshot(nextSnapshot);
      setSelectedKinds(['calendar']);
      setAdding(false);
      await load();
    } catch (next) { setError(errorMessage(next)); }
    finally { setBusy(undefined); }
  }

  async function removeSource(source: WorkHubSourceView) {
    if (!bridge) return;
    setBusy(`remove:${source.id}`); setError(undefined);
    try { await bridge.removeWorkHubSource(source.id); await load(); }
    catch (next) { setError(errorMessage(next)); }
    finally { setBusy(undefined); }
  }

  if (!bridge || !open) return null;

  const sourceName = (id: string) => sourcesById.get(id)?.label ?? id;
  const link = (url?: string, labelText = 'Open') => url ? <a href={url} target="_blank" rel="noreferrer">{labelText}</a> : null;

  return <div className="work-hub-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="work-hub-shell" role="dialog" aria-modal="true" aria-label="Work Hub">
      <aside className="work-hub-rail"><h1>Work Hub</h1>{([
        ['today', LayoutDashboard, 'Today'], ['calendar', CalendarDays, 'Calendar'], ['work', BriefcaseBusiness, 'Work'], ['inbox', Inbox, 'Inbox'], ['sources', Settings2, 'Sources']
      ] as const).map(([id, Icon, text]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={14} />{text}</button>)}</aside>
      <main className="work-hub-main">
        <header className="work-hub-header"><div><h2>{tab === 'today' ? 'Today' : tab === 'calendar' ? 'Calendar' : tab === 'work' ? 'My work' : tab === 'inbox' ? 'Inbox' : 'Sources'}</h2><p>{tab === 'sources' ? 'Choose an account and what you want to sync. The provider discovers its connected services automatically.' : 'Unified locally across isolated account connections.'}</p></div><div className="work-hub-actions">{tab !== 'sources' ? <button className="btn-secondary" disabled={busy !== undefined} onClick={() => void refresh()}><RefreshCw size={13} />{busy === 'refresh' ? 'Syncing…' : 'Sync all'}</button> : null}<button className="work-hub-close" onClick={onClose} aria-label="Close Work Hub"><X size={17} /></button></div></header>
        {error ? <div className="work-hub-error">{error}</div> : null}

        {tab === 'today' ? <>
          <div className="work-hub-summary-grid"><div className="work-hub-stat"><strong>{todayEvents.length}</strong><small>meetings today</small></div><div className="work-hub-stat"><strong>{activeTickets.length}</strong><small>active tickets</small></div><div className="work-hub-stat"><strong>{attentionMessages.length}</strong><small>messages needing attention</small></div></div>
          <section className="work-hub-section"><h3>Schedule</h3><div className="work-hub-list">{todayEvents.map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.title}</strong><small>{sourceName(item.sourceId)} · {item.system}{item.location ? ` · ${item.location}` : ''}</small></div><aside>{item.allDay ? 'All day' : `${localTime(item.start)}–${localTime(item.end)}`}<br />{link(item.meetingUrl ?? item.url, 'Join')}</aside></div>)}{todayEvents.length === 0 ? <div className="work-hub-empty">No calendar events synced for today.</div> : null}</div></section>
          <section className="work-hub-section"><h3>Priority work</h3><div className="work-hub-list">{activeTickets.slice(0, 12).map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.key} · {item.title}</strong><small>{sourceName(item.sourceId)} · {item.system} · {item.status}{item.priority ? ` · ${item.priority}` : ''}</small></div><aside>{stateLabel(item.normalizedStatus)}<br />{link(item.url)}</aside></div>)}{activeTickets.length === 0 ? <div className="work-hub-empty">No active tickets synced.</div> : null}</div></section>
        </> : null}

        {tab === 'calendar' ? <div className="work-hub-list">{(snapshot?.events ?? []).map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.title}</strong><small>{sourceName(item.sourceId)} · {item.system} · {localDate(item.start)}{item.calendar ? ` · ${item.calendar}` : ''}</small></div><aside>{item.allDay ? 'All day' : `${localTime(item.start)}–${localTime(item.end)}`}<br />{link(item.meetingUrl ?? item.url, 'Open')}</aside></div>)}{(snapshot?.events.length ?? 0) === 0 ? <div className="work-hub-empty">Choose a calendar source and sync it.</div> : null}</div> : null}

        {tab === 'work' ? <>{ticketGroups.map(([status, tickets]) => <section className="work-hub-group" key={status}><header><span>{stateLabel(status)}</span><span>{tickets.length}</span></header><div className="work-hub-list">{tickets.map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.key} · {item.title}</strong><small>{sourceName(item.sourceId)} · {item.system} · {item.status}{item.priority ? ` · ${item.priority}` : ''}</small></div><aside>{item.updatedAt ? localDate(item.updatedAt) : ''}<br />{link(item.url)}</aside></div>)}</div></section>)}{activeTickets.length === 0 ? <div className="work-hub-empty">No active work synced.</div> : null}</> : null}

        {tab === 'inbox' ? <div className="work-hub-list">{(snapshot?.messages ?? []).map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.title}</strong><small>{sourceName(item.sourceId)} · {item.system}{item.sender ? ` · ${item.sender}` : ''}{item.preview ? ` · ${item.preview}` : ''}</small></div><aside>{localDate(item.timestamp)} {localTime(item.timestamp)}<br />{link(item.url)}</aside></div>)}{(snapshot?.messages.length ?? 0) === 0 ? <div className="work-hub-empty">No messages synced.</div> : null}</div> : null}

        {tab === 'sources' ? <>
          <div className="work-hub-actions"><button className="btn-primary" onClick={() => setAdding((value) => !value)}><Plus size={13} />Choose what to sync</button><button className="btn-secondary" disabled={busy !== undefined || (snapshot?.sources.length ?? 0) === 0} onClick={() => void refresh()}><RefreshCw size={13} />Sync all</button></div>
          {adding ? <form className="work-hub-source-form" onSubmit={(event) => void saveSources(event)}>
            <label><span>Account</span><UiSelect ariaLabel="Work Hub account" value={connectionId} options={connectionOptions} onChange={setConnectionId} /></label>
            <section className="work-hub-section"><h3>Sync from this account</h3><div className="settings-option-group">{SYNC_KINDS.map((entry) => {
              const alreadyAdded = snapshot?.sources.some((source) => source.connectionId === connectionId && source.kind === entry.kind) === true;
              const selected = selectedKinds.includes(entry.kind);
              return <button key={entry.kind} type="button" className={selected ? 'selected' : ''} disabled={alreadyAdded} onClick={() => toggleKind(entry.kind)}><span><strong>{alreadyAdded ? `${entry.label} · Added` : entry.label}</strong><small>{entry.description}</small></span></button>;
            })}</div></section>
            <div className="work-hub-source-form-actions"><button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn-primary" disabled={busy === 'save-source' || !connectionId || selectedKinds.length === 0}>{busy === 'save-source' ? 'Adding and syncing…' : 'Add and sync'}</button></div>
          </form> : null}
          <div className="work-hub-list">{(snapshot?.sources ?? []).map((source) => {
            const state = snapshot?.sourceStates.find((item) => item.sourceId === source.id);
            const connection = connections.find((item) => item.id === source.connectionId);
            return <article className="work-hub-source-card" key={source.id}><div className="work-hub-source-main"><div><strong>{source.label}</strong><small>{connection?.label ?? source.connectionId} · {kindLabel(source.kind)}</small><span className={`work-hub-state ${state?.status === 'ready' ? 'ready' : ''}`}>{state?.status === 'ready' ? <CheckCircle2 size={10} /> : null}{state?.status ?? 'idle'} · {state?.itemCount ?? 0} items</span></div><div className="work-hub-source-actions"><button className="btn-secondary" disabled={busy !== undefined} onClick={() => void refresh(source.id)}><RefreshCw size={12} />Sync</button><button className="btn-secondary" disabled={busy !== undefined} onClick={() => void removeSource(source)} aria-label={`Remove ${source.label}`}><Trash2 size={12} /></button></div></div>{state?.error ? <div className="work-hub-source-error">{state.error}</div> : null}</article>;
          })}{(snapshot?.sources.length ?? 0) === 0 ? <div className="work-hub-empty">No sources yet. Choose an account and what you want Work Hub to sync.</div> : null}</div>
        </> : null}
      </main>
    </section>
  </div>;
}
