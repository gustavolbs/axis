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
  MapPin,
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

const CALENDAR_START_HOUR = 6;
const CALENDAR_END_HOUR = 22;
const CALENDAR_HOUR_HEIGHT = 58;
const CALENDAR_TIME_WIDTH = 52;
const CALENDAR_DAY_WIDTH = 168;

interface CalendarPlacement {
  event: WorkHubCalendarEventView;
  lane: number;
  laneCount: number;
}

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
function minutesOfDay(value: string): number {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}
function calendarEventKey(event: WorkHubCalendarEventView): string {
  return `${event.sourceId}:${event.externalId}`;
}
function calendarEventDetails(event: WorkHubCalendarEventView, sourceLabel: string): string {
  const timing = event.allDay
    ? `${localDate(event.start)} · All day`
    : `${localDate(event.start)} · ${localTime(event.start)}–${localTime(event.end)}`;
  return [
    timing,
    event.companyName,
    sourceLabel,
    event.system,
    event.calendar,
    event.location,
    event.organizer ? `Organizer: ${event.organizer}` : undefined,
    event.status ? `Status: ${event.status}` : undefined
  ].filter((value): value is string => Boolean(value)).join(' · ');
}
function placeCalendarEvents(events: WorkHubCalendarEventView[]): CalendarPlacement[] {
  const sorted = [...events].sort((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end));
  const laneEnds: number[] = [];
  const placements = sorted.map((event) => {
    const start = Date.parse(event.start);
    const end = Math.max(start + 15 * 60_000, Date.parse(event.end));
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = end;
    return { event, lane, laneCount: 1 };
  });
  const laneCount = Math.max(1, laneEnds.length);
  return placements.map((placement) => ({ ...placement, laneCount }));
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
  const [activeCalendarEventKey, setActiveCalendarEventKey] = useState<string>();
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

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    setActiveCalendarEventKey(undefined);
  }, [tab, scope, weekStart]);

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
  const calendarWidth = CALENDAR_TIME_WIDTH + CALENDAR_DAY_WIDTH * 7;
  const calendarHeight = (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * CALENDAR_HOUR_HEIGHT;
  const now = new Date(clock);
  const currentDayIndex = weekDays.findIndex((day) => todayKey(day) === todayKey(now));
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const showCurrentTime = currentDayIndex >= 0 && currentMinute >= CALENDAR_START_HOUR * 60 && currentMinute <= CALENDAR_END_HOUR * 60;
  const timedCalendarPlacements = weekDays.flatMap((day, dayIndex) => {
    const dayEvents = weekEvents.filter((event) => !event.allDay && sameLocalDay(event.start, day));
    return placeCalendarEvents(dayEvents).map((placement) => ({ ...placement, day, dayIndex }));
  });
  const paintedCalendarPlacements = [...timedCalendarPlacements].sort((left, right) =>
    Number(calendarEventKey(left.event) === activeCalendarEventKey) - Number(calendarEventKey(right.event) === activeCalendarEventKey));

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
        <div className="work-hub-week-scroll">
          <div className="work-hub-week" role="grid" aria-label={`Week of ${weekTitle}`}>
            <div className="work-hub-week-header" role="row">
              <span className="work-hub-week-zone">Local</span>
              {weekDays.map((day) => <div className={todayKey(day) === todayKey(now) ? 'today' : ''} key={todayKey(day)} role="columnheader"><span>{day.toLocaleDateString([], { weekday: 'short' })}</span><strong>{day.getDate()}</strong></div>)}
            </div>
            <div className="work-hub-all-day" role="row">
              <span>all-day</span>
              {weekDays.map((day) => <div key={todayKey(day)}>{weekEvents.filter((event) => event.allDay && sameLocalDay(event.start, day)).map((event) => {
                const link = event.meetingUrl ?? event.url;
                const details = calendarEventDetails(event, sourceName(event.sourceId));
                return link
                  ? <a key={calendarEventKey(event)} className={`work-hub-all-day-event ${companyClass(event.companyId)}`} href={link} target="_blank" rel="noreferrer" title={details} data-company-id={event.companyId}>{event.title}</a>
                  : <span key={calendarEventKey(event)} className={`work-hub-all-day-event ${companyClass(event.companyId)}`} title={details} data-company-id={event.companyId}>{event.title}</span>;
              })}</div>)}
            </div>
            <svg className="work-hub-week-grid" viewBox={`0 0 ${calendarWidth} ${calendarHeight}`} role="img" aria-label={`Weekly calendar, ${weekTitle}`}>
              <rect className="work-hub-week-grid-bg" x="0" y="0" width={calendarWidth} height={calendarHeight} />
              {Array.from({ length: CALENDAR_END_HOUR - CALENDAR_START_HOUR + 1 }, (_, index) => {
                const hour = CALENDAR_START_HOUR + index;
                const y = index * CALENDAR_HOUR_HEIGHT;
                return <g key={hour}><line className="work-hub-hour-line" x1={CALENDAR_TIME_WIDTH} x2={calendarWidth} y1={y} y2={y} /><text className="work-hub-hour-label" x={CALENDAR_TIME_WIDTH - 8} y={Math.min(calendarHeight - 4, y + 4)}>{`${String(hour).padStart(2, '0')}:00`}</text></g>;
              })}
              {weekDays.map((day, dayIndex) => <line className={`work-hub-day-line${todayKey(day) === todayKey(now) ? ' today' : ''}`} key={todayKey(day)} x1={CALENDAR_TIME_WIDTH + dayIndex * CALENDAR_DAY_WIDTH} x2={CALENDAR_TIME_WIDTH + dayIndex * CALENDAR_DAY_WIDTH} y1="0" y2={calendarHeight} />)}
              {paintedCalendarPlacements.map(({ event, lane, laneCount, day, dayIndex }) => {
                const rawStart = minutesOfDay(event.start);
                const rawEnd = sameLocalDay(event.end, day) ? minutesOfDay(event.end) : CALENDAR_END_HOUR * 60;
                const visibleStart = Math.max(CALENDAR_START_HOUR * 60, Math.min(CALENDAR_END_HOUR * 60 - 15, rawStart));
                const visibleEnd = Math.max(visibleStart + 15, Math.min(CALENDAR_END_HOUR * 60, rawEnd));
                const laneWidth = (CALENDAR_DAY_WIDTH - 5) / laneCount;
                const x = CALENDAR_TIME_WIDTH + dayIndex * CALENDAR_DAY_WIDTH + 3 + lane * laneWidth;
                const y = ((visibleStart - CALENDAR_START_HOUR * 60) / 60) * CALENDAR_HOUR_HEIGHT + 2;
                const height = Math.max(25, ((visibleEnd - visibleStart) / 60) * CALENDAR_HOUR_HEIGHT - 3);
                const link = event.meetingUrl ?? event.url;
                const key = calendarEventKey(event);
                const details = calendarEventDetails(event, sourceName(event.sourceId));
                return <foreignObject key={key} x={x} y={y} width={Math.max(34, laneWidth - 2)} height={height}>
                  <article
                    className={`work-hub-calendar-event ${companyClass(event.companyId)}`}
                    tabIndex={0}
                    data-company-id={event.companyId}
                    aria-label={`${event.title}. ${details}`}
                    onMouseEnter={() => setActiveCalendarEventKey(key)}
                    onMouseLeave={() => setActiveCalendarEventKey((current) => current === key ? undefined : current)}
                    onFocus={() => setActiveCalendarEventKey(key)}
                    onBlur={() => setActiveCalendarEventKey((current) => current === key ? undefined : current)}
                  >
                    <strong>{event.title}</strong>
                    <small>{localTime(event.start)}–{localTime(event.end)}</small>
                    <span>{event.companyName}</span>
                    {event.location ? <span><MapPin size={9} />{event.location}</span> : null}
                    {link ? <a className="work-hub-calendar-join" href={link} target="_blank" rel="noreferrer">{event.meetingUrl ? 'Join' : 'Open'}<ExternalLink size={9} /></a> : null}
                    <div className="work-hub-calendar-tooltip" role="tooltip"><strong>{event.title}</strong><span>{details}</span></div>
                  </article>
                </foreignObject>;
              })}
              {showCurrentTime ? <g className="work-hub-now"><circle cx={CALENDAR_TIME_WIDTH + currentDayIndex * CALENDAR_DAY_WIDTH + 3} cy={((currentMinute - CALENDAR_START_HOUR * 60) / 60) * CALENDAR_HOUR_HEIGHT} r="3" /><line x1={CALENDAR_TIME_WIDTH + currentDayIndex * CALENDAR_DAY_WIDTH + 3} x2={CALENDAR_TIME_WIDTH + (currentDayIndex + 1) * CALENDAR_DAY_WIDTH} y1={((currentMinute - CALENDAR_START_HOUR * 60) / 60) * CALENDAR_HOUR_HEIGHT} y2={((currentMinute - CALENDAR_START_HOUR * 60) / 60) * CALENDAR_HOUR_HEIGHT} /></g> : null}
            </svg>
          </div>
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
        <div className="work-hub-source-toolbar"><div><strong>{scopedSources.length} source{scopedSources.length === 1 ? '' : 's'}</strong><span>Read-only aggregation and sync health. Add, remove or reassign sources only inside their owning Company.</span></div></div>
        <div className="work-hub-list">
          {scopedSources.map((source) => {
            const state = scopedStates.find((candidate) => candidate.sourceId === source.id);
            const status = state?.status ?? 'idle';
            const syncing = status === 'syncing' || busy === `refresh:${source.id}`;
            const detail = syncing
              ? `${syncStageLabel(state)}${state?.syncStartedAt ? ` · ${elapsedLabel(state.syncStartedAt, clock)}` : ''}`
              : `${stateLabel(status)} · ${state?.itemCount ?? 0} item${state?.itemCount === 1 ? '' : 's'}${state?.durationMs ? ` · ${durationLabel(state.durationMs)}` : ''}`;
            const SourceIcon = source.kind === 'calendar' ? CalendarDays : source.kind === 'tickets' ? BriefcaseBusiness : Inbox;
            return <article className={`work-hub-source-card ${companyClass(source.companyId)} status-${status}`} key={source.id} data-company-id={source.companyId} data-source-id={source.id}>
              <div className="work-hub-source-icon"><SourceIcon size={17} /></div>
              <div className="work-hub-source-copy">
                <strong>{source.label}</strong>
                <small>{source.companyName} · {kindLabel(source.kind)} · {source.connectionId}</small>
                <span className="work-hub-state">{syncing ? <LoaderCircle className="spin" size={11} /> : status === 'ready' ? <CheckCircle2 size={11} /> : status === 'error' ? <AlertCircle size={11} /> : <Settings2 size={11} />}{detail}</span>
              </div>
              <div className="work-hub-source-actions"><CompanyBadge name={source.companyName} /><button className="btn-secondary" disabled={busy !== undefined} onClick={() => void refreshSource(source)}><RefreshCw className={syncing ? 'spin' : ''} size={12} />{syncing ? 'Syncing…' : status === 'error' ? 'Try again' : 'Sync'}</button></div>
              {state?.error ? <div className="work-hub-source-error"><AlertCircle size={13} /><span>{state.error}</span></div> : null}
            </article>;
          })}
          {scopedSources.length === 0 ? <div className="work-hub-empty large"><Settings2 size={24} /><strong>No sources for this scope</strong><span>Open the owning Company → Connections to configure Work Hub sources.</span></div> : null}
        </div>
      </> : null}
    </main>
  </section>;
}
