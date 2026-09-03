import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Link2, Plus, RefreshCw, Search, ShieldCheck, Trash2, Wrench } from 'lucide-react';

import type {
  ClaudeAccountStatusView,
  CodexAccountStatusView,
  McpConnectorView,
  ProviderConnectionView
} from './native.js';
import { ShellDialog, type ShellDialogRequest } from './ShellDialog.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

type AccountKind = 'claude' | 'chatgpt';
type ConnectorFilter = 'all' | 'connected' | 'not-connected';

interface AccountConnector extends McpConnectorView {
  key: string;
  connectionId: string;
  profileId: string;
  accountKind: AccountKind;
  accountLabel: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function connectorStatusLabel(status: McpConnectorView['status']): string {
  if (status === 'connected') return 'Connected';
  if (status === 'needs-auth') return 'Needs authentication';
  if (status === 'error') return 'Unavailable';
  if (status === 'disabled') return 'Disabled';
  return 'Unknown';
}

function connectorTypeLabel(connector: McpConnectorView): string {
  if (connector.managed) return 'Provider';
  if (connector.transport === 'http') return 'Remote MCP';
  if (connector.transport === 'stdio') return 'Local MCP';
  return connector.transport === 'unknown' ? 'MCP' : connector.transport.toUpperCase();
}

export function ConnectionConnectorsPanel() {
  const bridge = window.lc;
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [claudeStatuses, setClaudeStatuses] = useState<Record<string, ClaudeAccountStatusView>>({});
  const [codexStatuses, setCodexStatuses] = useState<Record<string, CodexAccountStatusView>>({});
  const [connectors, setConnectors] = useState<AccountConnector[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ConnectorFilter>('all');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dialog, setDialog] = useState<ShellDialogRequest>();
  const [adding, setAdding] = useState(false);
  const [mcpConnectionId, setMcpConnectionId] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');

  function authenticated(
    connection: ProviderConnectionView,
    claude = claudeStatuses,
    codex = codexStatuses
  ): boolean {
    if (!connection.accountProfileId) return false;
    if (connection.auth === 'claude-account') return claude[connection.accountProfileId]?.authenticated === true;
    if (connection.auth === 'chatgpt-account') return codex[connection.accountProfileId]?.authenticated === true;
    return false;
  }

  async function discover(
    sourceConnections: ProviderConnectionView[],
    claude: Record<string, ClaudeAccountStatusView>,
    codex: Record<string, CodexAccountStatusView>,
    refresh = false
  ) {
    if (!bridge) return;
    const eligible = sourceConnections.filter((connection) =>
      Boolean(connection.accountProfileId) &&
      (connection.auth === 'claude-account' || connection.auth === 'chatgpt-account') &&
      authenticated(connection, claude, codex)
    );
    setLoading(true);
    try {
      const discoveries = await Promise.allSettled(eligible.map(async (connection) => {
        const profileId = connection.accountProfileId!;
        const accountKind: AccountKind = connection.auth === 'claude-account' ? 'claude' : 'chatgpt';
        const result = accountKind === 'claude'
          ? await bridge.listClaudeAccountMcps(profileId, refresh)
          : await bridge.listCodexAccountMcps(profileId, refresh);
        return result.connectors.map((connector): AccountConnector => ({
          ...connector,
          key: `${connection.id}:${connector.name}`,
          connectionId: connection.id,
          profileId,
          accountKind,
          accountLabel: connection.label
        }));
      }));
      setConnectors(discoveries.flatMap((result) => result.status === 'fulfilled' ? result.value : []));
      const failures = discoveries.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        setNotice(`Could not refresh connectors for ${failures.length} account${failures.length === 1 ? '' : 's'}.`);
      }
    } finally {
      setLoading(false);
    }
  }

