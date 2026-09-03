import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';
import {
  Check,
  ChevronDown,
  CircleStop,
  Code,
  FileText,
  FolderGit2,
  LoaderCircle,
  Pencil,
  Sparkles,
  Square,
  X
} from 'lucide-react';

import type {
  AgentDecisionRequest,
  AgentDecisionResolution,
  AgentLifecycleEvent
} from '../../src/agent-runtime/contracts.js';
import {
  formatAttachmentSize,
  formatRuntimeMetadata,
  presentAgentLifecycle,
  type RuntimeActivityItem,
  type RuntimeActivityKind
} from './agent-runtime-presentation.js';

export interface RuntimePermissionResolution {
  readonly callId: string;
  readonly allowed: boolean;
}

export interface RuntimeEvidencePane {
  readonly id: 'filesystem' | 'process' | 'git' | 'mcp' | 'browser' | (string & {});
  readonly label: string;
  readonly description?: string;
  readonly status?: string;
  readonly mutation?: boolean;
  readonly content: ReactNode;
}

export function AgentRuntimeTimeline(props: {
  events: readonly AgentLifecycleEvent[];
  onDecision?: (resolution: AgentDecisionResolution) => void;
  onPermission?: (resolution: RuntimePermissionResolution) => void;
  emptyLabel?: string;
}) {
  const items = useMemo(() => presentAgentLifecycle(props.events), [props.events]);
  const resolvedDecisions = useMemo(() => new Set(
    props.events
      .filter((event) => event.type === 'decision.resolved')
      .map((event) => event.resolution.requestId)
  ), [props.events]);
  const resolvedPermissions = useMemo(() => new Set(
    props.events
      .filter((event) => event.type === 'permission.resolved')
      .map((event) => event.callId)
  ), [props.events]);

  if (items.length === 0) {
    return <section className="assistant-stream-state" aria-label="Agent activity">
      <div className="assistant-stream-title"><Sparkles size={14} aria-hidden="true" /><strong>Activity</strong></div>
      <p>{props.emptyLabel ?? 'No runtime activity yet.'}</p>
    </section>;
  }

  return <section className="assistant-stream-state" aria-label="Agent activity">
    <div className="assistant-stream-title">
      <Sparkles size={14} aria-hidden="true" />
      <strong>Activity</strong>
    </div>
    <div className="progress-list" role="list" aria-live="polite" aria-relevant="additions text">
      {items.map((item) => <RuntimeActivityRow
        key={item.id}
        item={item}
        decisionOpen={Boolean(item.decisionRequest && !resolvedDecisions.has(item.decisionRequest.id))}
        permissionOpen={Boolean(item.kind === 'permission' && item.state === 'waiting' && item.call && !resolvedPermissions.has(item.call.id))}
        onDecision={props.onDecision}
        onPermission={props.onPermission}
      />)}
    </div>
  </section>;
}

function RuntimeActivityRow(props: {
  item: RuntimeActivityItem;
  decisionOpen: boolean;
  permissionOpen: boolean;
  onDecision?: (resolution: AgentDecisionResolution) => void;
  onPermission?: (resolution: RuntimePermissionResolution) => void;
}) {
  const { item } = props;
  const active = item.state === 'running' || item.state === 'progress' || item.state === 'waiting';
  const metadata = activityMetadata(item);

  return <div className="progress-row" role="listitem" data-runtime-kind={item.kind} data-runtime-state={item.state}>
    <span className={`progress-index${active ? ' active' : ''}`} aria-hidden="true">
      <RuntimeIcon kind={item.kind} active={active} failed={item.state === 'error'} />
    </span>
    <div>
      <strong>{item.title}</strong>
      {item.detail ? <small>{item.detail}</small> : null}
      {item.provider?.connectionId || item.provider?.modelId ? <div className="assistant-stream-meta">
        {item.provider.connectionId ? <span>Connection {item.provider.connectionId}</span> : null}
        {item.provider.modelId ? <span>Model {item.provider.modelId}</span> : null}
      </div> : null}
      {item.progress ? <RuntimeProgress item={item} /> : null}
      {item.mutationStatus && item.mutationStatus !== 'not-applicable' ? <div className="result-chip-row">
        <span>Mutation {item.mutationStatus}</span>
      </div> : null}
      {item.attachments?.length ? <RuntimeAttachments attachments={item.attachments} /> : null}
      {props.permissionOpen && item.call ? <RuntimePermissionCard
        callId={item.call.id}
        toolName={item.call.name}
        permissions={item.permissions ?? []}
        onResolve={props.onPermission}
      /> : null}
      {props.decisionOpen && item.decisionRequest ? <RuntimeDecisionCard
        request={item.decisionRequest}
        onResolve={props.onDecision}
      /> : null}
      {metadata ? <details className="assistant-details">
        <summary>Details</summary>
        <pre>{metadata}</pre>
      </details> : null}
    </div>
  </div>;
}

