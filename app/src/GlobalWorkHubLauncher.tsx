import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  BriefcaseBusiness,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Inbox,
  LayoutDashboard,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X
} from 'lucide-react';

import type {
  ProviderConnectionView,
  WorkHubCalendarEventView,
  WorkHubMessageView,
  WorkHubSnapshotView,
  WorkHubSourceKind,
  WorkHubSourceStateView,
  WorkHubSourceView,
  WorkHubTicketView
} from './native.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

interface GlobalWorkHubLauncherProps {
  tab: WorkHubTab;
  onTabChange: (tab: WorkHubTab) => void;
}

export type WorkHubTab = 'today' | 'calendar' | 'work' | 'inbox' | 'sources';

const SYNC_KINDS: Array<{ kind: WorkHubSourceKind; label: string; description: string }> = [
  { kind: 'calendar', label: 'Calendar', description: 'Meetings and events from connected calendars' },
  { kind: 'tickets', label: 'My work', description: 'Assigned tickets from Jira, Linear and other trackers' },
  { kind: 'messages', label: 'Messages', description: 'Jira comments on your tickets and attention-worthy Slack messages' }
];

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

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function slug(value: string): string { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'source'; }
function localDate(value: string): string { return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function localDateTime(value: string): string { return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function localTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function todayKey(date = new Date()): string { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
function sameLocalDay(value: string, date = new Date()): boolean { const d = new Date(value); return todayKey(d) === todayKey(date); }
function stateLabel(status: string): string { return status === 'in-progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1); }
function kindLabel(kind: WorkHubSourceKind): string { return SYNC_KINDS.find((entry) => entry.kind === kind)?.label ?? kind; }
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
  const day = result.getDay();
  result.setDate(result.getDate() - day);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addLocalDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function minutesOfDay(value: string): number {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

function calendarTone(event: WorkHubCalendarEventView): number {
  let hash = 0;
  for (const character of `${event.calendar ?? event.system}:${event.sourceId}`) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 4;
}

function calendarEventDetails(event: WorkHubCalendarEventView, sourceLabel: string): string {
  const timing = event.allDay ? localDate(event.start) : `${localDate(event.start)} · ${localTime(event.start)}–${localTime(event.end)}`;
  return [timing, sourceLabel, event.system, event.calendar, event.location, event.organizer ? `Organizer: ${event.organizer}` : undefined, event.status ? `Status: ${event.status}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

interface CalendarPlacement {
  event: WorkHubCalendarEventView;
  lane: number;
  laneCount: number;
}

function placeCalendarEvents(events: WorkHubCalendarEventView[]): CalendarPlacement[] {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const laneEnds: number[] = [];
  const placements = sorted.map((event) => {
    const start = new Date(event.start).getTime();
    const end = Math.max(start + 15 * 60_000, new Date(event.end).getTime());
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = end;
    return { event, lane, laneCount: 1 };
  });
  const laneCount = Math.max(1, laneEnds.length);
  return placements.map((placement) => ({ ...placement, laneCount }));
}

export function GlobalWorkHubLauncher({ tab, onTabChange: setTab }: GlobalWorkHubLauncherProps) {
  const bridge = window.lc;
  const [snapshot, setSnapshot] = useState<WorkHubSnapshotView>();
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [selectedKinds, setSelectedKinds] = useState<WorkHubSourceKind[]>(['calendar']);
  const [clock, setClock] = useState(() => Date.now());
  const [weekStart, setWeekStart] = useState(() => startOfLocalWeek().getTime());
  const [visibleConnectionIds, setVisibleConnectionIds] = useState<string[] | undefined>();
  const automaticRefreshStarted = useRef(false);
  const mainRef = useRef<HTMLElement>(null);

  async function loadSnapshot() {
    if (!bridge) return;
    setSnapshot(await bridge.workHubSnapshot());
  }

  async function load(): Promise<WorkHubSnapshotView | undefined> {
    if (!bridge) return undefined;
    const [nextSnapshot, nextConnections] = await Promise.all([bridge.workHubSnapshot(), bridge.providerConnections()]);
    setSnapshot(nextSnapshot);
    const mcpConnections = nextConnections.filter((connection) => connection.supportsMcpSources);
    setConnections(mcpConnections);
    setVisibleConnectionIds((current) => current?.filter((id) => mcpConnections.some((connection) => connection.id === id)));
    setConnectionId((current) => current && mcpConnections.some((connection) => connection.id === current) ? current : mcpConnections[0]?.id ?? '');
    return nextSnapshot;
  }

  useEffect(() => {
    if (automaticRefreshStarted.current) return;
    automaticRefreshStarted.current = true;
    void load()
      .then((loaded) => {
        const hasCachedSnapshot = loaded?.sourceStates.some((state) => Boolean(state.lastSyncedAt)) === true;
        if (loaded?.sources.length && !hasCachedSnapshot && !loaded.sourceStates.some((state) => state.status === 'syncing')) void refresh();
      })
      .catch((next) => setError(errorMessage(next)));
  }, []);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [tab]);

  const hasActiveSync = busy?.startsWith('refresh') === true || snapshot?.sourceStates.some((state) => state.status === 'syncing') === true;
  useEffect(() => {
    const poll = window.setInterval(() => {
      setClock(Date.now());
      if (hasActiveSync) void loadSnapshot().catch((next) => setError(errorMessage(next)));
    }, hasActiveSync ? 1_000 : 30_000);
    return () => window.clearInterval(poll);
  }, [hasActiveSync]);

  const connectionOptions = useMemo<UiSelectOption[]>(() => connections.map((connection) => ({
    value: connection.id,
    label: connection.label,
    description: `${connection.providerFamily} · ${connection.organizationLabel ?? 'personal'}`
  })), [connections]);
  const activeConnectionIds = visibleConnectionIds ?? connections.map((connection) => connection.id);
  const accountTone = (connectionId: string) => {
    const index = connections.findIndex((connection) => connection.id === connectionId);
    return index < 0 ? 0 : index % 6;
  };
  const accountClass = (connectionId: string) => `account-tone-${accountTone(connectionId)}`;
  const toggleConnection = (connectionId: string) => {
    setVisibleConnectionIds((current) => {
      const selected = current ?? connections.map((connection) => connection.id);
      return selected.includes(connectionId) ? selected.filter((id) => id !== connectionId) : [...selected, connectionId];
    });
  };
  const isConnectionVisible = (connectionId: string) => activeConnectionIds.includes(connectionId);
  const sourcesById = useMemo(() => new Map((snapshot?.sources ?? []).map((source) => [source.id, source])), [snapshot]);
  const visibleEvents = useMemo(() => (snapshot?.events ?? []).filter((event) => isConnectionVisible(event.connectionId)), [snapshot, activeConnectionIds]);
  const visibleTickets = useMemo(() => (snapshot?.tickets ?? []).filter((ticket) => isConnectionVisible(ticket.connectionId)), [snapshot, activeConnectionIds]);
  const visibleMessages = useMemo(() => (snapshot?.messages ?? []).filter((item) => isConnectionVisible(item.connectionId)), [snapshot, activeConnectionIds]);
  const todayEvents = useMemo(() => visibleEvents.filter((event) => sameLocalDay(event.start)), [visibleEvents]);
  const activeTickets = useMemo(() => visibleTickets.filter((ticket) => !['done', 'cancelled'].includes(ticket.normalizedStatus)), [visibleTickets]);
  const attentionMessages = useMemo(() => visibleMessages.filter((item) => item.unread || item.requiresAttention), [visibleMessages]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addLocalDays(new Date(weekStart), index)), [weekStart]);
  const weekEnd = useMemo(() => addLocalDays(new Date(weekStart), 7).getTime(), [weekStart]);
  const weekEvents = useMemo(() => visibleEvents.filter((event) => {
    const start = new Date(event.start).getTime();
    return start >= weekStart && start < weekEnd;
  }), [visibleEvents, weekStart, weekEnd]);
  const latestSyncedAt = useMemo(() => (snapshot?.sourceStates ?? [])
    .map((state) => state.lastSyncedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1), [snapshot]);
  const weekTitle = useMemo(() => {
    const first = new Date(weekStart);
    const last = addLocalDays(first, 6);
    const firstLabel = first.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const lastLabel = last.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    return `${firstLabel} – ${lastLabel}`;
  }, [weekStart]);
  const syncingStates = useMemo(() => (snapshot?.sourceStates ?? []).filter((state) => state.status === 'syncing'), [snapshot]);

  async function refresh(sourceId?: string) {
    if (!bridge) return;
    setBusy(sourceId ? `refresh:${sourceId}` : 'refresh');
    setError(undefined);
    setSnapshot((current) => current ? {
      ...current,
      sourceStates: current.sourceStates.map((state) => !sourceId || state.sourceId === sourceId
        ? { ...state, status: 'syncing', stage: 'discovering', syncStartedAt: new Date().toISOString(), error: undefined }
        : state)
    } : current);
    try { setSnapshot(await bridge.refreshWorkHub(sourceId)); }
    catch (next) { setError(errorMessage(next)); }
    finally { setBusy(undefined); await loadSnapshot().catch(() => {}); }
  }

  function toggleKind(kind: WorkHubSourceKind) {
    setSelectedKinds((current) => current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind]);
  }

  function prepareSourceForm(nextConnectionId = connectionId) {
    const existing = new Set((snapshot?.sources ?? [])
      .filter((source) => source.connectionId === nextConnectionId)
      .map((source) => source.kind));
    const firstAvailable = SYNC_KINDS.find((entry) => !existing.has(entry.kind))?.kind;
    setSelectedKinds(firstAvailable ? [firstAvailable] : []);
    setAdding(true);
  }

  function changeSourceConnection(nextConnectionId: string) {
    setConnectionId(nextConnectionId);
    prepareSourceForm(nextConnectionId);
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
          retention: 'local'
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

  async function updateMessage(message: WorkHubMessageView, action: 'read' | 'dismiss') {
    if (!bridge) return;
    const actionKey = `${action}:${message.sourceId}:${message.externalId}`;
    setBusy(actionKey); setError(undefined);
    try {
      const nextSnapshot = action === 'read'
        ? await bridge.markWorkHubMessageRead(message.sourceId, message.externalId)
        : await bridge.dismissWorkHubMessage(message.sourceId, message.externalId);
      setSnapshot(nextSnapshot);
    } catch (next) { setError(errorMessage(next)); }
    finally { setBusy(undefined); }
  }

  if (!bridge) return null;

  const sourceName = (id: string) => sourcesById.get(id)?.label ?? id;
  const externalLink = (url?: string, labelText = 'Open') => url ? <a className="work-hub-link" href={url} target="_blank" rel="noreferrer"><span>{labelText}</span><ExternalLink size={11} /></a> : null;
  const syncAllLabel = hasActiveSync ? 'Syncing…' : 'Sync all';
  const calendarWidth = CALENDAR_TIME_WIDTH + CALENDAR_DAY_WIDTH * 7;
  const calendarHeight = (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * CALENDAR_HOUR_HEIGHT;
  const now = new Date(clock);
  const currentDayIndex = weekDays.findIndex((day) => todayKey(day) === todayKey(now));
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const showCurrentTime = currentDayIndex >= 0 && currentMinute >= CALENDAR_START_HOUR * 60 && currentMinute <= CALENDAR_END_HOUR * 60;

  return <section className="work-hub-shell work-hub-page" aria-label="Work Hub">
      <aside className="work-hub-rail">
        <div className="work-hub-rail-title">Work Hub</div>
        {([
          ['inbox', Inbox, 'Messages'], ['work', BriefcaseBusiness, 'Work board'], ['today', LayoutDashboard, 'Overview'], ['calendar', CalendarDays, 'Calendar'], ['sources', Settings2, 'Sources']
        ] as const).map(([id, Icon, text]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={15} /><span>{text}</span></button>)}
        <div className="work-hub-rail-footer"><span className={hasActiveSync ? 'syncing' : ''} />{hasActiveSync ? 'Sync in progress' : `${snapshot?.sources.length ?? 0} connected source${snapshot?.sources.length === 1 ? '' : 's'}`}</div>
      </aside>

      <main className="work-hub-main" ref={mainRef}>
        <header className="work-hub-header">
          <div><h2>{tab === 'today' ? 'Overview' : tab === 'calendar' ? 'Calendar' : tab === 'work' ? 'Work board' : tab === 'inbox' ? 'Messages' : 'Sources'}</h2><p>{tab === 'sources' ? 'Choose an account and what you want to sync. The provider discovers its connected services automatically. Messages includes Jira comments on your tickets and Slack messages.' : `Your meetings, work and messages across connected accounts.${latestSyncedAt ? ` Updated ${localDateTime(latestSyncedAt)}.` : ''}`}</p></div>
          <div className="work-hub-actions">{tab !== 'sources' ? <button className="btn-secondary" disabled={hasActiveSync || (snapshot?.sources.length ?? 0) === 0} onClick={() => void refresh()}><RefreshCw className={hasActiveSync ? 'spin' : ''} size={13} />{syncAllLabel}</button> : null}</div>
        </header>

        {error ? <div className="work-hub-error"><AlertCircle size={15} /><span>{error}</span><button onClick={() => setError(undefined)} aria-label="Dismiss error"><X size={13} /></button></div> : null}
        {syncingStates.length > 0 ? <div className="work-hub-sync-banner"><LoaderCircle className="spin" size={16} /><div><strong>Syncing {syncingStates.length === 1 ? sourceName(syncingStates[0]!.sourceId) : `${syncingStates.length} sources`}</strong><small>{syncingStates.map((state) => `${syncStageLabel(state)} · ${elapsedLabel(state.syncStartedAt, clock)}`).join('  •  ')}</small></div></div> : null}
        {connections.length > 0 ? <div className="work-hub-account-filter" aria-label="Filter by connected account"><span className="work-hub-account-filter-label">Accounts</span>{connections.map((connection) => <button key={connection.id} className={`work-hub-account-toggle ${accountClass(connection.id)}${isConnectionVisible(connection.id) ? ' active' : ''}`} onClick={() => toggleConnection(connection.id)} aria-pressed={isConnectionVisible(connection.id)}><span className="work-hub-account-swatch" />{connection.label}</button>)}</div> : null}

        {tab === 'today' ? <>
          <div className="work-hub-summary-grid"><button className="work-hub-stat" onClick={() => setTab('calendar')}><CalendarDays size={16} /><strong>{todayEvents.length}</strong><small>meetings today</small></button><button className="work-hub-stat" onClick={() => setTab('work')}><BriefcaseBusiness size={16} /><strong>{activeTickets.length}</strong><small>active tickets</small></button><button className="work-hub-stat" onClick={() => setTab('inbox')}><Inbox size={16} /><strong>{attentionMessages.length}</strong><small>need attention</small></button></div>
          <section className="work-hub-section"><div className="work-hub-section-heading"><h3>Today’s schedule</h3><button onClick={() => setTab('calendar')}>View calendar</button></div><div className="work-hub-list">{todayEvents.map((item) => <div className={`work-hub-item ${accountClass(item.connectionId)}`} key={`${item.sourceId}:${item.externalId}`}><div className="work-hub-time">{item.allDay ? 'All day' : localTime(item.start)}</div><div className="work-hub-item-copy"><strong>{item.title}</strong><small>{sourceName(item.sourceId)} · {item.system}{item.location ? ` · ${item.location}` : ''}</small></div><aside>{externalLink(item.meetingUrl ?? item.url, item.meetingUrl ? 'Join' : 'Open')}</aside></div>)}{todayEvents.length === 0 ? <div className="work-hub-empty"><CalendarDays size={20} /><strong>No meetings synced for today</strong><span>Sync a calendar source to see your day here.</span><button onClick={() => setTab('sources')}>Go to sources</button></div> : null}</div></section>
          <section className="work-hub-section"><div className="work-hub-section-heading"><h3>Priority work</h3><button onClick={() => setTab('work')}>Open board</button></div><div className="work-hub-list">{activeTickets.slice(0, 8).map((item) => <div className={`work-hub-item ${accountClass(item.connectionId)}`} key={`${item.sourceId}:${item.externalId}`}><span className={`work-hub-ticket-status status-${item.normalizedStatus}`}>{stateLabel(item.normalizedStatus)}</span><div className="work-hub-item-copy"><strong>{item.key} · {item.title}</strong><small>{sourceName(item.sourceId)} · {item.system}{item.priority ? ` · ${item.priority}` : ''}</small></div><aside>{externalLink(item.url, 'Open ticket')}</aside></div>)}{activeTickets.length === 0 ? <div className="work-hub-empty"><BriefcaseBusiness size={20} /><strong>No active tickets synced</strong><span>Add a work source to populate your board.</span><button onClick={() => setTab('sources')}>Go to sources</button></div> : null}</div></section>
        </> : null}

        {tab === 'calendar' ? <div className="work-hub-calendar">
          <div className="work-hub-calendar-toolbar">
            <div className="work-hub-calendar-nav">
              <button className="work-hub-icon-button" onClick={() => setWeekStart((value) => addLocalDays(new Date(value), -7).getTime())} aria-label="Previous week"><ChevronLeft size={15} /></button>
              <button className="work-hub-calendar-today" onClick={() => setWeekStart(startOfLocalWeek().getTime())}>Today</button>
              <button className="work-hub-icon-button" onClick={() => setWeekStart((value) => addLocalDays(new Date(value), 7).getTime())} aria-label="Next week"><ChevronRight size={15} /></button>
            </div>
            <strong>{weekTitle}</strong>
            <span>{weekEvents.length} event{weekEvents.length === 1 ? '' : 's'}</span>
          </div>

          {visibleEvents.length > 0 ? <div className="work-hub-week-scroll">
            <div className="work-hub-week" role="grid" aria-label={`Week of ${weekTitle}`}>
              <div className="work-hub-week-header" role="row">
                <span className="work-hub-week-zone">Local</span>
                {weekDays.map((day) => <div className={sameLocalDay(day.toISOString()) ? 'today' : ''} key={todayKey(day)} role="columnheader"><span>{day.toLocaleDateString([], { weekday: 'short' })}</span><strong>{day.getDate()}</strong></div>)}
              </div>
              {weekEvents.some((event) => event.allDay) ? <div className="work-hub-all-day" role="row">
                <span>all-day</span>
                {weekDays.map((day) => <div key={todayKey(day)}>{weekEvents.filter((event) => event.allDay && sameLocalDay(event.start, day)).map((event) => {
                  const link = event.meetingUrl ?? event.url;
                  return link
                    ? <a key={`${event.sourceId}:${event.externalId}`} className={`work-hub-all-day-event ${accountClass(event.connectionId)}`} href={link} target="_blank" rel="noreferrer" title={calendarEventDetails(event, sourceName(event.sourceId))}>{event.title}</a>
                    : <span key={`${event.sourceId}:${event.externalId}`} className={`work-hub-all-day-event ${accountClass(event.connectionId)}`} title={calendarEventDetails(event, sourceName(event.sourceId))}>{event.title}</span>;
                })}</div>)}
              </div> : null}
              <svg className="work-hub-week-grid" viewBox={`0 0 ${calendarWidth} ${calendarHeight}`} role="img" aria-label={`Weekly calendar, ${weekTitle}`}>
                <rect className="work-hub-week-grid-bg" x="0" y="0" width={calendarWidth} height={calendarHeight} />
                {Array.from({ length: CALENDAR_END_HOUR - CALENDAR_START_HOUR + 1 }, (_, index) => {
                  const hour = CALENDAR_START_HOUR + index;
                  const y = index * CALENDAR_HOUR_HEIGHT;
                  return <g key={hour}><line className="work-hub-hour-line" x1={CALENDAR_TIME_WIDTH} x2={calendarWidth} y1={y} y2={y} /><text className="work-hub-hour-label" x={CALENDAR_TIME_WIDTH - 8} y={Math.min(calendarHeight - 4, y + 4)}>{`${String(hour).padStart(2, '0')}:00`}</text></g>;
                })}
                {weekDays.map((day, dayIndex) => <line className={`work-hub-day-line${sameLocalDay(day.toISOString()) ? ' today' : ''}`} key={todayKey(day)} x1={CALENDAR_TIME_WIDTH + dayIndex * CALENDAR_DAY_WIDTH} x2={CALENDAR_TIME_WIDTH + dayIndex * CALENDAR_DAY_WIDTH} y1="0" y2={calendarHeight} />)}
                {weekDays.flatMap((day, dayIndex) => {
                  const dayEvents = weekEvents.filter((event) => !event.allDay && sameLocalDay(event.start, day));
                  return placeCalendarEvents(dayEvents).map(({ event, lane, laneCount }) => {
                    const rawStart = minutesOfDay(event.start);
                    const rawEnd = sameLocalDay(event.end, day) ? minutesOfDay(event.end) : CALENDAR_END_HOUR * 60;
                    const visibleStart = Math.max(CALENDAR_START_HOUR * 60, Math.min(CALENDAR_END_HOUR * 60 - 15, rawStart));
                    const visibleEnd = Math.max(visibleStart + 15, Math.min(CALENDAR_END_HOUR * 60, rawEnd));
                    const laneWidth = (CALENDAR_DAY_WIDTH - 5) / laneCount;
                    const x = CALENDAR_TIME_WIDTH + dayIndex * CALENDAR_DAY_WIDTH + 3 + lane * laneWidth;
                    const y = ((visibleStart - CALENDAR_START_HOUR * 60) / 60) * CALENDAR_HOUR_HEIGHT + 2;
                    const height = Math.max(25, ((visibleEnd - visibleStart) / 60) * CALENDAR_HOUR_HEIGHT - 3);
                    const link = event.meetingUrl ?? event.url;
                    return <foreignObject key={`${event.sourceId}:${event.externalId}`} x={x} y={y} width={Math.max(34, laneWidth - 2)} height={height}>
                      <article className={`work-hub-calendar-event ${accountClass(event.connectionId)}`} tabIndex={0} title={calendarEventDetails(event, sourceName(event.sourceId))} aria-label={`${event.title}. ${calendarEventDetails(event, sourceName(event.sourceId))}`}>
                        <strong>{event.title}</strong>
                        <small>{localTime(event.start)}–{localTime(event.end)}</small>
                        {event.location ? <span><MapPin size={9} />{event.location}</span> : null}
                        {link ? <a className="work-hub-calendar-join" href={link} target="_blank" rel="noreferrer">{event.meetingUrl ? 'Join' : 'Open'}<ExternalLink size={9} /></a> : null}
                        <div className="work-hub-calendar-tooltip" role="tooltip"><strong>{event.title}</strong><span>{calendarEventDetails(event, sourceName(event.sourceId))}</span></div>
                      </article>
                    </foreignObject>;
                  });
                })}
                {showCurrentTime ? <g className="work-hub-now"><circle cx={CALENDAR_TIME_WIDTH + currentDayIndex * CALENDAR_DAY_WIDTH + 3} cy={((currentMinute - CALENDAR_START_HOUR * 60) / 60) * CALENDAR_HOUR_HEIGHT} r="3" /><line x1={CALENDAR_TIME_WIDTH + currentDayIndex * CALENDAR_DAY_WIDTH + 3} x2={CALENDAR_TIME_WIDTH + (currentDayIndex + 1) * CALENDAR_DAY_WIDTH} y1={((currentMinute - CALENDAR_START_HOUR * 60) / 60) * CALENDAR_HOUR_HEIGHT} y2={((currentMinute - CALENDAR_START_HOUR * 60) / 60) * CALENDAR_HOUR_HEIGHT} /></g> : null}
              </svg>
            </div>
          </div> : <div className="work-hub-empty large"><CalendarDays size={24} /><strong>Your calendar is empty</strong><span>Choose a calendar source, then sync it to bring meetings into Work Hub.</span><button className="btn-primary" onClick={() => setTab('sources')}>Choose what to sync</button></div>}
        </div> : null}

        {tab === 'work' ? <div className="work-hub-board">{BOARD_COLUMNS.map((column) => {
          const tickets = visibleTickets.filter((ticket) => column.statuses.includes(ticket.normalizedStatus));
          return <section className={`work-hub-board-column column-${column.id}`} key={column.id}><header><span>{column.label}</span><small>{tickets.length}</small></header><div>{tickets.map((item) => <article className={`work-hub-ticket-card ${accountClass(item.connectionId)}`} key={`${item.sourceId}:${item.externalId}`}><div className="work-hub-ticket-meta"><span>{item.key}</span>{item.priority ? <span>{item.priority}</span> : null}</div><strong>{item.title}</strong><small>{item.project ?? item.system}</small><footer><span>{item.updatedAt ? localDate(item.updatedAt) : sourceName(item.sourceId)}</span>{externalLink(item.url, 'Open ticket')}</footer></article>)}{tickets.length === 0 ? <div className="work-hub-column-empty">No tickets</div> : null}</div></section>;
        })}{visibleTickets.length === 0 ? <div className="work-hub-board-empty"><BriefcaseBusiness size={22} /><strong>Your work board is empty</strong><span>Add and sync a ticket source to see assigned work here.</span><button onClick={() => setTab('sources')}>Go to sources</button></div> : null}</div> : null}

        {tab === 'inbox' ? <div className="work-hub-list">{visibleMessages.map((item) => <div className={`work-hub-item ${accountClass(item.connectionId)} ${item.unread ? 'unread' : ''}`} key={`${item.sourceId}:${item.externalId}`}><span className="work-hub-message-dot" /><div className="work-hub-item-copy"><strong>{item.title}</strong><small>{sourceName(item.sourceId)} · {item.system}{item.sender ? ` · ${item.sender}` : ''}</small>{item.preview ? <p>{item.preview}</p> : null}</div><aside><time>{localDate(item.timestamp)}<br />{localTime(item.timestamp)}</time><div className="work-hub-message-actions">{item.unread || item.requiresAttention ? <button className="work-hub-message-action" disabled={busy !== undefined} onClick={() => void updateMessage(item, 'read')} aria-label={`Mark ${item.title} as read`}><CheckCircle2 size={11} />Mark read</button> : <span className="work-hub-message-read">Read</span>}<button className="work-hub-message-action" disabled={busy !== undefined} onClick={() => void updateMessage(item, 'dismiss')} aria-label={`Dismiss ${item.title}`}><Trash2 size={11} />Dismiss</button>{externalLink(item.url)}</div></aside></div>)}{visibleMessages.length === 0 ? <div className="work-hub-empty large"><Inbox size={24} /><strong>Your inbox is empty</strong><span>Dismissed messages stay hidden locally.</span><button className="btn-primary" onClick={() => setTab('sources')}>Choose what to sync</button></div> : null}</div> : null}

        {tab === 'sources' ? <>
          <div className="work-hub-source-toolbar"><div><strong>{snapshot?.sources.length ?? 0} source{snapshot?.sources.length === 1 ? '' : 's'}</strong><span>Each source stays isolated to its selected account.</span></div><div className="work-hub-actions"><button className="btn-primary" onClick={() => adding ? setAdding(false) : prepareSourceForm()}><Plus size={13} />Choose what to sync</button><button className="btn-secondary" disabled={hasActiveSync || (snapshot?.sources.length ?? 0) === 0} onClick={() => void refresh()}><RefreshCw className={hasActiveSync ? 'spin' : ''} size={13} />{syncAllLabel}</button></div></div>
          {adding ? <form className="work-hub-source-form" onSubmit={(event) => void saveSources(event)}>
            <div className="work-hub-form-heading"><div><strong>Add sources</strong><span>Select an account and the information Work Hub should collect.</span></div><button type="button" onClick={() => setAdding(false)} aria-label="Close source form"><X size={15} /></button></div>
            <label><span>Account</span><UiSelect ariaLabel="Work Hub account" value={connectionId} options={connectionOptions} onChange={changeSourceConnection} /></label>
            <section><h3>Sync from this account</h3><div className="settings-option-group">{SYNC_KINDS.map((entry) => {
              const alreadyAdded = snapshot?.sources.some((source) => source.connectionId === connectionId && source.kind === entry.kind) === true;
              const selected = selectedKinds.includes(entry.kind);
              return <button key={entry.kind} type="button" className={`${selected && !alreadyAdded ? 'selected' : ''}${alreadyAdded ? ' added' : ''}`} disabled={alreadyAdded} onClick={() => toggleKind(entry.kind)} aria-pressed={selected && !alreadyAdded}><span><strong>{alreadyAdded ? `${entry.label} · Added` : entry.label}</strong><small>{entry.description}</small></span>{selected && !alreadyAdded ? <CheckCircle2 size={15} /> : null}</button>;
            })}</div></section>
            <div className="work-hub-source-form-actions"><button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn-primary" disabled={busy === 'save-source' || !connectionId || selectedKinds.length === 0}>{busy === 'save-source' ? 'Adding and syncing…' : 'Add and sync'}</button></div>
          </form> : null}
          <div className="work-hub-list">{(snapshot?.sources ?? []).map((source) => {
            const state = snapshot?.sourceStates.find((item) => item.sourceId === source.id);
            const connection = connections.find((item) => item.id === source.connectionId);
            const syncing = state?.status === 'syncing';
            const detail = syncing
              ? `${syncStageLabel(state)} · ${elapsedLabel(state.syncStartedAt, clock)}`
              : state?.status === 'ready'
                ? `${state.itemCount} item${state.itemCount === 1 ? '' : 's'} · Synced ${state.lastSyncedAt ? localDateTime(state.lastSyncedAt) : 'just now'}${durationLabel(state.durationMs) ? ` in ${durationLabel(state.durationMs)}` : ''}`
                : state?.status === 'error'
                  ? `Sync failed${durationLabel(state.durationMs) ? ` after ${durationLabel(state.durationMs)}` : ''}`
                  : state?.lastSyncedAt ? `Ready to sync · Last successful sync ${localDateTime(state.lastSyncedAt)}` : 'Never synced';
            return <article className={`work-hub-source-card ${accountClass(source.connectionId)} status-${state?.status ?? 'idle'}`} key={source.id}><div className="work-hub-source-icon">{source.kind === 'calendar' ? <CalendarDays size={17} /> : source.kind === 'tickets' ? <BriefcaseBusiness size={17} /> : <Inbox size={17} />}</div><div className="work-hub-source-copy"><strong>{source.label}</strong><small>{connection?.label ?? source.connectionId} · {kindLabel(source.kind)}{state?.systems?.length ? ` · ${state.systems.join(', ')}` : ''}</small><span className="work-hub-state">{syncing ? <LoaderCircle className="spin" size={11} /> : state?.status === 'ready' ? <CheckCircle2 size={11} /> : state?.status === 'error' ? <AlertCircle size={11} /> : <Clock3 size={11} />}{detail}</span></div><div className="work-hub-source-actions"><button className="btn-secondary" disabled={syncing || busy === 'refresh' || busy?.startsWith('remove:')} onClick={() => void refresh(source.id)}><RefreshCw className={syncing ? 'spin' : ''} size={12} />{syncing ? 'Syncing…' : state?.status === 'error' ? 'Try again' : 'Sync'}</button><button className="work-hub-icon-button" disabled={hasActiveSync || busy !== undefined} onClick={() => void removeSource(source)} aria-label={`Remove ${source.label}`}><Trash2 size={13} /></button></div>{state?.error ? <div className="work-hub-source-error"><AlertCircle size={13} /><span>{state.error}</span></div> : null}</article>;
          })}{(snapshot?.sources.length ?? 0) === 0 ? <div className="work-hub-empty large"><Settings2 size={24} /><strong>No sources yet</strong><span>Choose an account and what you want Work Hub to sync.</span><button className="btn-primary" onClick={() => prepareSourceForm()}>Choose what to sync</button></div> : null}</div>
        </> : null}
      </main>
  </section>;
}
