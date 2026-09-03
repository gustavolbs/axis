import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, CheckCircle2, Cloud, KeyRound, Laptop, Link2, Plus, RefreshCw, Search, Server, ShieldCheck, Trash2, UserRound, Wrench } from 'lucide-react';

import type { ClaudeAccountStatusView, ClaudeRuntimeDiscoveryView, CodexAccountStatusView, CodexRuntimeDiscoveryView, McpConnectorView, ProviderConnectionView } from './native.js';
import { ShellDialog, type ShellDialogRequest } from './ShellDialog.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AccountKind = 'claude' | 'chatgpt';
type ConnectionsSurface = 'connectors' | 'accounts';
type ConnectorFilter = 'all' | 'connected' | 'not-connected';

interface AccountConnector extends McpConnectorView {
  key: string;
  connectionId: string;
  profileId: string;
  accountKind: AccountKind;
  accountLabel: string;
}

const accountOptions: UiSelectOption[] = [
  { value: 'claude', label: 'Claude account', description: 'Claude Personal, Team or Enterprise via Claude Code' },
  { value: 'chatgpt', label: 'ChatGPT account', description: 'ChatGPT account via the official Codex runtime' }
];

function connectionDescription(connection: ProviderConnectionView): string {
  const family = connection.providerFamily === 'openai' ? 'OpenAI' : connection.providerFamily === 'anthropic' ? 'Anthropic' : 'Ollama';
  if (connection.auth === 'api-key') return `${family} API · ${connection.organizationId ?? 'personal'} · metered`;
  if (connection.auth === 'claude-account') return `Claude account · ${connection.organizationLabel ?? 'personal'} · subscription`;
  if (connection.auth === 'chatgpt-account') return `ChatGPT account · ${connection.organizationLabel ?? 'personal'} · subscription`;
  return 'Local runtime · no cloud credential';
}

