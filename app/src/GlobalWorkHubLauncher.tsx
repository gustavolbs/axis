import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Inbox,
  LayoutDashboard,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Trash2,
  X
} from 'lucide-react';

import type { CompanyDefinition } from './app-types.js';
import type {
  WorkHubCalendarEventView,
  WorkHubMessageView,
  WorkHubSnapshotView,
  WorkHubSourceStateView,
  WorkHubSourceView,
  WorkHubTicketView
} from './native.js';

interface GlobalWorkHubLauncherProps {
  tab: WorkHubTab;
  onTabChange: (tab: WorkHubTab) => void;
}

export type WorkHubTab = 'today' | 'calendar' | 'work' | 'inbox' | 'sources';
type WorkHubScope = 'all' | string;

const BOARD_COLUMNS: Array<{ id: string; label: string; statuses: WorkHubTicketView['normalizedStatus'][] }> = [
  { id: 'todo', label: 'To do', statuses: ['backlog', 'todo', 'unknown'] },
  { id: 'progress', label: 'In progress', statuses: ['in-progress'] },
  { id: 'blocked', label: 'Blocked', statuses: ['blocked'] },
  { id: 'review', label: 'Review', statuses: ['review'] },
  { id: 'qa', label: 'QA', statuses: ['qa'] },
  { id: 'done', label: 'Done', statuses: ['done'] }
];

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function localDate(value: string): string { return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function localDateTime(value: string): string { return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function localTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function todayKey(date = new Date()): string { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function sameLocalDay(value: string, date = new Date()): boolean { return todayKey(new Date(value)) === todayKey(date); }
function stateLabel(status: string): string { return status === 'in-progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1); }
function kindLabel(kind: WorkHubSourceView['kind']): string { return kind === 'calendar' ? 'Calendar' : kind === 'tickets' ? 'My Work' : 'Inbox'; }
function elapsedLabel(start: string | undefined, now: number): string {
  if (!start) return '';
  const seconds = Math.max(0, Math.floor((now - Date.parse(start)) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function durationLabel(durationMs: number | undefined): string {
  if (durationMs === undefined) return '';
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function syncStageLabel(state: WorkHubSourceStateView | undefined): string {
  if (state?.stage === 'discovering') return 'Checking connected services';
  if (state?.stage === 'collecting') return `Reading ${state.systems?.join(', ') || 'connected services'}`;
  if (state?.stage === 'normalizing') return 'Organizing your data';
  return 'Syncing';
}
function startOfLocalWeek(value = new Date()): Date {
  const result = new Date(value);
  result.setDate(result.getDate() - result.getDay());
  result.setHours(0, 0, 0, 0);
  return result;
}
function addLocalDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}
function storedScope(): WorkHubScope {
  return localStorage.getItem('local-coder.work-hub-company-filter')?.trim() || 'all';
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function CompanyBadge({ name }: { name: string }) {
  return <span className="connection-count work-hub-company-badge">{name}</span>;
}

export function GlobalWorkHubLauncher({ tab, onTabChange: setTab }: GlobalWorkHubLauncherProps) {
  const bridge = window.lc;
  const [snapshot, setSnapshot] = useState<WorkHubSnapshotView>();
  const [companies, setCompanies] = useState<CompanyDefinition[]>([]);
  const [scope, setScopeState] = useState<WorkHubScope>(storedScope);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [clock, setClock] = useState(() => Date.now());
  const [weekStart, setWeekStart] = useState(() => startOfLocalWeek().getTime());
  const automaticRefreshStarted = useRef(false);
  const mainRef = useRef<HTMLElement>(null);

  function setScope(next: WorkHubScope) {
    localStorage.setItem('local-coder.work-hub-company-filter', next);
    setScopeState(next);
  }

  async function loadSnapshot() {
    if (!bridge) return undefined;
    const next = await bridge.workHubSnapshot();
    setSnapshot(next);
    return next;
  }

  async function load() {
    if (!bridge) return undefined;
    const [nextSnapshot, companyResponse] = await Promise.all([
      bridge.workHubSnapshot(),
      api<{ context: { companies: CompanyDefinition[] } }>('/api/companies/context')
    ]);
    const activeCompanies = companyResponse.context.companies
      .filter((company) => !company.archivedAt)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
    setSnapshot(nextSnapshot);
    setCompanies(activeCompanies);
    setScopeState((current) => current === 'all' || activeCompanies.some((company) => company.id === current) ? current : 'all');
    return nextSnapshot;
  }

  useEffect(() => {
    if (automaticRefreshStarted.current) return;
    automaticRefreshStarted.current = true;
    void load().then((loaded) => {
      const hasCachedSnapshot = loaded?.sourceStates.some((state) => Boolean(state.lastSyncedAt)) === true;
      if (loaded?.sources.length && !hasCachedSnapshot && !loaded.sourceStates.some((state) => state.status === 'syncing')) {
        void refreshScope();
      }
    }).catch((next) => setError(errorMessage(next)));
  }, []);

  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [tab, scope]);

  const activeCompanies = companies;
  const companyIndex = (companyId: string) => Math.max(0, activeCompanies.findIndex((company) => company.id === companyId));
  const companyClass = (companyId: string) => `account-tone-${companyIndex(companyId) % 6}`;
  const inScope = (companyId: string) => scope === 'all' || companyId === scope;

  const sourcesById = useMemo(() => new Map((snapshot?.sources ?? []).map((source) => [source.id, source])), [snapshot]);
  const scopedSources = useMemo(() => (snapshot?.sources ?? []).filter((source) => inScope(source.companyId)), [snapshot, scope]);
  const scopedSourceIds = useMemo(() => new Set(scopedSources.map((source) => source.id)), [scopedSources]);
  const scopedStates = useMemo(() => (snapshot?.sourceStates ?? []).filter((state) => scopedSourceIds.has(state.sourceId)), [snapshot, scopedSourceIds]);
  const visibleEvents = useMemo(() => (snapshot?.events ?? []).filter((event) => inScope(event.companyId)), [snapshot, scope]);
  const visibleTickets = useMemo(() => (snapshot?.tickets ?? []).filter((ticket) => inScope(ticket.companyId)), [snapshot, scope]);
  const visibleMessages = useMemo(() => (snapshot?.messages ?? []).filter((message) => inScope(message.companyId)), [snapshot, scope]);
  const todayEvents = useMemo(() => visibleEvents.filter((event) => sameLocalDay(event.start)), [visibleEvents]);
  const activeTickets = useMemo(() => visibleTickets.filter((ticket) => !['done', 'cancelled'].includes(ticket.normalizedStatus)), [visibleTickets]);
  const attentionMessages = useMemo(() => visibleMessages.filter((message) => message.unread || message.requiresAttention), [visibleMessages]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addLocalDays(new Date(weekStart), index)), [weekStart]);
  const weekEnd = useMemo(() => addLocalDays(new Date(weekStart), 7).getTime(), [weekStart]);
  const weekEvents = useMemo(() => visibleEvents.filter((event) => {
    const start = Date.parse(event.start);
    return start >= weekStart && start < weekEnd;
  }), [visibleEvents, weekStart, weekEnd]);
  const weekTitle = useMemo(() => {
    const first = new Date(weekStart);
    const last = addLocalDays(first, 6);
    return `${first.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }, [weekStart]);
  const latestSyncedAt = useMemo(() => scopedStates.map((state) => state.lastSyncedAt).filter((value): value is string => Boolean(value)).sort().at(-1), [scopedStates]);
  const syncingStates = useMemo(() => scopedStates.filter((state) => state.status === 'syncing'), [scopedStates]);
  const hasActiveSync = busy?.startsWith('refresh') === true || scopedStates.some((state) => state.status === 'syncing');

  useEffect(() => {
    const poll = window.setInterval(() => {
      setClock(Date.now());
      if (hasActiveSync) void loadSnapshot().catch((next) => setError(errorMessage(next)));
    }, hasActiveSync ? 1_000 : 30_000);
    return () => window.clearInterval(poll);
  }, [hasActiveSync]);

  async function refreshScope() {
    if (!bridge) return;
    setBusy('refresh');
    setError(undefined);
    try {
      if (scope === 'all') {
        setSnapshot(await bridge.refreshWorkHub());
      } else {
        let next = snapshot;
        for (const source of scopedSources.filter((candidate) => candidate.enabled)) {
          next = await bridge.refreshWorkHub(source.id);
        }
        if (next) setSnapshot(next); else await loadSnapshot();
      }
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(undefined);
      await loadSnapshot().catch(() => {});
    }
  }

  async function refreshSource(source: WorkHubSourceView) {
    if (!bridge || !inScope(source.companyId)) return;
    setBusy(`refresh:${source.id}`);
    setError(undefined);
    try { setSnapshot(await bridge.refreshWorkHub(source.id)); }
    catch (next) { setError(errorMessage(next)); }
    finally { setBusy(undefined); await loadSnapshot().catch(() => {}); }
  }

  async function updateMessage(message: WorkHubMessageView, action: 'read' | 'dismiss') {
    if (!bridge || !inScope(message.companyId)) return;
    setBusy(`${action}:${message.sourceId}:${message.externalId}`);
    setError(undefined);
    try {
      setSnapshot(action === 'read'
        ? await bridge.markWorkHubMessageRead(message.sourceId, message.externalId)
        : await bridge.dismissWorkHubMessage(message.sourceId, message.externalId));
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(undefined);
    }
  }

  if (!bridge) return null;

  const sourceName = (id: string) => sourcesById.get(id)?.label ?? id;
  const externalLink = (url?: string, label = 'Open') => url
    ? <a className="work-hub-link" href={url} target="_blank" rel="noreferrer"><span>{label}</span><ExternalLink size={11} /></a>
    : null;
  const pageTitle = tab === 'today' ? 'Today' : tab === 'calendar' ? 'Calendar' : tab === 'work' ? 'My Work' : tab === 'inbox' ? 'Inbox' : 'Sources';
  const scopeName = scope === 'all' ? 'All contexts' : activeCompanies.find((company) => company.id === scope)?.name ?? 'All contexts';

  return <section className="work-hub-shell work-hub-page" aria-label="Work Hub">
    <aside className="work-hub-rail">
      <div className="work-hub-rail-title">Work Hub</div>
      {([
        ['inbox', Inbox, 'Inbox'],
        ['work', BriefcaseBusiness, 'My Work'],
        ['today', LayoutDashboard, 'Today'],
        ['calendar', CalendarDays, 'Calendar'],
        ['sources', Settings2, 'Sources']
      ] as const).map(([id, Icon, label]) => <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={15} /><span>{label}</span></button>)}
      <div className="work-hub-rail-footer"><span className={hasActiveSync ? 'syncing' : ''} />{hasActiveSync ? 'Sync in progress' : `${scopedSources.length} visible source${scopedSources.length === 1 ? '' : 's'}`}</div>
    </aside>

    <main className="work-hub-main" ref={mainRef}>
      <header className="work-hub-header">
        <div><h2>{pageTitle}</h2><p>{tab === 'sources' ? 'Aggregation and sync health for Company-owned sources. Configure sources inside the owning Company.' : `${scopeName} · meetings, work and messages with canonical Company provenance.${latestSyncedAt ? ` Updated ${localDateTime(latestSyncedAt)}.` : ''}`}</p></div>
        <div className="work-hub-actions"><button type="button" className="btn-secondary" disabled={hasActiveSync || scopedSources.length === 0} onClick={() => void refreshScope()}><RefreshCw className={hasActiveSync ? 'spin' : ''} size={13} />{hasActiveSync ? 'Syncing…' : 'Sync visible'}</button></div>
      </header>

      {error ? <div className="work-hub-error"><AlertCircle size={15} /><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error"><X size={13} /></button></div> : null}
      {syncingStates.length > 0 ? <div className="work-hub-sync-banner"><LoaderCircle className="spin" size={16} /><div><strong>Syncing {syncingStates.length === 1 ? sourceName(syncingStates[0]!.sourceId) : `${syncingStates.length} sources`}</strong><small>{syncingStates.map((state) => `${syncStageLabel(state)} · ${elapsedLabel(state.syncStartedAt, clock)}`).join('  •  ')}</small></div></div> : null}

      <div className="work-hub-account-filter work-hub-company-filter" aria-label="Filter Work Hub by Company">
        <span className="work-hub-account-filter-label">Scope</span>
        <button type="button" className={`work-hub-account-toggle${scope === 'all' ? ' active' : ''}`} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All</button>
        {activeCompanies.map((company) => <button type="button" key={company.id} className={`work-hub-account-toggle ${companyClass(company.id)}${scope === company.id ? ' active' : ''}`} aria-pressed={scope === company.id} onClick={() => setScope(company.id)} data-company-id={company.id}><span className="work-hub-account-swatch" />{company.name}</button>)}
      </div>

      {tab === 'today' ? <>
        <div className="work-hub-summary-grid">
          <button className="work-hub-stat" onClick={() => setTab('calendar')}><CalendarDays size={16} /><strong>{todayEvents.length}</strong><small>meetings today</small></button>
          <button className="work-hub-stat" onClick={() => setTab('work')}><BriefcaseBusiness size={16} /><strong>{activeTickets.length}</strong><small>active work items</small></button>
          <button className="work-hub-stat" onClick={() => setTab('inbox')}><Inbox size={16} /><strong>{attentionMessages.length}</strong><small>need attention</small></button>
        </div>
        <section className="work-hub-section">
          <div className="work-hub-section-heading"><h3>Today’s schedule</h3><button onClick={() => setTab('calendar')}>View calendar</button></div>
          <div className="work-hub-list">
            {todayEvents.map((item) => <div className={`work-hub-item ${companyClass(item.companyId)}`} key={`${item.sourceId}:${item.externalId}`} data-company-id={item.companyId}>
              <div className="work-hub-time">{item.allDay ? 'All day' : localTime(item.start)}</div>
              <div className="work-hub-item-copy"><strong>{item.title}</strong><small>{item.companyName} · {sourceName(item.sourceId)} · {item.system}{item.location ? ` · ${item.location}` : ''}</small></div>
              <aside><CompanyBadge name={item.companyName} />{externalLink(item.meetingUrl ?? item.url, item.meetingUrl ? 'Join' : 'Open')}</aside>
            </div>)}
            {todayEvents.length === 0 ? <div className="work-hub-empty"><CalendarDays size={20} /><strong>No meetings for this scope today</strong><span>Configure a Company-owned calendar source, then sync it.</span></div> : null}
          </div>
        </section>
        <section className="work-hub-section">
          <div className="work-hub-section-heading"><h3>Priority work</h3><button onClick={() => setTab('work')}>Open board</button></div>
          <div className="work-hub-list">
            {activeTickets.slice(0, 8).map((item) => <div className={`work-hub-item ${companyClass(item.companyId)}`} key={`${item.sourceId}:${item.externalId}`} data-company-id={item.companyId}>
              <span className={`work-hub-ticket-status status-${item.normalizedStatus}`}>{stateLabel(item.normalizedStatus)}</span>
              <div className="work-hub-item-copy"><strong>{item.key} · {item.title}</strong><small>{item.companyName} · {sourceName(item.sourceId)} · {item.system}{item.priority ? ` · ${item.priority}` : ''}</small></div>
              <aside><CompanyBadge name={item.companyName} />{externalLink(item.url, 'Open ticket')}</aside>
            </div>)}
            {activeTickets.length === 0 ? <div className="work-hub-empty"><BriefcaseBusiness size={20} /><strong>No active work for this scope</strong><span>Company-owned ticket sources populate this section.</span></div> : null}
          </div>
        </section>
      </> : null}

      {tab === 'calendar' ? <div className="work-hub-calendar">
        <div className="work-hub-calendar-toolbar">
          <div className="work-hub-calendar-nav">
            <button className="work-hub-icon-button" onClick={() => setWeekStart((value) => addLocalDays(new Date(value), -7).getTime())} aria-label="Previous week"><ChevronLeft size={15} /></button>
            <button className="work-hub-calendar-today" onClick={() => setWeekStart(startOfLocalWeek().getTime())}>Today</button>
            <button className="work-hub-icon-button" onClick={() => setWeekStart((value) => addLocalDays(new Date(value), 7).getTime())} aria-label="Next week"><ChevronRight size={15} /></button>
          </div>
          <strong>{weekTitle}</strong><span>{weekEvents.length} event{weekEvents.length === 1 ? '' : 's'}</span>
        </div>
        <div className="work-hub-list work-hub-week-list" aria-label={`Week of ${weekTitle}`}>
          {weekDays.map((day) => {
            const events = weekEvents.filter((event) => sameLocalDay(event.start, day));
            return <section className="work-hub-section" key={todayKey(day)}>
              <div className="work-hub-section-heading"><h3>{day.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h3><span>{events.length || ''}</span></div>
              {events.map((event) => <article className={`work-hub-item work-hub-calendar-event ${companyClass(event.companyId)}`} key={`${event.sourceId}:${event.externalId}`} data-company-id={event.companyId} title={`${event.companyName} · ${sourceName(event.sourceId)}`}>
                <div className="work-hub-time">{event.allDay ? 'All day' : `${localTime(event.start)}–${localTime(event.end)}`}</div>
                <div className="work-hub-item-copy"><strong>{event.title}</strong><small>{event.companyName} · {event.system}{event.calendar ? ` · ${event.calendar}` : ''}{event.location ? ` · ${event.location}` : ''}</small></div>
                <aside><CompanyBadge name={event.companyName} />{externalLink(event.meetingUrl ?? event.url, event.meetingUrl ? 'Join' : 'Open')}</aside>
              </article>)}
              {events.length === 0 ? <div className="work-hub-column-empty">No events</div> : null}
            </section>;
          })}
        </div>
      </div> : null}

      {tab === 'work' ? <div className="work-hub-board">{BOARD_COLUMNS.map((column) => {
        const tickets = visibleTickets.filter((ticket) => column.statuses.includes(ticket.normalizedStatus));
        return <section className={`work-hub-board-column column-${column.id}`} key={column.id}><header><span>{column.label}</span><small>{tickets.length}</small></header><div>
          {tickets.map((item) => <article className={`work-hub-ticket-card ${companyClass(item.companyId)}`} key={`${item.sourceId}:${item.externalId}`} data-company-id={item.companyId}>
            <div className="work-hub-ticket-meta"><span>{item.key}</span><CompanyBadge name={item.companyName} />{item.priority ? <span>{item.priority}</span> : null}</div>
            <strong>{item.title}</strong><small>{item.project ?? item.system} · {sourceName(item.sourceId)}</small>
            <footer><span>{item.updatedAt ? localDate(item.updatedAt) : item.companyName}</span>{externalLink(item.url, 'Open ticket')}</footer>
          </article>)}
          {tickets.length === 0 ? <div className="work-hub-column-empty">No tickets</div> : null}
        </div></section>;
      })}{visibleTickets.length === 0 ? <div className="work-hub-board-empty"><BriefcaseBusiness size={22} /><strong>Your work board is empty for this scope</strong><span>Configure Company-owned work sources to populate it.</span></div> : null}</div> : null}

      {tab === 'inbox' ? <div className="work-hub-list">{visibleMessages.map((item) => <div className={`work-hub-item ${companyClass(item.companyId)} ${item.unread ? 'unread' : ''}`} key={`${item.sourceId}:${item.externalId}`} data-company-id={item.companyId}>
        <span className="work-hub-message-dot" />
        <div className="work-hub-item-copy"><strong>{item.title}</strong><small>{item.companyName} · {sourceName(item.sourceId)} · {item.system}{item.sender ? ` · ${item.sender}` : ''}</small>{item.preview ? <p>{item.preview}</p> : null}</div>
        <aside><CompanyBadge name={item.companyName} /><time>{localDate(item.timestamp)}<br />{localTime(item.timestamp)}</time><div className="work-hub-message-actions">{item.unread || item.requiresAttention ? <button className="work-hub-message-action" disabled={busy !== undefined} onClick={() => void updateMessage(item, 'read')} aria-label={`Mark ${item.title} as read`}><CheckCircle2 size={11} />Mark read</button> : <span className="work-hub-message-read">Read</span>}<button className="work-hub-message-action" disabled={busy !== undefined} onClick={() => void updateMessage(item, 'dismiss')} aria-label={`Dismiss ${item.title}`}><Trash2 size={11} />Dismiss</button>{externalLink(item.url)}</div></aside>
      </div>)}{visibleMessages.length === 0 ? <div className="work-hub-empty large"><Inbox size={24} /><strong>Your inbox is empty for this scope</strong><span>Dismissed messages stay hidden locally; source administration remains inside Companies.</span></div> : null}</div> : null}

      {tab === 'sources' ? <>
        <div className="work-hub-source-toolbar"><div><strong>{scopedSources.length} source{scopedSources.length === 1 ? '' : 's'}</strong><span>Read-only aggregation and health. Add, remove or reassign sources only inside their owning Company.</span></div></div>
        <div className="work-hub-source-list">
          {scopedSources.map((source) => {
            const state = scopedStates.find((candidate) => candidate.sourceId === source.id);
            const syncing = state?.status === 'syncing' || busy === `refresh:${source.id}`;
            return <article className={`work-hub-source-row ${companyClass(source.companyId)}`} key={source.id} data-company-id={source.companyId} data-source-id={source.id}>
              <div className="work-hub-source-identity"><Settings2 size={15} /><span><strong>{source.label}</strong><small>{source.companyName} · {kindLabel(source.kind)} · {source.connectionId}</small></span></div>
              <div className="work-hub-source-state"><CompanyBadge name={source.companyName} /><span className={`status-${state?.status ?? 'idle'}`}>{state?.status ?? 'idle'}</span><small>{state?.itemCount ?? 0} items{state?.durationMs ? ` · ${durationLabel(state.durationMs)}` : ''}</small></div>
              <div className="work-hub-source-actions"><button className="btn-secondary" disabled={busy !== undefined} onClick={() => void refreshSource(source)}><RefreshCw className={syncing ? 'spin' : ''} size={12} />{syncing ? 'Syncing…' : 'Sync'}</button></div>
              {state?.error ? <div className="work-hub-source-error">{state.error}</div> : null}
            </article>;
          })}
          {scopedSources.length === 0 ? <div className="work-hub-empty large"><Settings2 size={24} /><strong>No sources for this scope</strong><span>Open the owning Company → Connections to configure Work Hub sources.</span></div> : null}
        </div>
      </> : null}
    </main>
  </section>;
}
