import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, RefreshCw, Trash2, X } from 'lucide-react';

import {
  connectionCenterBridge,
  type ApiKeyConnectionDetailsView,
  type ApiKeyConnectionTestView
} from './ConnectionCenterBridge.js';
import { ShellDialog, type ShellDialogRequest } from './ShellDialog.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ApiKeyConnectionDialog({
  connectionId,
  companyName,
  onClose,
  onChanged
}: {
  connectionId: string;
  companyName: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const bridge = connectionCenterBridge();
  const [details, setDetails] = useState<ApiKeyConnectionDetailsView>();
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [replacementSecret, setReplacementSecret] = useState('');
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [testResult, setTestResult] = useState<ApiKeyConnectionTestView>();
  const [dialog, setDialog] = useState<ShellDialogRequest>();

  async function load() {
    if (!bridge) return;
    const next = await bridge.apiKeyConnectionDetails(connectionId);
    setDetails(next);
    setName(next.name);
    setEndpoint(next.endpoint ?? '');
    setHeaders(Object.fromEntries(next.allowedHeaders.map((header) => [header, next.headers[header] ?? ''])));
  }

  useEffect(() => {
    void load().catch((error) => setNotice(errorMessage(error)));
  }, [connectionId]);

  const dirty = useMemo(() => {
    if (!details) return false;
    if (name.trim() !== details.name) return true;
    if (endpoint.trim() !== (details.endpoint ?? '')) return true;
    return details.allowedHeaders.some((header) => (headers[header]?.trim() ?? '') !== (details.headers[header] ?? ''));
  }, [details, endpoint, headers, name]);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!bridge || !details || !name.trim()) return;
    setBusy('save');
    setNotice(undefined);
    try {
      const cleanHeaders = Object.fromEntries(details.allowedHeaders
        .map((header) => [header, headers[header]?.trim() ?? ''] as const)
        .filter(([, value]) => Boolean(value)));
      const next = await bridge.updateApiKeyConnection({
        connectionId,
        name: name.trim(),
        endpoint: endpoint.trim() || null,
        headers: cleanHeaders
      });
      setDetails(next);
      setName(next.name);
      setEndpoint(next.endpoint ?? '');
      setHeaders(Object.fromEntries(next.allowedHeaders.map((header) => [header, next.headers[header] ?? ''])));
      await onChanged();
      setNotice('Connection settings saved.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function testConnection() {
    if (!bridge || !details) return;
    setBusy('test');
    setNotice(undefined);
    setTestResult(undefined);
    try {
      const result = await bridge.testApiKeyConnection(connectionId);
      setTestResult(result);
      setNotice(result.ok
        ? `Connection verified${result.modelsAvailable === undefined ? '' : ` · ${result.modelsAvailable} model${result.modelsAvailable === 1 ? '' : 's'} discovered`}.`
        : result.message ?? 'Connection test failed.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function rotate() {
    if (!bridge || !replacementSecret.trim()) return;
    setBusy('rotate');
    setNotice(undefined);
    try {
      const next = await bridge.rotateApiKeyConnection({ connectionId, secret: replacementSecret });
      setDetails(next);
      setReplacementSecret('');
      setTestResult(undefined);
      await onChanged();
      setNotice('API key rotated in macOS Keychain.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function toggleEnabled() {
    if (!bridge || !details) return;
    setBusy('enabled');
    setNotice(undefined);
    try {
      const next = await bridge.setApiKeyConnectionEnabled({ connectionId, enabled: !details.enabled });
      setDetails(next);
      setTestResult(undefined);
      await onChanged();
      setNotice(next.enabled ? 'Connection enabled.' : 'Connection disabled.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(undefined);
    }
  }

  function requestRemove() {
    if (!details) return;
    setDialog({
      kind: 'confirm',
      title: 'Remove API Key connection',
      message: `“${details.name}” will be removed from Axis and its Keychain secret deleted. Other API Key connections are unaffected. The stable Company reservation for this connection id remains in place.`,
      confirmLabel: 'Remove connection',
      danger: true,
      onConfirm: () => void removeConnection()
    });
  }

  async function removeConnection() {
    if (!bridge) return;
    setBusy('remove');
    setNotice(undefined);
    try {
      const removed = await bridge.removeApiKeyConnection(connectionId);
      if (!removed) throw new Error('Connection was already removed.');
      await onChanged();
      onClose();
    } catch (error) {
      setNotice(errorMessage(error));
      setBusy(undefined);
    }
  }

  if (!bridge) return null;

  return <>
    <div className="nested-settings-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose(); }}>
      <form className="nested-settings-dialog connection-create-dialog api-key-manage-dialog" data-api-connection-id={connectionId} onSubmit={(event) => void save(event)}>
        <header className="lc-shell-modal-title">
          <div><h2>Manage API Key connection</h2><p>Test and change this identity without exposing its stored secret to the renderer.</p></div>
          <button type="button" onClick={onClose} aria-label="Close API Key connection"><X size={17} /></button>
        </header>

        {!details ? <div className="settings-empty-state">Loading connection…</div> : <>
          <section className="settings-form-section">
            <div className="settings-section-copy"><strong>Identity</strong><p>{details.providerFamily} · {details.credentialId}</p></div>
            <span className={`connection-runtime-state ${details.enabled ? 'ready' : ''}`}>{details.enabled ? 'Enabled' : 'Disabled'}</span>
          </section>

          <label><span>Company</span><input value={companyName || details.companyId} readOnly aria-label="API Key Company" /></label>
          <label><span>Connection name</span><input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>API endpoint <small>optional</small></span><input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={details.providerFamily === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'} spellCheck={false} /></label>

          {details.allowedHeaders.map((header) => <label key={header}><span>{header} <small>optional</small></span><input aria-label={`API header ${header}`} value={headers[header] ?? ''} onChange={(event) => setHeaders((current) => ({ ...current, [header]: event.target.value }))} spellCheck={false} /></label>)}
          <p className="connector-security-copy">Only the provider-safe headers shown above are accepted. Authorization, API-key and protocol headers cannot be overridden.</p>

          <section className="settings-form-section settings-toggle-section">
            <div className="settings-section-copy"><strong>Connection enabled</strong><p>Disable this identity without deleting its Keychain secret or affecting sibling connections.</p></div>
            <button type="button" className={`settings-toggle ${details.enabled ? 'on' : ''}`} aria-label={details.enabled ? 'Disable API Key connection' : 'Enable API Key connection'} aria-pressed={details.enabled} disabled={busy !== undefined} onClick={() => void toggleEnabled()}><i /></button>
          </section>

          <div className="nested-settings-dialog-actions">
            <button type="button" className="btn-secondary" disabled={!details.enabled || busy !== undefined} onClick={() => void testConnection()}>{busy === 'test' ? <><RefreshCw size={13} />Testing…</> : 'Test connection'}</button>
            <button className="settings-save-button" disabled={!dirty || busy !== undefined}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
          </div>

          {testResult ? <p className={`settings-endpoint-result ${testResult.ok ? 'ok' : 'error'}`} role="status">{testResult.ok ? <CheckCircle2 size={13} /> : null}{testResult.ok ? `Verified in ${testResult.latencyMs}ms.` : testResult.message ?? 'Connection test failed.'}</p> : null}

          <section className="settings-stacked-section">
            <div className="settings-section-copy"><strong>Rotate API key</strong><p>Replacement overwrites the same Keychain item; the connection id, Company and provider do not change.</p></div>
            <label><span>Replacement API key</span><input type="password" autoComplete="new-password" value={replacementSecret} onChange={(event) => setReplacementSecret(event.target.value)} placeholder="New key" /></label>
            <button type="button" className="btn-secondary" disabled={!replacementSecret.trim() || busy !== undefined} onClick={() => void rotate()}><KeyRound size={13} />{busy === 'rotate' ? 'Rotating…' : 'Rotate key'}</button>
          </section>

          <section className="settings-stacked-section">
            <div className="settings-section-copy"><strong>Remove connection</strong><p>Deletes only this credential/configuration. Sibling connections stay intact.</p></div>
            <button type="button" className="btn-secondary danger" disabled={busy !== undefined} onClick={requestRemove}><Trash2 size={13} />Remove connection</button>
          </section>
        </>}

        {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}
      </form>
    </div>
    <ShellDialog request={dialog} onClose={() => setDialog(undefined)} />
  </>;
}
