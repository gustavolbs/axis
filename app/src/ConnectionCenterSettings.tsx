import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Cloud,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  UserRound
} from 'lucide-react';

import { ApiKeyConnectionDialog } from './ApiKeyConnectionDialog.js';
import { connectionCenterBridge } from './ConnectionCenterBridge.js';
import { ConnectionsSettings as LegacyConnectionsSettings } from './LegacyConnectionsSettings.js';
import type {
  ClaudeAccountStatusView,
  ClaudeRuntimeDiscoveryView,
  CodexAccountStatusView,
  CodexRuntimeDiscoveryView,
  ProviderConnectionView
} from './native.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

type CenterSurface = 'connections' | 'connectors';
type NewConnectionKind = 'claude-account' | 'chatgpt-account' | 'openai-api' | 'anthropic-api';

interface CompanyView {
  id: string;
  name: string;
  kind: 'personal' | 'company';
  archivedAt?: string;
}

interface CompanyContextView {
  companies: CompanyView[];
}

interface ManagedRestrictionState {
  checked: boolean;
  managedMcpCount: number;
  error?: string;
}

export interface ConnectionCenterSettingsProps {
  /** When present, the Center becomes a Company-owned administration surface. */
  companyId?: string;
  companyName?: string;
  initialSurface?: CenterSurface;
  showConnectors?: boolean;
  /** Reuse Company Hub chrome instead of nesting a second Settings page. */
  embedded?: boolean;
}