function connectionType(connection: ProviderConnectionView): string {
  if (connection.auth === 'api-key') return 'API key';
  if (connection.auth === 'claude-account') return 'Claude account';
  if (connection.auth === 'chatgpt-account') return 'ChatGPT account';
  return 'Local';
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

export function ConnectionsSettings() {
  const bridge = window.lc;
  const [surface, setSurface] = useState<ConnectionsSurface>('connectors');
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [claudeRuntime, setClaudeRuntime] = useState<ClaudeRuntimeDiscoveryView>();
  const [codexRuntime, setCodexRuntime] = useState<CodexRuntimeDiscoveryView>();
  const [claudeStatuses, setClaudeStatuses] = useState<Record<string, ClaudeAccountStatusView>>({});
  const [codexStatuses, setCodexStatuses] = useState<Record<string, CodexAccountStatusView>>({});
  const [connectors, setConnectors] = useState<AccountConnector[]>([]);
  const [connectorSearch, setConnectorSearch] = useState('');
  const [connectorFilter, setConnectorFilter] = useState<ConnectorFilter>('all');
  const [connectorLoading, setConnectorLoading] = useState(false);
  const [dialog, setDialog] = useState<ShellDialogRequest>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [addingMcp, setAddingMcp] = useState(false);
  const [accountKind, setAccountKind] = useState<AccountKind>('claude');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [organizationLabel, setOrganizationLabel] = useState('');
  const [mcpConnectionId, setMcpConnectionId] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');

  function authenticated(connection: ProviderConnectionView, claude = claudeStatuses, codex = codexStatuses): boolean {
    if (!connection.accountProfileId) return connection.available;
    if (connection.auth === 'claude-account') return claude[connection.accountProfileId]?.authenticated === true;
    if (connection.auth === 'chatgpt-account') return codex[connection.accountProfileId]?.authenticated === true;
    return connection.available;
  }

  async function discoverConnectors(sourceConnections: ProviderConnectionView[], claude: Record<string, ClaudeAccountStatusView>, codex: Record<string, CodexAccountStatusView>, refresh = false) {
    if (!bridge) return;
    const eligible = sourceConnections.filter((connection) => Boolean(connection.accountProfileId) && (connection.auth === 'claude-account' || connection.auth === 'chatgpt-account') && authenticated(connection, claude, codex));
    setConnectorLoading(true);
    try {
      const discoveries = await Promise.allSettled(eligible.map(async (connection) => {
        const profileId = connection.accountProfileId!;
        const accountKind: AccountKind = connection.auth === 'claude-account' ? 'claude' : 'chatgpt';
        const result = accountKind === 'claude' ? await bridge.listClaudeAccountMcps(profileId, refresh) : await bridge.listCodexAccountMcps(profileId, refresh);
        return result.connectors.map((connector): AccountConnector => ({ ...connector, key: `${connection.id}:${connector.name}`, connectionId: connection.id, profileId, accountKind, accountLabel: connection.label }));
      }));
      setConnectors(discoveries.flatMap((result) => result.status === 'fulfilled' ? result.value : []));
      const failures = discoveries.filter((result) => result.status === 'rejected');
      if (failures.length > 0) setNotice(`Could not refresh connectors for ${failures.length} account${failures.length === 1 ? '' : 's'}.`);
    } finally {
      setConnectorLoading(false);
    }
  }

  async function load() {
    if (!bridge) return;
    setBusy('refresh');
    setNotice(undefined);
    try {
      const [nextConnections, nextClaudeRuntime, nextCodexRuntime, nextClaudeProfiles, nextCodexProfiles] = await Promise.all([bridge.providerConnections(), bridge.claudeDiscover(), bridge.codexDiscover(), bridge.claudeAccounts(), bridge.codexAccounts()]);
      setConnections(nextConnections); setClaudeRuntime(nextClaudeRuntime); setCodexRuntime(nextCodexRuntime);
      const [claude, codex] = await Promise.all([
        Promise.all(nextClaudeProfiles.map(async (profile) => [profile.id, await bridge.claudeAccountStatus(profile.id)] as const)),
        Promise.all(nextCodexProfiles.map(async (profile) => [profile.id, await bridge.codexAccountStatus(profile.id)] as const))
      ]);
      const nextClaudeStatuses = Object.fromEntries(claude);
      const nextCodexStatuses = Object.fromEntries(codex);
      setClaudeStatuses(nextClaudeStatuses); setCodexStatuses(nextCodexStatuses);
      await discoverConnectors(nextConnections, nextClaudeStatuses, nextCodexStatuses, false);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => { void load(); }, []);

  const accountConnections = useMemo(() => connections.filter((connection) => connection.auth === 'claude-account' || connection.auth === 'chatgpt-account'), [connections]);
  const apiConnections = useMemo(() => connections.filter((connection) => connection.auth === 'api-key'), [connections]);
  const localConnections = useMemo(() => connections.filter((connection) => connection.auth === 'local'), [connections]);
  const connectorAccountOptions = useMemo<UiSelectOption[]>(() => accountConnections.filter((connection) => authenticated(connection)).map((connection) => ({ value: connection.id, label: connection.label, description: connection.auth === 'claude-account' ? 'Claude account' : 'ChatGPT account' })), [accountConnections, claudeStatuses, codexStatuses]);
  const filteredConnectors = useMemo(() => {
    const query = connectorSearch.trim().toLowerCase();
    return connectors.filter((connector) => {
      if (connectorFilter === 'connected' && connector.status !== 'connected') return false;
      if (connectorFilter === 'not-connected' && connector.status === 'connected') return false;
      return !query || [connector.name, connector.accountLabel, connector.target, connector.detail].some((value) => value?.toLowerCase().includes(query));
    });
  }, [connectorFilter, connectorSearch, connectors]);
  const attentionConnectors = useMemo(() => connectors.filter((connector) => connector.status === 'needs-auth' || connector.status === 'error').slice(0, 3), [connectors]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !id.trim() || !name.trim()) return;
    setBusy('create'); setNotice(undefined);
    try {
      const input = { id: id.trim(), name: name.trim(), organizationLabel: organizationLabel.trim() || undefined };
      if (accountKind === 'claude') await bridge.createClaudeAccount(input); else await bridge.createCodexAccount(input);
      setId(''); setName(''); setOrganizationLabel(''); setAdding(false);
      await load(); setNotice('Connection profile created. Sign in to activate it.');
    } catch (error) { setNotice(message(error)); } finally { setBusy(undefined); }
  }

  async function login(connection: ProviderConnectionView, alternate = false) {
    if (!bridge?.isElectron || !connection.accountProfileId) return;
    setBusy(`login:${connection.id}`); setNotice('Complete the provider-owned sign-in flow. Local Coder does not receive or copy the OAuth credential.');
    try {
      if (connection.auth === 'claude-account') {
        const status = await bridge.loginClaudeAccount(connection.accountProfileId, alternate);
        setClaudeStatuses((current) => ({ ...current, [connection.accountProfileId!]: status }));
      } else if (connection.auth === 'chatgpt-account') {
        const status = await bridge.loginCodexAccount(connection.accountProfileId, alternate);
        setCodexStatuses((current) => ({ ...current, [connection.accountProfileId!]: status }));
      }
      await load(); setNotice('Account connection is ready. It is now available as a distinct Chat connection.');
    } catch (error) { setNotice(message(error)); } finally { setBusy(undefined); }
  }

  async function refreshAccount(connection: ProviderConnectionView) {
    if (!bridge || !connection.accountProfileId) return;
    setBusy(`status:${connection.id}`);
    try {
      if (connection.auth === 'claude-account') {
        const status = await bridge.claudeAccountStatus(connection.accountProfileId);
        setClaudeStatuses((current) => ({ ...current, [connection.accountProfileId!]: status }));
      } else if (connection.auth === 'chatgpt-account') {
        const status = await bridge.codexAccountStatus(connection.accountProfileId);
        setCodexStatuses((current) => ({ ...current, [connection.accountProfileId!]: status }));
      }
    } catch (error) { setNotice(message(error)); } finally { setBusy(undefined); }
  }

  function accountDetail(connection: ProviderConnectionView): string {
    if (!connection.accountProfileId) return connectionDescription(connection);
    if (connection.auth === 'claude-account') {
      const status = claudeStatuses[connection.accountProfileId];
      return [status?.email, status?.organization, status?.subscriptionType].filter(Boolean).join(' · ') || connectionDescription(connection);
    }
    return codexStatuses[connection.accountProfileId]?.detail || connectionDescription(connection);
  }

  function openMcpDialog() {
    setMcpConnectionId((current) => current || connectorAccountOptions[0]?.value || '');
    setAddingMcp(true);
  }

  async function addMcp(event: FormEvent) {
    event.preventDefault();
    const connection = accountConnections.find((candidate) => candidate.id === mcpConnectionId);
    if (!bridge || !connection?.accountProfileId || !mcpName.trim() || !mcpUrl.trim()) return;
    setBusy('mcp-add'); setNotice(undefined);
    try {
      const input = { profileId: connection.accountProfileId, name: mcpName.trim(), url: mcpUrl.trim() };
      if (connection.auth === 'claude-account') await bridge.addClaudeAccountMcp(input); else await bridge.addCodexAccountMcp(input);
      setAddingMcp(false); setMcpName(''); setMcpUrl('');
      await discoverConnectors(connections, claudeStatuses, codexStatuses, true);
      setNotice('Remote MCP connector added to the selected account.');
    } catch (error) { setNotice(message(error)); } finally { setBusy(undefined); }
  }

  async function authenticateConnector(connector: AccountConnector) {
    if (!bridge) return;
    setBusy(`mcp-login:${connector.key}`); setNotice('Complete the connector authentication in the provider-owned flow.');
    try {
      if (connector.accountKind === 'claude') await bridge.loginClaudeAccountMcp(connector.profileId, connector.name); else await bridge.loginCodexAccountMcp(connector.profileId, connector.name);
      await discoverConnectors(connections, claudeStatuses, codexStatuses, true); setNotice(`${connector.name} is connected.`);
    } catch (error) { setNotice(message(error)); } finally { setBusy(undefined); }
  }

  function requestRemoveConnector(connector: AccountConnector) {
    if (!connector.removable) return;
    setDialog({
      kind: 'confirm',
      title: 'Remove connector',
      message: `“${connector.name}” will be removed from ${connector.accountLabel}. Provider-managed connectors are not changed.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => void removeConnector(connector)
    });
  }

  async function removeConnector(connector: AccountConnector) {
    if (!bridge || !connector.removable) return;
    setBusy(`mcp-remove:${connector.key}`); setNotice(undefined);
    try {
      if (connector.accountKind === 'claude') await bridge.removeClaudeAccountMcp(connector.profileId, connector.name); else await bridge.removeCodexAccountMcp(connector.profileId, connector.name);
      await discoverConnectors(connections, claudeStatuses, codexStatuses, true); setNotice(`${connector.name} was removed.`);
    } catch (error) { setNotice(message(error)); } finally { setBusy(undefined); }
  }

  if (!bridge) return <div className="focused-settings-page"><h1>Connections</h1><div className="settings-empty-state">Open the standalone desktop app to manage provider identities.</div></div>;

  const renderConnection = (connection: ProviderConnectionView) => {
    const ready = authenticated(connection);
    const account = connection.auth === 'claude-account' || connection.auth === 'chatgpt-account';
    const runtimeReady = connection.auth === 'claude-account' ? claudeRuntime?.usable : connection.auth === 'chatgpt-account' ? codexRuntime?.usable : true;
    return <article className="connection-card" key={connection.id}><div className="connection-card-main">
      <span className="connection-icon">{connection.auth === 'local' ? <Laptop size={16} /> : connection.auth === 'api-key' ? <KeyRound size={16} /> : <UserRound size={16} />}</span>
      <div className="connection-copy"><div className="connection-title-row"><strong>{connection.label}</strong><span>{connectionType(connection)}</span></div><small>{accountDetail(connection)}</small><span className={`connection-state ${ready ? 'ready' : ''}`}>{ready ? <CheckCircle2 size={12} /> : null}{ready ? 'Ready' : connection.reason ?? 'Sign in required'}</span></div>
      <div className="connection-actions">{account ? <><button type="button" className="btn-secondary connection-refresh" disabled={busy !== undefined} onClick={() => void refreshAccount(connection)}><RefreshCw size={13} />Refresh</button>{!ready ? <button type="button" className="btn-primary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection)}>Sign in</button> : null}{!ready && connection.auth === 'claude-account' ? <button type="button" className="btn-secondary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection, true)}>Enterprise SSO</button> : null}{!ready && connection.auth === 'chatgpt-account' ? <button type="button" className="btn-secondary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection, true)}>Device login</button> : null}</> : null}</div>
    </div></article>;
  };

  return <div className="focused-settings-page connections-settings-page">
    <header><div><h1>Connections</h1><p>Manage provider identities and the MCP tools connected to each account.</p></div>{surface === 'accounts' ? <button type="button" className="settings-save-button" onClick={() => setAdding(true)}><Plus size={14} />Add account</button> : null}</header>
    <nav className="connections-surface-tabs" aria-label="Connection settings"><button type="button" className={surface === 'connectors' ? 'active' : ''} onClick={() => setSurface('connectors')}><Link2 size={14} />Connectors</button><button type="button" className={surface === 'accounts' ? 'active' : ''} onClick={() => setSurface('accounts')}><UserRound size={14} />Accounts</button></nav>
    {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}

    {surface === 'connectors' ? <>
      <section className="connector-browser">
        <div className="connector-toolbar"><label className="connector-search"><Search size={14} /><input aria-label="Search connectors" value={connectorSearch} onChange={(event) => setConnectorSearch(event.target.value)} placeholder="Search connectors" /></label><button type="button" className={`btn-secondary connector-refresh ${connectorLoading ? 'loading' : ''}`} disabled={connectorLoading || busy !== undefined} onClick={() => void discoverConnectors(connections, claudeStatuses, codexStatuses, true)}><RefreshCw size={13} />Refresh</button><button type="button" className="settings-save-button" disabled={connectorAccountOptions.length === 0} onClick={openMcpDialog}><Plus size={14} />Add MCP</button></div>
        {attentionConnectors.length > 0 ? <div className="connector-attention-section"><h2>Available to connect</h2><div className="connector-attention-grid">{attentionConnectors.map((connector) => <article key={`attention:${connector.key}`}><span className="connector-logo"><Wrench size={15} /></span><div><strong>{connector.name}</strong><small>{connector.accountLabel}</small></div>{connector.status === 'needs-auth' ? <button type="button" disabled={busy !== undefined} onClick={() => void authenticateConnector(connector)}>Connect</button> : <button type="button" disabled={connectorLoading || busy !== undefined} onClick={() => void discoverConnectors(connections, claudeStatuses, codexStatuses, true)}>Retry</button>}</article>)}</div></div> : null}
        <div className="connector-filter-tabs" role="tablist" aria-label="Filter connectors">{([['all', 'All'], ['connected', 'Connected'], ['not-connected', 'Not connected']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={connectorFilter === value} className={connectorFilter === value ? 'active' : ''} onClick={() => setConnectorFilter(value)}>{label}</button>)}</div>
        <div className="connector-table" aria-busy={connectorLoading}><div className="connector-table-head"><span>Connector</span><span>Account</span><span>Type</span><span>Status</span></div>{filteredConnectors.map((connector) => <article className="connector-row" key={connector.key}>
          <div className="connector-identity"><span className="connector-logo"><Wrench size={15} /></span><span><strong>{connector.name}</strong><small title={connector.target}>{connector.target ?? connector.detail ?? 'Configured by provider'}</small></span></div><span className="connector-account">{connector.accountLabel}</span><span className="connector-kind">{connectorTypeLabel(connector)}</span><div className={`connector-status ${connector.status}`}><span>{connector.status === 'connected' ? <Check size={14} /> : connector.status === 'error' ? <AlertTriangle size={14} /> : connectorStatusLabel(connector.status)}</span>{connector.status === 'needs-auth' ? <button type="button" disabled={busy !== undefined} onClick={() => void authenticateConnector(connector)}>Connect</button> : null}{connector.status === 'error' ? <button type="button" disabled={connectorLoading || busy !== undefined} onClick={() => void discoverConnectors(connections, claudeStatuses, codexStatuses, true)}>Retry</button> : null}{connector.removable ? <button type="button" className="connector-remove" aria-label={`Remove ${connector.name}`} title="Remove connector" disabled={busy !== undefined} onClick={() => requestRemoveConnector(connector)}><Trash2 size={13} /></button> : null}</div>
        </article>)}{filteredConnectors.length === 0 ? <div className="settings-empty-state connector-empty-state">{connectorLoading ? 'Discovering connectors…' : connectorAccountOptions.length === 0 ? 'Sign in to an account to discover its connectors.' : connectorSearch ? 'No connectors match your search.' : 'No connectors found. Add a remote MCP to get started.'}</div> : null}</div>
      </section>
      <aside className="connection-note"><ShieldCheck size={16} /><p><strong>Account-isolated and cached</strong><span>Connector discovery runs once per app session and stays scoped to each provider profile. Refresh only when you need a new health check.</span></p></aside>
    </> : <>
      <section className="connection-section connection-runtime-section"><div className="connection-section-heading"><div><h2>Account runtimes</h2><p>Official runtimes used to keep subscription sessions isolated.</p></div><button type="button" className={`connections-refresh-all ${busy === 'refresh' ? 'loading' : ''}`} onClick={() => void load()} disabled={busy !== undefined}><RefreshCw size={14} /></button></div><div className="connections-runtime-grid"><article className="connections-runtime"><span className="connections-runtime-icon"><Server size={16} /></span><div><strong>Claude Code</strong><small>{claudeRuntime?.version ?? claudeRuntime?.error ?? 'Checking installation…'}</small></div><span className={`connection-runtime-state ${claudeRuntime?.usable ? 'ready' : ''}`}>{claudeRuntime?.usable ? 'Ready' : claudeRuntime?.installed === false ? 'Not installed' : 'Unavailable'}</span></article><article className="connections-runtime"><span className="connections-runtime-icon"><Cloud size={16} /></span><div><strong>Codex / ChatGPT</strong><small>{codexRuntime?.version ?? codexRuntime?.error ?? 'Checking installation…'}</small></div><span className={`connection-runtime-state ${codexRuntime?.usable ? 'ready' : ''}`}>{codexRuntime?.usable ? 'Ready' : codexRuntime?.installed === false ? 'Not installed' : 'Unavailable'}</span></article></div></section>
      <section className="connection-section"><div className="connection-section-heading"><div><h2>Account connections</h2><p>Claude and ChatGPT subscription identities with isolated sign-in sessions.</p></div><span className="connection-count">{accountConnections.length}</span></div><div className="connection-list">{accountConnections.map(renderConnection)}{accountConnections.length === 0 ? <div className="settings-empty-state connection-empty-state">{busy === 'refresh' ? 'Loading account connections…' : 'No subscription accounts yet.'}</div> : null}</div></section>
      <section className="connection-section"><div className="connection-section-heading"><div><h2>API connections</h2><p>Metered credentials managed securely in Settings → API keys.</p></div><span className="connection-count">{apiConnections.length}</span></div><div className="connection-list">{apiConnections.map(renderConnection)}{apiConnections.length === 0 ? <div className="settings-empty-state connection-empty-state">{busy === 'refresh' ? 'Loading API connections…' : 'No API credentials configured.'}</div> : null}</div></section>
      <section className="connection-section"><div className="connection-section-heading"><div><h2>Local runtime</h2><p>On-device inference that never inherits cloud credentials.</p></div><span className="connection-count">{localConnections.length}</span></div><div className="connection-list">{localConnections.map(renderConnection)}{localConnections.length === 0 && busy !== 'refresh' ? <div className="settings-empty-state connection-empty-state">No local runtime available.</div> : null}</div></section>
      <aside className="connection-note"><ShieldCheck size={16} /><p><strong>Credentials stay private</strong><span>OAuth files, browser cookies and Keychain secrets remain opaque to the renderer and isolated by account profile.</span></p></aside>
    </>}

    {adding ? <div className="nested-settings-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setAdding(false); }}><form className="nested-settings-dialog connection-create-dialog" onSubmit={(event) => void create(event)}><header><div><h2>Add account connection</h2><p>Create an isolated profile, then authenticate with the provider-owned sign-in flow.</p></div></header><label><span>Account provider</span><UiSelect ariaLabel="Account provider" value={accountKind} options={accountOptions} onChange={(value) => setAccountKind(value as AccountKind)} /></label><label><span>Profile ID</span><input required autoFocus value={id} onChange={(event) => setId(event.target.value)} placeholder={accountKind === 'claude' ? 'claude-work' : 'chatgpt-personal'} spellCheck={false} /></label><label><span>Name</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder={accountKind === 'claude' ? 'Claude Work' : 'ChatGPT Personal'} /></label><label><span>Organization label <small>optional</small></span><input value={organizationLabel} onChange={(event) => setOrganizationLabel(event.target.value)} placeholder="Personal or company name" /></label><div className="nested-settings-dialog-actions"><button type="button" onClick={() => setAdding(false)}>Cancel</button><button className="settings-save-button" disabled={busy === 'create'}>{busy === 'create' ? 'Creating…' : 'Create connection'}</button></div></form></div> : null}
    {addingMcp ? <div className="nested-settings-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setAddingMcp(false); }}><form className="nested-settings-dialog connection-create-dialog connector-create-dialog" onSubmit={(event) => void addMcp(event)}><header><div><h2>Add custom connector</h2><p>Connect the selected provider account to a trusted remote MCP server.</p></div></header><label><span>Account</span><UiSelect ariaLabel="Connector account" value={mcpConnectionId} options={connectorAccountOptions} onChange={setMcpConnectionId} /></label><label><span>Name</span><input required autoFocus value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="sentry" spellCheck={false} pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" /></label><label><span>Remote MCP server URL</span><input required type="url" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} /></label><p className="connector-security-copy">Only HTTPS endpoints without embedded credentials or query parameters are accepted. Use connectors from developers you trust; their tools and behavior are controlled by that developer.</p><div className="nested-settings-dialog-actions"><button type="button" onClick={() => setAddingMcp(false)}>Cancel</button><button className="settings-save-button" disabled={busy === 'mcp-add' || !mcpConnectionId}>{busy === 'mcp-add' ? 'Adding…' : 'Add connector'}</button></div></form></div> : null}
    <ShellDialog request={dialog} onClose={() => setDialog(undefined)} />
  </div>;
}
