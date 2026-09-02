import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  KeyRound,
  Laptop,
  Plus,
  RefreshCw,
  Server,
  UserRound
} from 'lucide-react';

import type {
  ClaudeAccountProfileView,
  ClaudeAccountStatusView,
  ClaudeRuntimeDiscoveryView,
  CodexAccountProfileView,
  CodexAccountStatusView,
  CodexRuntimeDiscoveryView,
  ProviderConnectionView
} from './native.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AccountKind = 'claude' | 'chatgpt';

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

export function ConnectionsSettings() {
  const bridge = window.lc;
  const [connections, setConnections] = useState<ProviderConnectionView[]>([]);
  const [claudeRuntime, setClaudeRuntime] = useState<ClaudeRuntimeDiscoveryView>();
  const [codexRuntime, setCodexRuntime] = useState<CodexRuntimeDiscoveryView>();
  const [claudeProfiles, setClaudeProfiles] = useState<ClaudeAccountProfileView[]>([]);
  const [codexProfiles, setCodexProfiles] = useState<CodexAccountProfileView[]>([]);
  const [claudeStatuses, setClaudeStatuses] = useState<Record<string, ClaudeAccountStatusView>>({});
  const [codexStatuses, setCodexStatuses] = useState<Record<string, CodexAccountStatusView>>({});
  const [mcpOpen, setMcpOpen] = useState<string>();
  const [mcpOutput, setMcpOutput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [accountKind, setAccountKind] = useState<AccountKind>('claude');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [organizationLabel, setOrganizationLabel] = useState('');

  async function load() {
    if (!bridge) return;
    setBusy('refresh');
    setNotice(undefined);
    try {
      const [nextConnections, nextClaudeRuntime, nextCodexRuntime, nextClaudeProfiles, nextCodexProfiles] = await Promise.all([
        bridge.providerConnections(),
        bridge.claudeDiscover(),
        bridge.codexDiscover(),
        bridge.claudeAccounts(),
        bridge.codexAccounts()
      ]);
      setConnections(nextConnections);
      setClaudeRuntime(nextClaudeRuntime);
      setCodexRuntime(nextCodexRuntime);
      setClaudeProfiles(nextClaudeProfiles);
      setCodexProfiles(nextCodexProfiles);
      const [claude, codex] = await Promise.all([
        Promise.all(nextClaudeProfiles.map(async (profile) => [profile.id, await bridge.claudeAccountStatus(profile.id)] as const)),
        Promise.all(nextCodexProfiles.map(async (profile) => [profile.id, await bridge.codexAccountStatus(profile.id)] as const))
      ]);
      setClaudeStatuses(Object.fromEntries(claude));
      setCodexStatuses(Object.fromEntries(codex));
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
  const apiConnections = useMemo(() => connections.filter((connection) => connection.auth === 'api-key'), [connections]);
  const localConnections = useMemo(() => connections.filter((connection) => connection.auth === 'local'), [connections]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !id.trim() || !name.trim()) return;
    setBusy('create');
    setNotice(undefined);
    try {
      const input = { id: id.trim(), name: name.trim(), organizationLabel: organizationLabel.trim() || undefined };
      if (accountKind === 'claude') await bridge.createClaudeAccount(input);
      else await bridge.createCodexAccount(input);
      setId(''); setName(''); setOrganizationLabel(''); setAdding(false);
      await load();
      setNotice('Connection profile created. Sign in to activate it.');
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function login(connection: ProviderConnectionView, alternate = false) {
    if (!bridge?.isElectron || !connection.accountProfileId) return;
    setBusy(`login:${connection.id}`);
    setNotice('Complete the provider-owned sign-in flow. Local Coder does not receive or copy the OAuth credential.');
    try {
      if (connection.auth === 'claude-account') {
        const status = await bridge.loginClaudeAccount(connection.accountProfileId, alternate);
        setClaudeStatuses((current) => ({ ...current, [connection.accountProfileId!]: status }));
      } else if (connection.auth === 'chatgpt-account') {
        const status = await bridge.loginCodexAccount(connection.accountProfileId, alternate);
        setCodexStatuses((current) => ({ ...current, [connection.accountProfileId!]: status }));
      }
      await load();
      setNotice('Account connection is ready. It is now available as a distinct Chat connection.');
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
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
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  }

  function authenticated(connection: ProviderConnectionView): boolean {
    if (!connection.accountProfileId) return connection.available;
    if (connection.auth === 'claude-account') return claudeStatuses[connection.accountProfileId]?.authenticated === true;
    if (connection.auth === 'chatgpt-account') return codexStatuses[connection.accountProfileId]?.authenticated === true;
    return connection.available;
  }

  function accountDetail(connection: ProviderConnectionView): string {
    if (!connection.accountProfileId) return connectionDescription(connection);
    if (connection.auth === 'claude-account') {
      const status = claudeStatuses[connection.accountProfileId];
      return [status?.email, status?.organization, status?.subscriptionType].filter(Boolean).join(' · ') || connectionDescription(connection);
    }
    const status = codexStatuses[connection.accountProfileId];
    return status?.detail || connectionDescription(connection);
  }

  async function toggleMcp(connection: ProviderConnectionView) {
    if (!bridge || !connection.accountProfileId) return;
    if (mcpOpen === connection.id) { setMcpOpen(undefined); return; }
    setMcpOpen(connection.id);
    if (mcpOutput[connection.id] !== undefined) return;
    setBusy(`mcp:${connection.id}`);
    try {
      const result = connection.auth === 'claude-account'
        ? await bridge.listClaudeAccountMcps(connection.accountProfileId)
        : await bridge.listCodexAccountMcps(connection.accountProfileId);
      setMcpOutput((current) => ({ ...current, [connection.id]: result.output || 'No MCP servers reported.' }));
    } catch (error) {
      setMcpOutput((current) => ({ ...current, [connection.id]: `Could not list MCPs: ${message(error)}` }));
    } finally {
      setBusy(undefined);
    }
  }

  if (!bridge) return <div className="focused-settings-page"><h1>Connections</h1><div className="settings-empty-state">Open the standalone desktop app to manage provider identities.</div></div>;

  const renderConnection = (connection: ProviderConnectionView) => {
    const ready = authenticated(connection);
    const account = connection.auth === 'claude-account' || connection.auth === 'chatgpt-account';
    const runtimeReady = connection.auth === 'claude-account' ? claudeRuntime?.usable : connection.auth === 'chatgpt-account' ? codexRuntime?.usable : true;
    return <article className="connection-card" key={connection.id}>
      <div className="connection-card-main">
        <span className="connection-icon">{connection.auth === 'local' ? <Laptop size={16} /> : connection.auth === 'api-key' ? <KeyRound size={16} /> : <UserRound size={16} />}</span>
        <div className="connection-copy"><strong>{connection.label}</strong><small>{accountDetail(connection)}</small><span className={`connection-state ${ready ? 'ready' : ''}`}>{ready ? <CheckCircle2 size={11} /> : null}{ready ? 'Ready' : connection.reason ?? 'Sign in required'}</span></div>
        <div className="connection-actions">
          {account ? <>
            <button className="btn-secondary" disabled={busy !== undefined} onClick={() => void refreshAccount(connection)}><RefreshCw size={13} />Refresh</button>
            {!ready ? <button className="btn-primary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection, false)}>Sign in</button> : null}
            {!ready && connection.auth === 'claude-account' ? <button className="btn-secondary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection, true)}>Enterprise SSO</button> : null}
            {!ready && connection.auth === 'chatgpt-account' ? <button className="btn-secondary" disabled={!runtimeReady || busy !== undefined} onClick={() => void login(connection, true)}>Device login</button> : null}
          </> : null}
        </div>
      </div>
      {account ? <>
        <button className="connection-mcp-toggle" disabled={!ready} onClick={() => void toggleMcp(connection)}><span>MCP / connector sources</span>{mcpOpen === connection.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
        {mcpOpen === connection.id ? <pre className="connection-mcp-output">{mcpOutput[connection.id] ?? 'Loading…'}</pre> : null}
      </> : null}
    </article>;
  };

  return <div className="focused-settings-page connections-settings-page">
    <style>{`
      .connections-settings-page{width:min(880px,calc(100% - 48px))}.connections-runtime-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}.connections-runtime{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:12px;border:1px solid var(--lc-border);border-radius:12px;background:var(--lc-surface)}.connections-runtime span:first-child,.connection-icon{width:31px;height:31px;display:grid;place-items:center;border-radius:9px;background:var(--lc-surface-raised);color:var(--lc-text-soft)}.connections-runtime strong,.connections-runtime small,.connection-copy strong,.connection-copy small{display:block}.connections-runtime small,.connection-copy small{margin-top:2px;color:var(--lc-muted);font-size:9.5px}.connections-runtime em{font-style:normal;font-size:9px;color:var(--lc-muted)}.connections-runtime em.ready,.connection-state.ready{color:var(--lc-positive)}.connection-section{margin-top:18px}.connection-section>header{display:flex;align-items:end;justify-content:space-between;margin-bottom:8px}.connection-section h2{font-size:11px;margin:0}.connection-section p{font-size:9.5px;color:var(--lc-muted);margin:3px 0 0}.connection-list{display:grid;gap:8px}.connection-card{border:1px solid var(--lc-border);border-radius:12px;background:var(--lc-surface);overflow:hidden}.connection-card-main{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:11px;padding:12px}.connection-state{display:inline-flex;align-items:center;gap:5px;margin-top:5px;font-size:9px;color:var(--lc-muted)}.connection-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.connection-mcp-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;border:0;border-top:1px solid var(--lc-border);background:transparent;color:var(--lc-text-soft);padding:8px 12px;font-size:9.5px}.connection-mcp-output{margin:0;max-height:190px;overflow:auto;padding:10px 12px;border-top:1px solid var(--lc-border);font:9.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:var(--lc-text-soft)}.connection-create{display:grid;gap:9px;margin-top:12px;padding:13px;border:1px solid var(--lc-border);border-radius:12px;background:var(--lc-surface)}.connection-create label>span{display:block;margin-bottom:5px;font-size:9.5px;color:var(--lc-text-soft)}.connection-create-actions{display:flex;justify-content:flex-end;gap:7px}.connection-note{margin-top:16px;padding:11px;border:1px solid var(--lc-border);border-radius:10px;color:var(--lc-muted);font-size:9.5px;line-height:1.5}@media(max-width:760px){.connections-runtime-grid{grid-template-columns:1fr}.connection-card-main{grid-template-columns:auto 1fr}.connection-actions{grid-column:2;justify-content:flex-start}}
    `}</style>
    <header><div><h1>Connections</h1><p>Every account, API credential and local runtime is a distinct identity that Chat can select independently.</p></div><button className="settings-save-button" onClick={() => setAdding((value) => !value)}><Plus size={14} />Add account</button></header>
    {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}

    <div className="connections-runtime-grid">
      <div className="connections-runtime"><span><Server size={15} /></span><div><strong>Claude Code</strong><small>{claudeRuntime?.version ?? claudeRuntime?.error ?? 'Checking…'}</small></div><em className={claudeRuntime?.usable ? 'ready' : ''}>{claudeRuntime?.usable ? 'Ready' : 'Unavailable'}</em></div>
      <div className="connections-runtime"><span><Cloud size={15} /></span><div><strong>Codex / ChatGPT</strong><small>{codexRuntime?.version ?? codexRuntime?.error ?? 'Checking…'}</small></div><em className={codexRuntime?.usable ? 'ready' : ''}>{codexRuntime?.usable ? 'Ready' : 'Unavailable'}</em></div>
    </div>

    {adding ? <form className="connection-create" onSubmit={(event) => void create(event)}>
      <label><span>Account provider</span><UiSelect ariaLabel="Account provider" value={accountKind} options={accountOptions} onChange={(value) => setAccountKind(value as AccountKind)} /></label>
      <label><span>Profile ID</span><input required autoFocus value={id} onChange={(event) => setId(event.target.value)} placeholder={accountKind === 'claude' ? 'livenation' : 'chatgpt-personal'} spellCheck={false} /></label>
      <label><span>Name</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder={accountKind === 'claude' ? 'Claude LiveNation' : 'ChatGPT Personal'} /></label>
      <label><span>Organization label <small>optional</small></span><input value={organizationLabel} onChange={(event) => setOrganizationLabel(event.target.value)} placeholder="Personal or company name" /></label>
      <div className="connection-create-actions"><button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn-primary" disabled={busy === 'create'}>{busy === 'create' ? 'Creating…' : 'Create'}</button></div>
    </form> : null}

    <section className="connection-section"><header><div><h2>Account connections</h2><p>Subscription identities use isolated official runtime homes and can expose their own MCP/connectors.</p></div><small>{accountConnections.length}</small></header><div className="connection-list">{accountConnections.map(renderConnection)}{accountConnections.length === 0 ? <div className="settings-empty-state">No subscription accounts yet.</div> : null}</div></section>
    <section className="connection-section"><header><div><h2>API connections</h2><p>Each stored key is a separate metered identity. Add or remove keys in Settings → API keys.</p></div><small>{apiConnections.length}</small></header><div className="connection-list">{apiConnections.map(renderConnection)}{apiConnections.length === 0 ? <div className="settings-empty-state">No API credentials configured.</div> : null}</div></section>
    <section className="connection-section"><header><div><h2>Local</h2><p>Local inference remains an independent connection and never inherits cloud credentials.</p></div></header><div className="connection-list">{localConnections.map(renderConnection)}</div></section>

    <div className="connection-note">Chat selects a connection instance, not merely a provider brand. OAuth/token files, browser cookies and Keychain secrets stay opaque. Account MCP data is accessed only through explicit read-only Work Hub sources; ordinary Chat does not receive a generic tool bridge.</div>
  </div>;
}
