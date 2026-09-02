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
  WorkHubRetention,
  WorkHubSnapshotView,
  WorkHubSourceKind,
  WorkHubSourceView
} from './native.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

type WorkHubTab = 'today' | 'calendar' | 'work' | 'inbox' | 'sources';

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function slug(value: string): string { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'source'; }
function localDate(value: string): string { return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function localTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function todayKey(date = new Date()): string { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function sameLocalDay(value: string, date = new Date()): boolean { const d = new Date(value); return todayKey(d) === todayKey(date); }
function stateLabel(status: string): string { return status === 'in-progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1); }

const kindOptions: UiSelectOption[] = [
  { value: 'calendar', label: 'Calendar', description: 'Meetings and calendar events' },
  { value: 'tickets', label: 'Tickets', description: 'Jira, Linear, Trello or another work tracker' },
  { value: 'messages', label: 'Messages', description: 'Teams, Slack, mail or another work inbox' }
];
const retentionOptions: UiSelectOption[] = [
  { value: 'memory', label: 'Memory only', description: 'Safest default · cleared when Local Coder exits' },
  { value: 'local', label: 'Local cache', description: 'Persist normalized results on this Mac' }
];

export function GlobalWorkHubLauncher() {
  const bridge = window.lc;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<WorkHubTab>('today');
  const [snapshot, setSnapshot] = useState<WorkHubSnapshotView>();
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [kind, setKind] = useState<WorkHubSourceKind>('calendar');
  const [system, setSystem] = useState('');
  const [tools, setTools] = useState('');
  const [retention, setRetention] = useState<WorkHubRetention>('memory');

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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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

  async function saveSource(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !label.trim() || !connectionId || !system.trim()) return;
    const toolAllowlist = tools.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    setBusy('save-source'); setError(undefined);
    try {
      const baseId = slug(label);
      const id = snapshot?.sources.some((source) => source.id === baseId) ? `${baseId}-${Date.now().toString(36)}` : baseId;
      await bridge.upsertWorkHubSource({ id, label: label.trim(), connectionId, kind, system: system.trim(), toolAllowlist, retention });
      setLabel(''); setSystem(''); setTools(''); setRetention('memory'); setKind('calendar'); setAdding(false);
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

  if (!bridge) return null;

  const sourceName = (id: string) => sourcesById.get(id)?.label ?? id;
  const link = (url?: string, labelText = 'Open') => url ? <a href={url} target="_blank" rel="noreferrer">{labelText}</a> : null;

  return <>
    <button className="work-hub-launcher" onClick={() => setOpen(true)} aria-label="Open Work Hub"><LayoutDashboard size={16} /><span>Work Hub</span>{activeTickets.length + attentionMessages.length > 0 ? <b>{activeTickets.length + attentionMessages.length}</b> : null}</button>
    {open ? <div className="work-hub-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setOpen(false); }}>
      <section className="work-hub-shell" role="dialog" aria-modal="true" aria-label="Work Hub">
        <style>{`
          .work-hub-launcher{position:fixed;right:18px;bottom:18px;z-index:60;display:flex;align-items:center;gap:7px;height:34px;padding:0 11px;border:1px solid var(--lc-border);border-radius:999px;background:var(--lc-surface-raised);color:var(--lc-text);box-shadow:0 10px 28px rgba(0,0,0,.18);font-size:10px}.work-hub-launcher b{min-width:17px;height:17px;display:grid;place-items:center;border-radius:999px;background:var(--lc-text);color:var(--lc-surface);font-size:8px}.work-hub-backdrop{position:fixed;inset:0;z-index:120;background:rgba(0,0,0,.46);display:grid;place-items:center;padding:26px}.work-hub-shell{width:min(1120px,96vw);height:min(780px,92vh);display:grid;grid-template-columns:176px 1fr;border:1px solid var(--lc-border);border-radius:15px;background:var(--lc-background);overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.35)}.work-hub-rail{padding:18px 10px;border-right:1px solid var(--lc-border);background:var(--lc-sidebar-bg,var(--lc-surface))}.work-hub-rail h1{font-size:13px;margin:2px 9px 16px}.work-hub-rail button{width:100%;display:flex;align-items:center;gap:8px;border:0;border-radius:8px;background:transparent;color:var(--lc-muted);padding:8px 9px;font-size:10px;text-align:left}.work-hub-rail button.active{background:var(--lc-surface-raised);color:var(--lc-text)}.work-hub-main{min-width:0;overflow:auto;padding:22px 26px 36px}.work-hub-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.work-hub-header h2{margin:0;font-size:20px}.work-hub-header p{margin:4px 0 0;color:var(--lc-muted);font-size:10px}.work-hub-actions{display:flex;gap:7px}.work-hub-close{border:0;background:transparent;color:var(--lc-muted);width:30px;height:30px;display:grid;place-items:center}.work-hub-error{margin:0 0 14px;padding:9px 10px;border:1px solid var(--lc-negative);border-radius:8px;color:var(--lc-negative);font-size:9.5px}.work-hub-summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}.work-hub-stat{padding:13px;border:1px solid var(--lc-border);border-radius:11px;background:var(--lc-surface)}.work-hub-stat strong{display:block;font-size:22px}.work-hub-stat small{color:var(--lc-muted);font-size:9px}.work-hub-section{margin-top:20px}.work-hub-section>h3{font-size:11px;margin:0 0 8px}.work-hub-list{display:grid;gap:7px}.work-hub-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 11px;border:1px solid var(--lc-border);border-radius:10px;background:var(--lc-surface)}.work-hub-item strong,.work-hub-item small{display:block}.work-hub-item strong{font-size:10.5px;color:var(--lc-text-soft)}.work-hub-item small{margin-top:3px;font-size:9px;color:var(--lc-muted)}.work-hub-item aside{text-align:right;font-size:9px;color:var(--lc-muted)}.work-hub-item a{color:var(--lc-text-soft);text-decoration:none}.work-hub-group{margin-top:15px}.work-hub-group>header{display:flex;justify-content:space-between;margin-bottom:7px;color:var(--lc-muted);font-size:9.5px;text-transform:uppercase;letter-spacing:.04em}.work-hub-source-card{border:1px solid var(--lc-border);border-radius:11px;background:var(--lc-surface);overflow:hidden}.work-hub-source-main{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:11px 12px}.work-hub-source-main strong,.work-hub-source-main small{display:block}.work-hub-source-main small{margin-top:3px;color:var(--lc-muted);font-size:9px}.work-hub-source-actions{display:flex;align-items:center;gap:6px}.work-hub-state{display:inline-flex;align-items:center;gap:4px;font-size:9px;color:var(--lc-muted)}.work-hub-state.ready{color:var(--lc-positive)}.work-hub-source-error{padding:8px 12px;border-top:1px solid var(--lc-border);color:var(--lc-negative);font-size:9px}.work-hub-source-form{display:grid;gap:10px;padding:14px;margin-bottom:15px;border:1px solid var(--lc-border);border-radius:11px;background:var(--lc-surface)}.work-hub-source-form label>span{display:block;margin-bottom:5px;color:var(--lc-text-soft);font-size:9.5px}.work-hub-source-form textarea{min-height:74px;resize:vertical}.work-hub-source-form-actions{display:flex;justify-content:flex-end;gap:7px}.work-hub-empty{padding:22px;text-align:center;color:var(--lc-muted);font-size:10px;border:1px dashed var(--lc-border);border-radius:10px}@media(max-width:760px){.work-hub-shell{grid-template-columns:1fr;height:94vh}.work-hub-rail{display:flex;gap:4px;overflow:auto;border-right:0;border-bottom:1px solid var(--lc-border);padding:8px}.work-hub-rail h1{display:none}.work-hub-rail button{width:auto;white-space:nowrap}.work-hub-summary-grid{grid-template-columns:1fr}.work-hub-main{padding:16px}}
        `}</style>
        <aside className="work-hub-rail"><h1>Work Hub</h1>{([
          ['today', LayoutDashboard, 'Today'], ['calendar', CalendarDays, 'Calendar'], ['work', BriefcaseBusiness, 'Work'], ['inbox', Inbox, 'Inbox'], ['sources', Settings2, 'Sources']
        ] as const).map(([id, Icon, text]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={14} />{text}</button>)}</aside>
        <main className="work-hub-main">
          <header className="work-hub-header"><div><h2>{tab === 'today' ? 'Today' : tab === 'calendar' ? 'Calendar' : tab === 'work' ? 'My work' : tab === 'inbox' ? 'Inbox' : 'Sources'}</h2><p>Unified locally across isolated account connections.</p></div><div className="work-hub-actions">{tab !== 'sources' ? <button className="btn-secondary" disabled={busy !== undefined} onClick={() => void refresh()}><RefreshCw size={13} />{busy === 'refresh' ? 'Syncing…' : 'Sync all'}</button> : null}<button className="work-hub-close" onClick={() => setOpen(false)} aria-label="Close Work Hub"><X size={17} /></button></div></header>
          {error ? <div className="work-hub-error">{error}</div> : null}

          {tab === 'today' ? <>
            <div className="work-hub-summary-grid"><div className="work-hub-stat"><strong>{todayEvents.length}</strong><small>meetings today</small></div><div className="work-hub-stat"><strong>{activeTickets.length}</strong><small>active tickets</small></div><div className="work-hub-stat"><strong>{attentionMessages.length}</strong><small>messages needing attention</small></div></div>
            <section className="work-hub-section"><h3>Schedule</h3><div className="work-hub-list">{todayEvents.map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.title}</strong><small>{sourceName(item.sourceId)}{item.location ? ` · ${item.location}` : ''}</small></div><aside>{item.allDay ? 'All day' : `${localTime(item.start)}–${localTime(item.end)}`}<br />{link(item.meetingUrl ?? item.url, 'Join')}</aside></div>)}{todayEvents.length === 0 ? <div className="work-hub-empty">No calendar events synced for today.</div> : null}</div></section>
            <section className="work-hub-section"><h3>Priority work</h3><div className="work-hub-list">{activeTickets.slice(0, 12).map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.key} · {item.title}</strong><small>{sourceName(item.sourceId)} · {item.status}{item.priority ? ` · ${item.priority}` : ''}</small></div><aside>{stateLabel(item.normalizedStatus)}<br />{link(item.url)}</aside></div>)}{activeTickets.length === 0 ? <div className="work-hub-empty">No active tickets synced.</div> : null}</div></section>
          </> : null}

          {tab === 'calendar' ? <div className="work-hub-list">{(snapshot?.events ?? []).map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.title}</strong><small>{sourceName(item.sourceId)} · {localDate(item.start)}{item.calendar ? ` · ${item.calendar}` : ''}</small></div><aside>{item.allDay ? 'All day' : `${localTime(item.start)}–${localTime(item.end)}`}<br />{link(item.meetingUrl ?? item.url, 'Open')}</aside></div>)}{(snapshot?.events.length ?? 0) === 0 ? <div className="work-hub-empty">Add a calendar source and sync it.</div> : null}</div> : null}

          {tab === 'work' ? <>{ticketGroups.map(([status, tickets]) => <section className="work-hub-group" key={status}><header><span>{stateLabel(status)}</span><span>{tickets.length}</span></header><div className="work-hub-list">{tickets.map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.key} · {item.title}</strong><small>{sourceName(item.sourceId)} · {item.status}{item.priority ? ` · ${item.priority}` : ''}</small></div><aside>{item.updatedAt ? localDate(item.updatedAt) : ''}<br />{link(item.url)}</aside></div>)}</div></section>)}{activeTickets.length === 0 ? <div className="work-hub-empty">No active work synced.</div> : null}</> : null}

          {tab === 'inbox' ? <div className="work-hub-list">{(snapshot?.messages ?? []).map((item) => <div className="work-hub-item" key={`${item.sourceId}:${item.externalId}`}><div><strong>{item.title}</strong><small>{sourceName(item.sourceId)}{item.sender ? ` · ${item.sender}` : ''}{item.preview ? ` · ${item.preview}` : ''}</small></div><aside>{localDate(item.timestamp)} {localTime(item.timestamp)}<br />{link(item.url)}</aside></div>)}{(snapshot?.messages.length ?? 0) === 0 ? <div className="work-hub-empty">No messages synced.</div> : null}</div> : null}

          {tab === 'sources' ? <>
            <div className="work-hub-actions" style={{ marginBottom: 12 }}><button className="btn-primary" onClick={() => setAdding((value) => !value)}><Plus size={13} />Add source</button><button className="btn-secondary" disabled={busy !== undefined || (snapshot?.sources.length ?? 0) === 0} onClick={() => void refresh()}><RefreshCw size={13} />Sync all</button></div>
            {adding ? <form className="work-hub-source-form" onSubmit={(event) => void saveSource(event)}>
              <label><span>Connection</span><UiSelect ariaLabel="Work Hub connection" value={connectionId} options={connectionOptions} onChange={setConnectionId} /></label>
              <label><span>Data type</span><UiSelect ariaLabel="Work Hub data type" value={kind} options={kindOptions} onChange={(value) => setKind(value as WorkHubSourceKind)} /></label>
              <label><span>Source name</span><input required autoFocus value={label} onChange={(event) => setLabel(event.target.value)} placeholder="LiveNation Jira" /></label>
              <label><span>Remote system</span><input required value={system} onChange={(event) => setSystem(event.target.value)} placeholder="Jira, Google Calendar, Teams…" /></label>
              <label><span>Exact read-only MCP tools</span><textarea required value={tools} onChange={(event) => setTools(event.target.value)} placeholder={connectionId.includes('chatgpt') ? 'server/tool_name\nserver/another_read_tool' : 'mcp__claude_ai_Server__read_tool'} /><small>One per line or comma-separated. Local Coder never grants an implicit all-tools permission.</small></label>
              <label><span>Normalized-data retention</span><UiSelect ariaLabel="Work Hub retention" value={retention} options={retentionOptions} onChange={(value) => setRetention(value as WorkHubRetention)} /></label>
              <div className="work-hub-source-form-actions"><button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn-primary" disabled={busy === 'save-source' || !connectionId}>{busy === 'save-source' ? 'Saving…' : 'Add source'}</button></div>
            </form> : null}
            <div className="work-hub-list">{(snapshot?.sources ?? []).map((source) => {
              const state = snapshot?.sourceStates.find((item) => item.sourceId === source.id);
              const connection = connections.find((item) => item.id === source.connectionId);
              return <article className="work-hub-source-card" key={source.id}><div className="work-hub-source-main"><div><strong>{source.label}</strong><small>{connection?.label ?? source.connectionId} · {source.system} · {source.kind} · {source.retention === 'memory' ? 'memory only' : 'local cache'}</small><span className={`work-hub-state ${state?.status === 'ready' ? 'ready' : ''}`}>{state?.status === 'ready' ? <CheckCircle2 size={10} /> : null}{state?.status ?? 'idle'} · {state?.itemCount ?? 0} items</span></div><div className="work-hub-source-actions"><button className="btn-secondary" disabled={busy !== undefined} onClick={() => void refresh(source.id)}><RefreshCw size={12} />Sync</button><button className="btn-secondary" disabled={busy !== undefined} onClick={() => void removeSource(source)} aria-label={`Remove ${source.label}`}><Trash2 size={12} /></button></div></div>{state?.error ? <div className="work-hub-source-error">{state.error}</div> : null}</article>;
            })}{(snapshot?.sources.length ?? 0) === 0 ? <div className="work-hub-empty">No sources yet. Add each company/account separately and map its read-only MCP tools.</div> : null}</div>
          </> : null}
        </main>
      </section>
    </div> : null}
  </>;
}
