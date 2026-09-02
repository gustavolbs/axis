import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Plus, RefreshCw, Server, UserRound } from 'lucide-react';

import type {
  ClaudeAccountProfileView,
  ClaudeAccountStatusView,
  ClaudeRuntimeDiscoveryView
} from './native.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ClaudeAccountsSettings() {
  const bridge = window.lc;
  const [runtime, setRuntime] = useState<ClaudeRuntimeDiscoveryView>();
  const [profiles, setProfiles] = useState<ClaudeAccountProfileView[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ClaudeAccountStatusView>>({});
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [organizationLabel, setOrganizationLabel] = useState('');
  const [mcpProfileId, setMcpProfileId] = useState<string>();
  const [mcpOutput, setMcpOutput] = useState<Record<string, string>>({});

  async function refresh() {
    if (!bridge) return;
    setBusy('refresh');
    setMessage(undefined);
    try {
      const [nextRuntime, nextProfiles] = await Promise.all([
        bridge.claudeDiscover(),
        bridge.claudeAccounts()
      ]);
      setRuntime(nextRuntime);
      setProfiles(nextProfiles);
      const nextStatuses = await Promise.all(nextProfiles.map(async (profile) => {
        try {
          return [profile.id, await bridge.claudeAccountStatus(profile.id)] as const;
        } catch (error) {
          return [profile.id, {
            installed: nextRuntime.installed,
            usable: false,
            profileId: profile.id,
            authenticated: false,
            error: errorMessage(error)
          } satisfies ClaudeAccountStatusView] as const;
        }
      }));
      setStatuses(Object.fromEntries(nextStatuses));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const authenticatedCount = useMemo(
    () => profiles.filter((profile) => statuses[profile.id]?.authenticated).length,
    [profiles, statuses]
  );

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !id.trim() || !name.trim()) return;
    setBusy('create');
    setMessage(undefined);
    try {
      await bridge.createClaudeAccount({
        id: id.trim(),
        name: name.trim(),
        organizationLabel: organizationLabel.trim() || undefined
      });
      setId('');
      setName('');
      setOrganizationLabel('');
      setAdding(false);
      await refresh();
      setMessage('Claude account profile created. Sign in with the matching account to activate it.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function login(profileId: string, sso: boolean) {
    if (!bridge) return;
    setBusy(`login:${profileId}`);
    setMessage('Complete the Claude sign-in flow opened by Claude Code. Local Coder never receives the OAuth credential.');
    try {
      const status = await bridge.loginClaudeAccount(profileId, sso);
      setStatuses((current) => ({ ...current, [profileId]: status }));
      setMessage(status.authenticated ? 'Claude account connected.' : status.error ?? 'Claude login finished without an authenticated account.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function refreshStatus(profileId: string) {
    if (!bridge) return;
    setBusy(`status:${profileId}`);
    setMessage(undefined);
    try {
      const status = await bridge.claudeAccountStatus(profileId);
      setStatuses((current) => ({ ...current, [profileId]: status }));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function toggleMcps(profileId: string) {
    if (!bridge) return;
    if (mcpProfileId === profileId) {
      setMcpProfileId(undefined);
      return;
    }
    setMcpProfileId(profileId);
    if (mcpOutput[profileId] !== undefined) return;
    setBusy(`mcp:${profileId}`);
    setMessage(undefined);
    try {
      const result = await bridge.listClaudeAccountMcps(profileId);
      setMcpOutput((current) => ({ ...current, [profileId]: result.output || 'No MCP servers reported.' }));
    } catch (error) {
      setMcpOutput((current) => ({ ...current, [profileId]: `Could not list MCPs: ${errorMessage(error)}` }));
    } finally {
      setBusy(undefined);
    }
  }

  if (!bridge) {
    return <div className="focused-settings-page claude-account-settings-page">
      <header><div><h1>Claude accounts</h1><p>Claude account profiles are available in the Local Coder desktop app.</p></div></header>
      <div className="settings-empty-state">Open this page in the standalone desktop app to manage Claude accounts.</div>
    </div>;
  }

  return <div className="focused-settings-page claude-account-settings-page">
    <style>{`
      .claude-account-settings-page { width: min(860px, calc(100% - 48px)); }
      .claude-runtime-card { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:12px; align-items:center; margin-top:18px; padding:13px 14px; border:1px solid var(--lc-border); border-radius:12px; background:var(--lc-surface); }
      .claude-runtime-icon, .claude-account-icon { width:32px; height:32px; display:grid; place-items:center; border-radius:9px; background:var(--lc-surface-raised); color:var(--lc-text-soft); }
      .claude-runtime-card strong, .claude-runtime-card small, .claude-account-copy strong, .claude-account-copy small { display:block; }
      .claude-runtime-card small, .claude-account-copy small { margin-top:2px; color:var(--lc-muted); font-size:10px; }
      .claude-runtime-state { font-size:10px; color:var(--lc-muted); }
      .claude-runtime-state.ready { color:var(--lc-positive); }
      .claude-account-summary { margin:18px 0 8px; color:var(--lc-muted); font-size:10px; }
      .claude-account-list { display:grid; gap:10px; }
      .claude-account-card { border:1px solid var(--lc-border); border-radius:12px; background:var(--lc-surface); overflow:hidden; }
      .claude-account-main { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:12px; align-items:center; padding:13px 14px; }
      .claude-account-title { display:flex; align-items:center; gap:7px; }
      .claude-account-title em { font-style:normal; font-size:9px; color:var(--lc-muted); border:1px solid var(--lc-border); border-radius:999px; padding:2px 6px; }
      .claude-account-actions { display:flex; gap:7px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
      .claude-account-actions button { min-height:30px; }
      .claude-account-status { display:inline-flex; align-items:center; gap:5px; font-size:9.5px; color:var(--lc-muted); }
      .claude-account-status.ready { color:var(--lc-positive); }
      .claude-mcp-toggle { width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px; border:0; border-top:1px solid var(--lc-border); background:transparent; color:var(--lc-text-soft); padding:9px 14px; font-size:10px; text-align:left; }
      .claude-mcp-output { margin:0; max-height:220px; overflow:auto; padding:11px 14px 13px; border-top:1px solid color-mix(in srgb, var(--lc-border) 60%, transparent); background:var(--lc-code-bg, rgba(0,0,0,.14)); color:var(--lc-text-soft); font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; }
      .claude-account-security { margin-top:15px; padding:11px 13px; border:1px solid var(--lc-border); border-radius:10px; color:var(--lc-muted); font-size:9.5px; line-height:1.5; }
      .claude-account-form { margin-top:14px; display:grid; gap:10px; padding:14px; border:1px solid var(--lc-border); border-radius:12px; background:var(--lc-surface); }
      .claude-account-form label span { display:block; margin-bottom:5px; color:var(--lc-text-soft); font-size:10px; }
      .claude-account-form input { width:100%; }
      .claude-account-form-actions { display:flex; justify-content:flex-end; gap:8px; }
    `}</style>

    <header>
      <div><h1>Claude accounts</h1><p>Keep Personal, Team and Enterprise Claude identities isolated and available side by side.</p></div>
      <button className="settings-save-button" onClick={() => setAdding((value) => !value)}><Plus size={14} />Add account</button>
    </header>

    {message ? <div className="settings-inline-message" role="status">{message}</div> : null}

    <section className="claude-runtime-card">
      <span className="claude-runtime-icon"><Server size={16} /></span>
      <div><strong>Claude Code runtime</strong><small>{runtime?.version ?? runtime?.error ?? 'Checking installation…'}</small></div>
      <span className={`claude-runtime-state ${runtime?.usable ? 'ready' : ''}`}>{runtime?.usable ? 'Ready' : runtime?.installed === false ? 'Not installed' : 'Unavailable'}</span>
    </section>

    {adding ? <form className="claude-account-form" onSubmit={(event) => void create(event)}>
      <label><span>Profile ID</span><input autoFocus required value={id} onChange={(event) => setId(event.target.value)} placeholder="livenation" spellCheck={false} /></label>
      <label><span>Name</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Claude LiveNation" /></label>
      <label><span>Organization label <small>optional</small></span><input value={organizationLabel} onChange={(event) => setOrganizationLabel(event.target.value)} placeholder="LiveNation" /></label>
      <div className="claude-account-form-actions"><button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn-primary" disabled={busy === 'create'}>{busy === 'create' ? 'Creating…' : 'Create profile'}</button></div>
    </form> : null}

    <div className="claude-account-summary">{profiles.length} profile{profiles.length === 1 ? '' : 's'} · {authenticatedCount} authenticated</div>

    <div className="claude-account-list">
      {profiles.map((profile) => {
        const status = statuses[profile.id];
        const authenticated = status?.authenticated === true;
        const loginBusy = busy === `login:${profile.id}`;
        const mcpOpen = mcpProfileId === profile.id;
        return <article className="claude-account-card" key={profile.id}>
          <div className="claude-account-main">
            <span className="claude-account-icon"><UserRound size={16} /></span>
            <div className="claude-account-copy">
              <span className="claude-account-title"><strong>{profile.name}</strong>{profile.organizationLabel ? <em>{profile.organizationLabel}</em> : null}</span>
              <small>{status?.email ?? profile.id}{status?.organization ? ` · ${status.organization}` : ''}{status?.subscriptionType ? ` · ${status.subscriptionType}` : ''}</small>
              <span className={`claude-account-status ${authenticated ? 'ready' : ''}`}>{authenticated ? <CheckCircle2 size={11} /> : null}{authenticated ? 'Authenticated' : status?.error ?? 'Not authenticated'}</span>
            </div>
            <div className="claude-account-actions">
              <button className="btn-secondary" onClick={() => void refreshStatus(profile.id)} disabled={busy !== undefined}><RefreshCw size={13} />Refresh</button>
              {!authenticated ? <>
                <button className="btn-secondary" onClick={() => void login(profile.id, false)} disabled={!runtime?.usable || loginBusy}>Sign in</button>
                <button className="btn-primary" onClick={() => void login(profile.id, true)} disabled={!runtime?.usable || loginBusy}>{loginBusy ? 'Waiting…' : 'Sign in with SSO'}</button>
              </> : null}
            </div>
          </div>
          <button className="claude-mcp-toggle" onClick={() => void toggleMcps(profile.id)} disabled={!authenticated || busy === `mcp:${profile.id}`}>
            <span>MCP connections{busy === `mcp:${profile.id}` ? ' · loading…' : ''}</span>{mcpOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {mcpOpen ? <pre className="claude-mcp-output">{mcpOutput[profile.id] ?? 'Loading MCP connections…'}</pre> : null}
        </article>;
      })}
      {profiles.length === 0 ? <div className="settings-empty-state">No Claude accounts configured yet.</div> : null}
    </div>

    <div className="claude-account-security">
      Local Coder stores only profile metadata and a separate Claude configuration directory per identity. Authentication is performed by the official Claude Code login flow. OAuth credentials, browser cookies and Keychain contents are never read or copied by Local Coder.
    </div>
  </div>;
}