  async function load() {
    if (!bridge) return;
    setBusy('refresh');
    setNotice(undefined);
    try {
      const [nextConnections, claudeProfiles, codexProfiles] = await Promise.all([
        bridge.providerConnections(),
        bridge.claudeAccounts(),
        bridge.codexAccounts()
      ]);
      setConnections(nextConnections);
      const [claudeEntries, codexEntries] = await Promise.all([
        Promise.all(claudeProfiles.map(async (profile) => [profile.id, await bridge.claudeAccountStatus(profile.id)] as const)),
        Promise.all(codexProfiles.map(async (profile) => [profile.id, await bridge.codexAccountStatus(profile.id)] as const))
      ]);
      const nextClaude = Object.fromEntries(claudeEntries);
      const nextCodex = Object.fromEntries(codexEntries);
      setClaudeStatuses(nextClaude);
      setCodexStatuses(nextCodex);
      await discover(nextConnections, nextClaude, nextCodex, false);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => { void load(); }, []);

  const accountConnections = useMemo(() => connections.filter((connection) =>
    connection.auth === 'claude-account' || connection.auth === 'chatgpt-account'
  ), [connections]);

  const accountOptions = useMemo<UiSelectOption[]>(() => accountConnections
    .filter((connection) => authenticated(connection))
    .map((connection) => ({
      value: connection.id,
      label: connection.label,
      description: `${connection.companyName ?? connection.organizationLabel ?? connection.organizationId ?? 'Personal'} · ${connection.auth === 'claude-account' ? 'Claude' : 'ChatGPT'}`
    })), [accountConnections, claudeStatuses, codexStatuses]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return connectors.filter((connector) => {
      if (filter === 'connected' && connector.status !== 'connected') return false;
      if (filter === 'not-connected' && connector.status === 'connected') return false;
      return !query || [connector.name, connector.accountLabel, connector.target, connector.detail]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [connectors, filter, search]);

  const attention = useMemo(() => connectors.filter((connector) =>
    connector.status === 'needs-auth' || connector.status === 'error'
  ).slice(0, 3), [connectors]);

  function openAdd() {
    setMcpConnectionId((current) => current || accountOptions[0]?.value || '');
    setAdding(true);
  }

  async function addMcp(event: FormEvent) {
    event.preventDefault();
    const connection = accountConnections.find((candidate) => candidate.id === mcpConnectionId);
    if (!bridge || !connection?.accountProfileId || !mcpName.trim() || !mcpUrl.trim()) return;
    setBusy('mcp-add');
    setNotice(undefined);
    try {
      const input = { profileId: connection.accountProfileId, name: mcpName.trim(), url: mcpUrl.trim() };
      if (connection.auth === 'claude-account') await bridge.addClaudeAccountMcp(input);
      else await bridge.addCodexAccountMcp(input);
      setAdding(false);
      setMcpName('');
      setMcpUrl('');
      await discover(connections, claudeStatuses, codexStatuses, true);
      setNotice('Remote MCP connector added to the selected account.');
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function authenticate(connector: AccountConnector) {
    if (!bridge) return;
    setBusy(`mcp-login:${connector.key}`);
    setNotice('Complete the connector authentication in the provider-owned flow.');
    try {
      if (connector.accountKind === 'claude') await bridge.loginClaudeAccountMcp(connector.profileId, connector.name);
      else await bridge.loginCodexAccountMcp(connector.profileId, connector.name);
      await discover(connections, claudeStatuses, codexStatuses, true);
      setNotice(`${connector.name} is connected.`);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(connector: AccountConnector) {
    if (!bridge || !connector.removable) return;
    setBusy(`mcp-remove:${connector.key}`);
    setNotice(undefined);
    try {
      if (connector.accountKind === 'claude') await bridge.removeClaudeAccountMcp(connector.profileId, connector.name);
      else await bridge.removeCodexAccountMcp(connector.profileId, connector.name);
      await discover(connections, claudeStatuses, codexStatuses, true);
      setNotice(`${connector.name} was removed.`);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  }

  function requestRemove(connector: AccountConnector) {
    if (!connector.removable) return;
    setDialog({
      kind: 'confirm',
      title: 'Remove connector',
      message: `“${connector.name}” will be removed from ${connector.accountLabel}. Provider-managed connectors are not changed.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => void remove(connector)
    });
  }

  if (!bridge) return <div className="settings-empty-state">Open the standalone desktop app to manage connectors.</div>;

  return <section className="connector-browser connection-center-connectors" aria-label="MCP connectors">
    {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}
    <div className="connector-toolbar">
      <label className="connector-search"><Search size={14} /><input aria-label="Search connectors" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search connectors" /></label>
      <button type="button" className={`btn-secondary connector-refresh ${loading ? 'loading' : ''}`} disabled={loading || busy !== undefined} onClick={() => void discover(connections, claudeStatuses, codexStatuses, true)}><RefreshCw size={13} />Refresh</button>
      <button type="button" className="settings-save-button" disabled={accountOptions.length === 0} onClick={openAdd}><Plus size={14} />Add MCP</button>
    </div>

    {attention.length > 0 ? <div className="connector-attention-section"><h2>Available to connect</h2><div className="connector-attention-grid">{attention.map((connector) => <article key={`attention:${connector.key}`}><span className="connector-logo"><Wrench size={15} /></span><div><strong>{connector.name}</strong><small>{connector.accountLabel}</small></div>{connector.status === 'needs-auth' ? <button type="button" disabled={busy !== undefined} onClick={() => void authenticate(connector)}>Connect</button> : <button type="button" disabled={loading || busy !== undefined} onClick={() => void discover(connections, claudeStatuses, codexStatuses, true)}>Retry</button>}</article>)}</div></div> : null}

    <div className="connector-filter-tabs" role="tablist" aria-label="Filter connectors">{([['all', 'All'], ['connected', 'Connected'], ['not-connected', 'Not connected']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>

    <div className="connector-table" aria-busy={loading}>
      <div className="connector-table-head"><span>Connector</span><span>Account</span><span>Type</span><span>Status</span></div>
      {filtered.map((connector) => <article className="connector-row" key={connector.key}>
        <div className="connector-identity"><span className="connector-logo"><Wrench size={15} /></span><span><strong>{connector.name}</strong><small title={connector.target}>{connector.target ?? connector.detail ?? 'Configured by provider'}</small></span></div>
        <span className="connector-account">{connector.accountLabel}</span>
        <span className="connector-kind">{connectorTypeLabel(connector)}</span>
        <div className={`connector-status ${connector.status}`}><span>{connector.status === 'connected' ? <Check size={14} /> : connector.status === 'error' ? <AlertTriangle size={14} /> : connectorStatusLabel(connector.status)}</span>{connector.status === 'needs-auth' ? <button type="button" disabled={busy !== undefined} onClick={() => void authenticate(connector)}>Connect</button> : null}{connector.status === 'error' ? <button type="button" disabled={loading || busy !== undefined} onClick={() => void discover(connections, claudeStatuses, codexStatuses, true)}>Retry</button> : null}{connector.removable ? <button type="button" className="connector-remove" aria-label={`Remove ${connector.name}`} title="Remove connector" disabled={busy !== undefined} onClick={() => requestRemove(connector)}><Trash2 size={13} /></button> : null}</div>
      </article>)}
      {filtered.length === 0 ? <div className="settings-empty-state connector-empty-state">{loading ? 'Discovering connectors…' : accountOptions.length === 0 ? 'Sign in to an Account connection to discover its connectors.' : search ? 'No connectors match your search.' : 'No connectors found. Add a remote MCP to get started.'}</div> : null}
    </div>

    <aside className="connection-note"><ShieldCheck size={16} /><p><strong>Company-owned account tools</strong><span>Connector discovery and authentication stay scoped to the selected Account connection. Provider-managed connectors remain read-only.</span></p></aside>

    {adding ? <div className="nested-settings-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setAdding(false); }}><form className="nested-settings-dialog connection-create-dialog connector-create-dialog" onSubmit={(event) => void addMcp(event)}><header><div><h2>Add custom connector</h2><p>Connect one authenticated Account connection to a trusted remote MCP server.</p></div></header><label><span>Account</span><UiSelect ariaLabel="Connector account" value={mcpConnectionId} options={accountOptions} onChange={setMcpConnectionId} /></label><label><span>Name</span><input required autoFocus value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="sentry" spellCheck={false} pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" /></label><label><span>Remote MCP server URL</span><input required type="url" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} /></label><p className="connector-security-copy">Only HTTPS endpoints without embedded credentials or query parameters are accepted. Provider-managed connectors cannot be removed from Axis.</p><div className="nested-settings-dialog-actions"><button type="button" onClick={() => setAdding(false)}>Cancel</button><button className="settings-save-button" disabled={busy === 'mcp-add' || !mcpConnectionId}>{busy === 'mcp-add' ? 'Adding…' : 'Add connector'}</button></div></form></div> : null}
    <ShellDialog request={dialog} onClose={() => setDialog(undefined)} />
  </section>;
}