const connectionKindOptions: UiSelectOption[] = [
  { value: 'claude-account', label: 'Claude account', description: 'Provider-owned OAuth/session through Claude Code' },
  { value: 'chatgpt-account', label: 'ChatGPT / Codex account', description: 'Provider-owned account through the official Codex runtime' },
  { value: 'openai-api', label: 'OpenAI API key', description: 'Independent metered credential stored in macOS Keychain' },
  { value: 'anthropic-api', label: 'Anthropic API key', description: 'Independent metered credential stored in macOS Keychain' }
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authLabel(connection: ProviderConnectionView): string {
  if (connection.auth === 'claude-account') return 'Claude Account';
  if (connection.auth === 'chatgpt-account') return 'ChatGPT Account';
  if (connection.auth === 'api-key') return 'API Key';
  return 'Local';
}

function providerLabel(connection: ProviderConnectionView): string {
  if (connection.providerFamily === 'anthropic') return 'Anthropic';
  if (connection.providerFamily === 'openai') return 'OpenAI';
  return 'Ollama';
}

function connectionEndpoint(connection: ProviderConnectionView): string | undefined {
  return connection.endpoint;
}

function isAccount(connection: ProviderConnectionView): boolean {
  return connection.auth === 'claude-account' || connection.auth === 'chatgpt-account';
}

function visibleInCompanyScope(connection: ProviderConnectionView, companyId?: string): boolean {
  if (!companyId) return true;
  if (connection.companyId === companyId) return true;
  return companyId === 'personal' && connection.auth === 'local';
}

export function ConnectionCenterSettings({
  companyId: fixedCompanyId,
  companyName: fixedCompanyName,
  initialSurface = 'connections',
  showConnectors = true,
  embedded = false
}: ConnectionCenterSettingsProps = {}) {
  const bridge = connectionCenterBridge();
  const [surface, setSurface] = useState<CenterSurface>(initialSurface);
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [companies, setCompanies] = useState<CompanyView[]>([]);
  const [claudeRuntime, setClaudeRuntime] = useState<ClaudeRuntimeDiscoveryView>();
  const [codexRuntime, setCodexRuntime] = useState<CodexRuntimeDiscoveryView>();
  const [claudeStatuses, setClaudeStatuses] = useState<Record<string, ClaudeAccountStatusView>>({});
  const [codexStatuses, setCodexStatuses] = useState<Record<string, CodexAccountStatusView>>({});
  const [managed, setManaged] = useState<Record<string, ManagedRestrictionState>>({});
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [managingApiId, setManagingApiId] = useState<string>();
  const [newKind, setNewKind] = useState<NewConnectionKind>('claude-account');
  const [companyId, setCompanyId] = useState(fixedCompanyId ?? 'personal');
  const [connectionId, setConnectionId] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [secret, setSecret] = useState('');

  function authenticated(
    connection: ProviderConnectionView,
    claude = claudeStatuses,
    codex = codexStatuses
  ): boolean {
    if (!connection.accountProfileId) return connection.available;
    if (connection.auth === 'claude-account') return claude[connection.accountProfileId]?.authenticated === true;
    if (connection.auth === 'chatgpt-account') return codex[connection.accountProfileId]?.authenticated === true;
    return connection.available;
  }

  async function discoverManagedRestrictions(
    sourceConnections: ProviderConnectionView[],
    claude: Record<string, ClaudeAccountStatusView>,
    codex: Record<string, CodexAccountStatusView>
  ) {
    if (!bridge) return;
    const accountConnections = sourceConnections.filter((connection) =>
      isAccount(connection) && Boolean(connection.accountProfileId) && authenticated(connection, claude, codex)
    );
    const results = await Promise.allSettled(accountConnections.map(async (connection) => {
      const profileId = connection.accountProfileId!;
      const discovery = connection.auth === 'claude-account'
        ? await bridge.listClaudeAccountMcps(profileId, false)
        : await bridge.listCodexAccountMcps(profileId, false);
      return [connection.id, {
        checked: true,
        managedMcpCount: discovery.connectors.filter((connector) => connector.managed).length
      }] as const;
    }));
    const next: Record<string, ManagedRestrictionState> = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') next[result.value[0]] = result.value[1];
      else {
        const connection = accountConnections[index];
        if (connection) next[connection.id] = {
          checked: true,
          managedMcpCount: 0,
          error: errorMessage(result.reason)
        };
      }
    });
    setManaged(next);
  }

  async function load() {
    if (!bridge) return;
    setBusy('refresh');
    setNotice(undefined);
    try {
      const [nextConnections, companyResponse, nextClaudeRuntime, nextCodexRuntime] = await Promise.all([
        bridge.providerConnections(),
        bridge.request<{ context: CompanyContextView }>({ method: 'GET', path: '/api/companies/context' }),
        bridge.claudeDiscover(),
        bridge.codexDiscover()
      ]);
      setConnections(nextConnections);
      setCompanies(companyResponse.context.companies);
      setClaudeRuntime(nextClaudeRuntime);
      setCodexRuntime(nextCodexRuntime);

      const scopedConnections = fixedCompanyId
        ? nextConnections.filter((connection) => visibleInCompanyScope(connection, fixedCompanyId))
        : nextConnections;
      const accountConnections = scopedConnections.filter((connection) => isAccount(connection) && connection.accountProfileId);
      const statusResults = await Promise.all(accountConnections.map(async (connection) => {
        const profileId = connection.accountProfileId!;
        if (connection.auth === 'claude-account') {
          return [connection, await bridge.claudeAccountStatus(profileId)] as const;
        }
        return [connection, await bridge.codexAccountStatus(profileId)] as const;
      }));
      const nextClaude: Record<string, ClaudeAccountStatusView> = {};
      const nextCodex: Record<string, CodexAccountStatusView> = {};
      for (const [connection, status] of statusResults) {
        if (connection.auth === 'claude-account') nextClaude[connection.accountProfileId!] = status as ClaudeAccountStatusView;
        else nextCodex[connection.accountProfileId!] = status as CodexAccountStatusView;
      }
      setClaudeStatuses(nextClaude);
      setCodexStatuses(nextCodex);
      await discoverManagedRestrictions(scopedConnections, nextClaude, nextCodex);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => { void load(); }, [fixedCompanyId]);

  const companyOptions = useMemo<UiSelectOption[]>(() => {
    if (fixedCompanyId) {
      const company = companies.find((candidate) => candidate.id === fixedCompanyId);
      return [{
        value: fixedCompanyId,
        label: fixedCompanyName ?? company?.name ?? fixedCompanyId,
        description: company?.kind === 'personal' ? 'Personal context' : 'Company context'
      }];
    }
    return companies
      .filter((company) => !company.archivedAt)
      .map((company) => ({
        value: company.id,
        label: company.name,
        description: company.kind === 'personal' ? 'Personal context' : 'Company context'
      }));
  }, [companies, fixedCompanyId, fixedCompanyName]);

  useEffect(() => {
    if (fixedCompanyId) {
      if (companyId !== fixedCompanyId) setCompanyId(fixedCompanyId);
      return;
    }
    if (companyOptions.length === 0) return;
    if (!companyOptions.some((option) => option.value === companyId)) setCompanyId(companyOptions[0].value);
  }, [companyId, companyOptions, fixedCompanyId]);

  const filteredConnections = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return connections.filter((connection) => {
      if (fixedCompanyId && connection.companyId !== fixedCompanyId) {
        if (!visibleInCompanyScope(connection, fixedCompanyId)) return false;
      }
      if (!query) return true;
      return [
        connection.label,
        connection.companyName,
        connection.organizationLabel,
        connection.providerFamily,
        connection.auth,
        connection.id,
        connectionEndpoint(connection)
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [connections, fixedCompanyId, search]);

  function state(connection: ProviderConnectionView): { ready: boolean; label: string } {
    if (connection.auth === 'local') {
      return { ready: connection.available, label: connection.available ? 'Ready' : connection.reason ?? 'Unavailable' };
    }
    if (connection.auth === 'api-key') {
      return { ready: connection.available, label: connection.available ? 'Ready' : connection.reason ?? 'Credential unavailable' };
    }
    const runtime = connection.auth === 'claude-account' ? claudeRuntime : codexRuntime;
    if (!runtime?.usable) return { ready: false, label: runtime?.installed === false ? 'Runtime not installed' : 'Runtime unavailable' };
    return authenticated(connection)
      ? { ready: true, label: 'Ready' }
      : { ready: false, label: 'Sign in required' };
  }

  function management(connection: ProviderConnectionView): string {
    if (connection.auth === 'local') return 'Shared execution capability; no Company credential.';
    if (connection.auth === 'api-key') return 'Managed restrictions: none reported by a provider account.';
    if (!authenticated(connection)) return 'Managed restrictions: checked after provider sign-in.';
    const restriction = managed[connection.id];
    if (!restriction?.checked) return 'Managed restrictions: checking provider account…';
    if (restriction.error) return `Managed restrictions: unavailable (${restriction.error}).`;
    if (restriction.managedMcpCount === 0) return 'Managed restrictions: none reported by the provider.';
    return `Managed restrictions: ${restriction.managedMcpCount} provider-managed MCP${restriction.managedMcpCount === 1 ? '' : 's'} (read-only).`;
  }

  async function refreshAccount(connection: ProviderConnectionView) {
    if (!bridge || !connection.accountProfileId) return;
    setBusy(`status:${connection.id}`);
    setNotice(undefined);
    try {
      if (connection.auth === 'claude-account') {
        const status = await bridge.claudeAccountStatus(connection.accountProfileId);
        setClaudeStatuses((current) => ({ ...current, [connection.accountProfileId!]: status }));
      } else if (connection.auth === 'chatgpt-account') {
        const status = await bridge.codexAccountStatus(connection.accountProfileId);
        setCodexStatuses((current) => ({ ...current, [connection.accountProfileId!]: status }));
      }
      await load();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function login(connection: ProviderConnectionView, alternate = false) {
    if (!bridge || !connection.accountProfileId) return;
    setBusy(`login:${connection.id}`);
    setNotice('Complete the provider-owned sign-in flow. Axis never copies the OAuth credential.');
    try {
      if (connection.auth === 'claude-account') await bridge.loginClaudeAccount(connection.accountProfileId, alternate);
      else if (connection.auth === 'chatgpt-account') await bridge.loginCodexAccount(connection.accountProfileId, alternate);
      await load();
      setNotice(`${connection.label} is ready.`);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  function resetCreateForm() {
    setConnectionId('');
    setConnectionName('');
    setEndpoint('');
    setSecret('');
    setNewKind('claude-account');
    if (fixedCompanyId) setCompanyId(fixedCompanyId);
    else {
      const personal = companyOptions.find((option) => option.value === 'personal');
      setCompanyId(personal?.value ?? companyOptions[0]?.value ?? 'personal');
    }
  }

  async function createConnection(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !connectionId.trim() || !connectionName.trim() || !companyId) return;
    if (fixedCompanyId && companyId !== fixedCompanyId) throw new Error('Company-scoped Connection Center cannot create a connection for another Company.');
    const api = newKind === 'openai-api' || newKind === 'anthropic-api';
    if (api && !secret.trim()) return;
    setBusy('create');
    setNotice(undefined);
    try {
      if (newKind === 'claude-account') {
        await bridge.createClaudeAccount({ id: connectionId.trim(), name: connectionName.trim(), companyId });
      } else if (newKind === 'chatgpt-account') {
        await bridge.createCodexAccount({ id: connectionId.trim(), name: connectionName.trim(), companyId });
      } else {
        await bridge.createApiKeyConnection({
          id: connectionId.trim(),
          name: connectionName.trim(),
          providerFamily: newKind === 'openai-api' ? 'openai' : 'anthropic',
          companyId,
          secret: secret.trim(),
          ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {})
        });
      }
      const account = newKind === 'claude-account' || newKind === 'chatgpt-account';
      resetCreateForm();
      setAdding(false);
      await load();
      setNotice(account ? 'Connection created. Sign in to activate the provider account.' : 'API Key connection created and stored in Keychain.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  if (!bridge) {
    return <div className={embedded ? 'connection-center-settings' : 'focused-settings-page'}><h1>Connections</h1><div className="settings-empty-state">Open the standalone desktop app to manage provider identities.</div></div>;
  }

  const apiKind = newKind === 'openai-api' || newKind === 'anthropic-api';
  const managingApi = filteredConnections.find((connection) => connection.id === managingApiId && connection.auth === 'api-key');
  const scopedLabel = fixedCompanyName ?? companies.find((company) => company.id === fixedCompanyId)?.name;
  const personalScope = fixedCompanyId === 'personal';

  return <div className={`${embedded ? '' : 'focused-settings-page connections-settings-page '}connection-center-settings`} data-company-scope={fixedCompanyId} data-embedded={embedded ? 'true' : 'false'}>
    {!embedded ? <header>
      <div><h1>Connections</h1><p>{personalScope ? 'Personal provider identities plus shared local execution. New cloud connections are bound to Personal.' : fixedCompanyId ? `Provider identities owned by ${scopedLabel ?? fixedCompanyId}. New connections are locked to this context.` : 'Every cloud provider identity is a separate Company-owned connection; local runtimes remain shared execution capabilities.'}</p></div>
      {surface === 'connections' ? <button type="button" className="settings-save-button" onClick={() => setAdding(true)}><Plus size={14} />Add connection</button> : null}
    </header> : surface === 'connections' ? <div className="connection-section-heading"><div><h2>Provider connections</h2><p>{personalScope ? 'Personal provider identities plus shared local execution.' : `Provider identities owned by ${scopedLabel ?? fixedCompanyId}.`}</p></div><button type="button" className="settings-save-button" onClick={() => setAdding(true)}><Plus size={14} />Add connection</button></div> : null}

    {showConnectors ? <nav className="connections-surface-tabs" aria-label="Connection settings">
      <button type="button" className={surface === 'connections' ? 'active' : ''} onClick={() => setSurface('connections')}><UserRound size={14} />Connections</button>
      <button type="button" className={surface === 'connectors' ? 'active' : ''} onClick={() => setSurface('connectors')}><Link2 size={14} />Connectors</button>
    </nav> : null}

    {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}

    {surface === 'connectors' && showConnectors ? <div className="connection-center-legacy-connectors"><LegacyConnectionsSettings /></div> : <>
      <section className="connection-section connection-runtime-section">
        <div className="connection-section-heading"><div><h2>Provider runtimes</h2><p>Account authentication remains inside the official provider runtime.</p></div><button type="button" className={`connections-refresh-all ${busy === 'refresh' ? 'loading' : ''}`} onClick={() => void load()} disabled={busy !== undefined}><RefreshCw size={14} /></button></div>
        <div className="connections-runtime-grid">
          <article className="connections-runtime"><span className="connections-runtime-icon"><Server size={16} /></span><div><strong>Claude Code</strong><small>{claudeRuntime?.version ?? claudeRuntime?.error ?? 'Checking installation…'}</small></div><span className={`connection-runtime-state ${claudeRuntime?.usable ? 'ready' : ''}`}>{claudeRuntime?.usable ? 'Ready' : claudeRuntime?.installed === false ? 'Not installed' : 'Unavailable'}</span></article>
          <article className="connections-runtime"><span className="connections-runtime-icon"><Cloud size={16} /></span><div><strong>Codex / ChatGPT</strong><small>{codexRuntime?.version ?? codexRuntime?.error ?? 'Checking installation…'}</small></div><span className={`connection-runtime-state ${codexRuntime?.usable ? 'ready' : ''}`}>{codexRuntime?.usable ? 'Ready' : codexRuntime?.installed === false ? 'Not installed' : 'Unavailable'}</span></article>
        </div>
      </section>

      <section className="connection-section connection-center-inventory">
        <div className="connection-section-heading"><div><h2>Connection inventory</h2><p>{personalScope ? 'Personal cloud identities and shared local runtimes are shown here.' : fixedCompanyId ? 'Only connections canonically owned by this Company are shown.' : 'Accounts and API Keys from the same provider remain distinct identities with independent Company ownership.'}</p></div><span className="connection-count">{filteredConnections.length}</span></div>
        <label className="connector-search connection-center-search"><Search size={14} /><input aria-label="Search connections" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={personalScope ? 'Search Personal connections and local runtimes' : fixedCompanyId ? 'Search this Company’s connections' : 'Search name, Company, provider or auth kind'} /></label>
        <div className="connection-list">
          {filteredConnections.map((connection) => {
            const currentState = state(connection);
            const account = isAccount(connection);
            const customEndpoint = connectionEndpoint(connection);
            const runtimeReady = connection.auth === 'claude-account' ? claudeRuntime?.usable : connection.auth === 'chatgpt-account' ? codexRuntime?.usable : true;
            return <article className="connection-card connection-center-card" key={connection.id} data-connection-id={connection.id} data-company-id={connection.companyId}>
              <div className="connection-card-main">
                <span className="connection-icon">{connection.auth === 'api-key' ? <KeyRound size={16} /> : <UserRound size={16} />}</span>
                <div className="connection-copy">
                  <div className="connection-title-row"><strong>{connection.label}</strong><span>{authLabel(connection)}</span></div>
                  <small>{connection.auth === 'local' ? `${providerLabel(connection)} · Shared local execution · ${connection.billing}` : `${providerLabel(connection)} · Company: ${connection.companyName ?? connection.organizationLabel ?? connection.organizationId ?? 'Unassigned'} · ${connection.billing}`}</small>
                  {connection.auth === 'api-key' ? <small>{customEndpoint ? `Custom endpoint: ${customEndpoint}` : 'Official provider endpoint'}</small> : null}
                  <span className={`connection-state ${currentState.ready ? 'ready' : ''}`}>{currentState.ready ? <CheckCircle2 size={12} /> : null}{currentState.label}</span>
                  <small className="connection-management"><ShieldCheck size={12} />{management(connection)}</small>
                </div>
                {account ? <div className="connection-actions">
                  <button type="button" className="btn-secondary connection-refresh" disabled={busy !== undefined} onClick={() => void refreshAccount(connection)}><RefreshCw size={13} />Refresh</button>
                  {!currentState.ready ? <button type="button" className="btn-primary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection)}>Sign in</button> : null}
                  {!currentState.ready && connection.auth === 'claude-account' ? <button type="button" className="btn-secondary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection, true)}>Enterprise SSO</button> : null}
                  {!currentState.ready && connection.auth === 'chatgpt-account' ? <button type="button" className="btn-secondary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection, true)}>Device login</button> : null}
                </div> : connection.auth === 'api-key' ? <div className="connection-actions">
                  <button type="button" className="btn-secondary connection-refresh" disabled={busy !== undefined} onClick={() => setManagingApiId(connection.id)}>Manage</button>
                </div> : null}
              </div>
            </article>;
          })}
          {filteredConnections.length === 0 ? <div className="settings-empty-state connection-empty-state">{busy === 'refresh' ? 'Loading connections…' : search ? 'No connections match your search.' : personalScope ? 'No Personal provider identities are configured. Shared local runtimes appear here when available.' : fixedCompanyId ? 'No provider connections belong to this Company yet.' : 'No provider connections yet.'}</div> : null}
        </div>
      </section>

      <aside className="connection-note"><ShieldCheck size={16} /><p><strong>{personalScope ? 'Personal identities, shared local runtime' : 'One identity, one Company'}</strong><span>{personalScope ? 'Personal owns its cloud identities; Ollama remains a shared local execution capability and is not assigned a fake Company.' : 'OAuth stays in the provider runtime; API Keys stay in Keychain. Axis persists only stable ownership and endpoint metadata and never infers Company from a mutable account label after binding.'}</span></p></aside>
    </>}

    {adding ? <div className="nested-settings-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setAdding(false); }}>
      <form className="nested-settings-dialog connection-create-dialog" onSubmit={(event) => void createConnection(event)}>
        <header><div><h2>Add connection</h2><p>Create a distinct provider identity and bind it to exactly one Company.</p></div></header>
        <label><span>Authentication</span><UiSelect ariaLabel="Connection authentication" value={newKind} options={connectionKindOptions} onChange={(value) => { setNewKind(value as NewConnectionKind); setEndpoint(''); setSecret(''); }} /></label>
        {fixedCompanyId ? <div className="company-connection-fixed-scope"><span>Company</span><strong>{scopedLabel ?? fixedCompanyId}</strong><small>Ownership is fixed by the current Company Hub.</small></div> : <label><span>Company</span><UiSelect ariaLabel="Connection Company" value={companyId} options={companyOptions} onChange={setCompanyId} /></label>}
        <label><span>{apiKind ? 'Credential ID' : 'Profile ID'}</span><input required autoFocus value={connectionId} onChange={(event) => setConnectionId(event.target.value)} placeholder={apiKind ? 'openai-work-1' : newKind === 'claude-account' ? 'claude-work' : 'chatgpt-work'} spellCheck={false} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" /></label>
        <label><span>Name</span><input required value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder={apiKind ? 'OpenAI Product Team' : newKind === 'claude-account' ? 'Claude Work' : 'ChatGPT Work'} /></label>
        {apiKind ? <label><span>Endpoint <small>optional</small></span><input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={newKind === 'openai-api' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'} spellCheck={false} /></label> : null}
        {apiKind ? <label><span>API key</span><input required type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Stored only in macOS Keychain" /></label> : null}
        <p className="connector-security-copy">{apiKind ? 'Leave Endpoint empty to use the official provider API. Custom endpoint metadata stays local; the API key is sent directly to the main process and stored only in macOS Keychain.' : 'Authentication happens after creation in the provider-owned runtime. Axis stores the profile id and Company binding, not OAuth credentials.'}</p>
        <div className="nested-settings-dialog-actions"><button type="button" onClick={() => setAdding(false)}>Cancel</button><button className="settings-save-button" disabled={busy === 'create' || companyOptions.length === 0}>{busy === 'create' ? 'Creating…' : 'Create connection'}</button></div>
      </form>
    </div> : null}

    {managingApi ? <ApiKeyConnectionDialog
      connectionId={managingApi.id}
      companyName={managingApi.companyName ?? managingApi.organizationLabel ?? managingApi.organizationId ?? 'Personal'}
      onClose={() => setManagingApiId(undefined)}
      onChanged={load}
    /> : null}
  </div>;
}