function RuntimeProgress({ item }: { item: RuntimeActivityItem }) {
  const progress = item.progress!;
  const label = progress.message || item.title;
  if (progress.completed === undefined || progress.total === undefined || progress.total <= 0) {
    return <div className="assistant-stream-meta"><span role="status">{label}</span></div>;
  }
  return <div className="assistant-stream-meta">
    <span>{progress.completed} / {progress.total}</span>
    <progress
      aria-label={label}
      value={progress.completed}
      max={progress.total}
    >{progress.percent}%</progress>
  </div>;
}

function RuntimeIcon({ kind, active, failed }: { kind: RuntimeActivityKind; active: boolean; failed: boolean }) {
  const props = { size: 11, strokeWidth: 1.8 } as const;
  if (active) return <LoaderCircle {...props} />;
  if (failed) return <X {...props} />;
  if (kind === 'cancelled') return <CircleStop {...props} />;
  if (kind === 'paused') return <Square {...props} />;
  if (kind === 'read' || kind === 'attachment') return <FileText {...props} />;
  if (kind === 'mutation') return <Pencil {...props} />;
  if (kind === 'command' || kind === 'validation' || kind === 'tool') return <Code {...props} />;
  if (kind === 'decision' || kind === 'permission') return <ChevronDown {...props} />;
  return <Check {...props} />;
}

function activityMetadata(item: RuntimeActivityItem): string | undefined {
  const details: Record<string, unknown> = {};
  if (item.call?.name) details.tool = item.call.name;
  if (item.call && Object.keys(item.call.arguments).length) details.arguments = item.call.arguments;
  if (item.permissions?.length) details.permissions = item.permissions;
  if (item.metadata && Object.keys(item.metadata).length) details.metadata = item.metadata;
  if (item.decisionResolution) details.resolution = item.decisionResolution;
  return Object.keys(details).length ? formatRuntimeMetadata(details, 1200) : undefined;
}

export function RuntimeDecisionCard(props: {
  request: AgentDecisionRequest;
  onResolve?: (resolution: AgentDecisionResolution) => void;
}) {
  const [text, setText] = useState('');
  const options = props.request.options ?? [];
  const inputId = `runtime-decision-${props.request.id}`;

  function resolveOption(optionId: string) {
    props.onResolve?.({ requestId: props.request.id, optionId });
  }

  function resolveText() {
    const value = text.trim();
    if (!value) return;
    props.onResolve?.({ requestId: props.request.id, text: value });
    setText('');
  }

  return <section className="inline-decision" aria-labelledby={`${inputId}-prompt`} data-runtime-decision-kind={props.request.kind}>
    <strong id={`${inputId}-prompt`}>{props.request.prompt}</strong>
    {options.length ? <div className="inline-choice-list" role="group" aria-label="Decision options">
      {options.map((option) => <button key={option.id} type="button" onClick={() => resolveOption(option.id)}>
        <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>
        <small>Choose</small>
      </button>)}
    </div> : null}
    <label htmlFor={inputId}>Or answer directly</label>
    <textarea
      id={inputId}
      className="inline-guidance-input"
      value={text}
      rows={2}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          resolveText();
        }
      }}
    />
    <button type="button" className="lc-agent-secondary-action" disabled={!text.trim()} onClick={resolveText}>Send response</button>
  </section>;
}

