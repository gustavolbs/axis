import { useEffect, useState } from 'react';

const capabilityKinds = ['skills', 'abilities', 'mcps', 'plugins', 'tools'] as const;
type CapabilityKind = typeof capabilityKinds[number];

interface CapabilityAccess {
  enabled: boolean;
  allowIds?: string[];
}

type CapabilityPolicy = Record<CapabilityKind, CapabilityAccess>;

interface ProviderView {
  id: string;
  kind: 'local' | 'cloud';
  settings: {
    enabled: boolean;
    capabilities?: CapabilityPolicy;
  };
}

const defaults: CapabilityPolicy = {
  skills: { enabled: true },
  abilities: { enabled: true },
  mcps: { enabled: false },
  plugins: { enabled: false },
  tools: { enabled: false }
};

const labels: Record<CapabilityKind, { title: string; description: string }> = {
  skills: { title: 'Skills', description: 'Reusable prompt-level specialist instructions.' },
  abilities: { title: 'Abilities', description: 'Provider-independent runtime abilities exposed by Local Coder.' },
  mcps: { title: 'MCPs', description: 'External Model Context Protocol servers. Disabled by default.' },
  plugins: { title: 'Plugins', description: 'External plugin integrations. Disabled by default.' },
  tools: { title: 'Tools', description: 'Side-effecting tool calls. Disabled by default.' }
};

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function policyFor(provider: ProviderView): CapabilityPolicy {
  return structuredClone(provider.settings.capabilities ?? defaults);
}

export function ProviderCapabilitiesSettings() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [saving, setSaving] = useState<string>();
  const [message, setMessage] = useState<string>();

  async function load() {
    const { providers: next } = await api<{ providers: ProviderView[] }>('/api/providers');
    setProviders(next);
  }

  useEffect(() => {
    void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  async function toggle(provider: ProviderView, kind: CapabilityKind) {
    const current = policyFor(provider);
    const nextEnabled = !current[kind].enabled;
    setSaving(`${provider.id}:${kind}`);
    setMessage(undefined);
    try {
      const { settings } = await api<{ settings: ProviderView['settings'] }>(
        `/api/providers/${encodeURIComponent(provider.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ capabilities: { [kind]: { enabled: nextEnabled } } })
        }
      );
      setProviders((items) => items.map((item) =>
        item.id === provider.id ? { ...item, settings } : item
      ));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(undefined);
    }
  }

  return <div className="focused-settings-page capability-settings-page">
    <style>{`
      .capability-settings-page { width: min(820px, calc(100% - 48px)); }
      .capability-provider { margin-top: 16px; overflow: hidden; border: 1px solid var(--lc-border); border-radius: 12px; background: var(--lc-surface); }
      .capability-provider > header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--lc-border); }
      .capability-provider > header strong { font-size: 12px; color: var(--lc-text); }
      .capability-provider > header small { color: var(--lc-muted); font-size: 9.5px; }
      .capability-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 10px 14px; }
      .capability-row + .capability-row { border-top: 1px solid color-mix(in srgb, var(--lc-border) 55%, transparent); }
      .capability-row strong, .capability-row small { display: block; }
      .capability-row strong { color: var(--lc-text-soft); font-size: 11px; font-weight: 570; }
      .capability-row small { margin-top: 2px; color: var(--lc-muted); font-size: 9.5px; }
      .capability-note { margin-top: 14px; color: var(--lc-muted); font-size: 9.5px; line-height: 1.45; }
      .capability-message { margin: 10px 0; color: var(--lc-negative); font-size: 10px; }
    `}</style>
    <header>
      <div>
        <h1>Capabilities</h1>
        <p>Control which capability classes each provider is allowed to use.</p>
      </div>
    </header>

    {message ? <div className="capability-message" role="alert">{message}</div> : null}

    {providers.map((provider) => {
      const policy = policyFor(provider);
      return <section className="capability-provider" key={provider.id}>
        <header><strong>{provider.id}</strong><small>{provider.kind}</small></header>
        {capabilityKinds.map((kind) => {
          const key = `${provider.id}:${kind}`;
          return <div className="capability-row" key={kind}>
            <div><strong>{labels[kind].title}</strong><small>{labels[kind].description}</small></div>
            <button
              className={`settings-toggle ${policy[kind].enabled ? 'on' : ''}`}
              aria-pressed={policy[kind].enabled}
              disabled={saving === key}
              onClick={() => void toggle(provider, kind)}
            ><i /></button>
          </div>;
        })}
      </section>;
    })}

    <p className="capability-note">
      MCPs, plugins and side-effecting tools are denied by default. A future adapter must declare its capability request through the common provider contract before it can run; this page controls that gate for local and cloud providers alike.
    </p>
  </div>;
}