export function RuntimePermissionCard(props: {
  callId: string;
  toolName: string;
  permissions: readonly string[];
  onResolve?: (resolution: RuntimePermissionResolution) => void;
}) {
  return <section className="inline-decision" aria-label={`Approval for ${props.toolName || 'tool call'}`}>
    <strong>Allow this action?</strong>
    <p>{props.toolName || 'The runtime'} requested additional permission before continuing.</p>
    {props.permissions.length ? <div className="result-chip-row" aria-label="Requested permissions">
      {props.permissions.map((permission) => <span key={permission}>{permission}</span>)}
    </div> : null}
    <div className="inline-choice-list" role="group" aria-label="Approval actions">
      <button type="button" onClick={() => props.onResolve?.({ callId: props.callId, allowed: true })}>
        <span>Allow</span><Check size={13} aria-hidden="true" />
      </button>
      <button type="button" data-action="deny" onClick={() => props.onResolve?.({ callId: props.callId, allowed: false })}>
        <span>Deny</span><X size={13} aria-hidden="true" />
      </button>
    </div>
  </section>;
}

export function RuntimeAttachments({ attachments }: {
  attachments: readonly {
    id: string;
    kind: string;
    name?: string;
    mediaType?: string;
    sizeBytes?: number;
    ref: string;
  }[];
}) {
  return <div className="result-chip-row" aria-label="Attachments">
    {attachments.map((attachment) => {
      const size = formatAttachmentSize(attachment.sizeBytes);
      const metadata = [attachment.kind, attachment.mediaType, size].filter(Boolean).join(' · ');
      return <span key={attachment.id} title={attachment.ref}>
        {attachment.name || attachment.ref}{metadata ? ` · ${metadata}` : ''}
      </span>;
    })}
  </div>;
}

export function RuntimeEvidenceDock(props: {
  panes: readonly RuntimeEvidencePane[];
  activePaneId?: string;
  onActivePaneChange?: (paneId: string) => void;
  emptyLabel?: string;
}) {
  const firstId = props.panes[0]?.id;
  const [internalActive, setInternalActive] = useState(firstId);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeId = props.activePaneId ?? internalActive ?? firstId;
  const active = props.panes.find((pane) => pane.id === activeId) ?? props.panes[0];

  function choose(id: string) {
    if (props.activePaneId === undefined) setInternalActive(id);
    props.onActivePaneChange?.(id);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, position: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const count = props.panes.length;
    if (!count) return;
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? count - 1
      : event.key === 'ArrowLeft' ? (position - 1 + count) % count
      : (position + 1) % count;
    const pane = props.panes[next];
    if (!pane) return;
    choose(pane.id);
    tabRefs.current[next]?.focus();
  }

  if (!active) {
    return <section className="progress-panel" aria-label="Runtime evidence">
      <div className="context-list"><span>{props.emptyLabel ?? 'No runtime evidence yet.'}</span></div>
    </section>;
  }

  return <section className="progress-panel" aria-label="Runtime evidence">
    <div className="inline-choice-list" role="tablist" aria-label="Runtime panes">
      {props.panes.map((pane, position) => <button
        key={pane.id}
        ref={(node) => { tabRefs.current[position] = node; }}
        type="button"
        role="tab"
        id={`runtime-pane-tab-${pane.id}`}
        aria-selected={pane.id === active.id}
        aria-controls={`runtime-pane-${pane.id}`}
        tabIndex={pane.id === active.id ? 0 : -1}
        className={pane.id === active.id ? 'selected' : undefined}
        onClick={() => choose(pane.id)}
        onKeyDown={(event) => onTabKeyDown(event, position)}
      >
        <span>{pane.label}</span>
        {pane.mutation ? <Pencil size={12} aria-label="May mutate" /> : pane.id === 'git' ? <FolderGit2 size={12} aria-hidden="true" /> : null}
      </button>)}
    </div>
    <div
      id={`runtime-pane-${active.id}`}
      role="tabpanel"
      aria-labelledby={`runtime-pane-tab-${active.id}`}
      className="context-list"
      tabIndex={0}
    >
      {active.description ? <span>{active.description}</span> : null}
      {active.status ? <strong>{active.status}</strong> : null}
      {active.content}
    </div>
  </section>;
}
