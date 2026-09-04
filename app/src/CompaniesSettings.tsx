import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Pencil,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react';

import type { CompanyDefinition, CompanyIconId } from './app-types.js';
import { CompanyIcon } from './CompanyIcon.js';
import { ShellDialog, type ShellDialogRequest } from './ShellDialog.js';
import { UiSelect, type UiSelectOption } from './UiSelect.js';

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

type CompanyView = 'active' | 'archived';

const iconOptions: UiSelectOption[] = [
  { value: 'building-2', label: 'Building' },
  { value: 'briefcase-business', label: 'Briefcase' },
  { value: 'code-2', label: 'Code' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'landmark', label: 'Landmark' },
  { value: 'heart-pulse', label: 'Health' },
  { value: 'graduation-cap', label: 'Education' },
  { value: 'palette', label: 'Creative' }
];

function relative(value: string): string {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function CompaniesSettings() {
  const [companies, setCompanies] = useState<CompanyDefinition[]>([]);
  const [view, setView] = useState<CompanyView>('active');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CompanyDefinition | null | undefined>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#64748B');
  const [icon, setIcon] = useState<CompanyIconId>('building-2');
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dialog, setDialog] = useState<ShellDialogRequest>();

  async function load() {
    // Bring legacy Project/Account identities into the canonical store before
    // listing it so existing users never see an apparently empty Contexts page.
    await api('/api/companies/context');
    const { companies: next } = await api<{ companies: CompanyDefinition[] }>('/api/companies?archived=all');
    setCompanies(next);
  }

  function openEditor(company: CompanyDefinition | null) {
    setEditing(company);
    setName(company?.name ?? '');
    setDescription(company?.description ?? '');
    setColor(company?.color ?? '#64748B');
    setIcon(company?.icon ?? 'building-2');
    setNotice(undefined);
  }

  useEffect(() => {
    void load()
      .then(() => openEditor(null))
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, []);

  const active = useMemo(
    () => companies.filter((company) => !company.archivedAt).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [companies]
  );
  const archived = useMemo(
    () => companies.filter((company) => company.archivedAt).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
    [companies]
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const source = view === 'active' ? active : archived;
    return source.filter((company) => !needle || [company.name, company.description ?? '']
      .some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [active, archived, query, view]);

  function closeEditor() {
    setEditing(undefined);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy('save');
    setNotice(undefined);
    try {
      const body = { name: name.trim(), description: description.trim(), color, icon };
      if (editing) {
        await api(`/api/companies/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body });
        setNotice(`${name.trim()} updated.`);
      } else {
        await api('/api/companies', { method: 'POST', body });
        setNotice(`${name.trim()} created.`);
      }
      closeEditor();
      await load();
      window.dispatchEvent(new CustomEvent('local-coder:companies-changed'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function setArchived(company: CompanyDefinition, archivedState: boolean) {
    setBusy(`archive:${company.id}`);
    setNotice(undefined);
    try {
      await api(`/api/companies/${encodeURIComponent(company.id)}/archive`, {
        method: 'POST', body: { archived: archivedState }
      });
      await load();
      setNotice(archivedState ? `${company.name} archived.` : `${company.name} restored.`);
      window.dispatchEvent(new CustomEvent('local-coder:companies-changed'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  function requestDelete(company: CompanyDefinition) {
    setDialog({
      kind: 'confirm',
      title: 'Delete context',
      message: `“${company.name}” will be permanently deleted. Axis only allows this when the context has no projects, connections or conversations.`,
      confirmLabel: 'Delete context',
      danger: true,
      onConfirm: () => void deleteCompany(company)
    });
  }

  async function deleteCompany(company: CompanyDefinition) {
    setBusy(`delete:${company.id}`);
    setNotice(undefined);
    try {
      await api(`/api/companies/${encodeURIComponent(company.id)}`, { method: 'DELETE' });
      await load();
      setNotice(`${company.name} deleted.`);
      window.dispatchEvent(new CustomEvent('local-coder:companies-changed'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function move(company: CompanyDefinition, direction: -1 | 1) {
    const index = active.findIndex((item) => item.id === company.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= active.length) return;
    const ids = active.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setBusy(`order:${company.id}`);
    setNotice(undefined);
    try {
      await api('/api/companies/order', { method: 'POST', body: { ids } });
      await load();
      window.dispatchEvent(new CustomEvent('local-coder:companies-changed'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  return <div className="focused-settings-page connections-settings-page context-settings-page">
    <header>
      <div><h1>Contexts</h1><p>Create, organize, archive or permanently delete the work contexts shown in the sidebar.</p></div>
      <button type="button" className="settings-save-button" onClick={() => openEditor(null)}><Plus size={14} />Add context</button>
    </header>

    <nav className="connections-surface-tabs" aria-label="Context status">
      <button type="button" className={view === 'active' ? 'active' : ''} onClick={() => setView('active')}>Active <span>{active.length}</span></button>
      <button type="button" className={view === 'archived' ? 'active' : ''} onClick={() => setView('archived')}>Archived <span>{archived.length}</span></button>
    </nav>

    <section className="connector-browser">
      <div className="connector-toolbar">
        <label className="connector-search"><Search size={14} /><input aria-label="Search contexts" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contexts" /></label>
      </div>
      {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}
      <div className="connection-list">
        {visible.map((company) => {
          const activeIndex = active.findIndex((item) => item.id === company.id);
          const disabled = busy !== undefined;
          return <article className="connection-card" key={company.id}>
            <div className="connection-card-main">
              <span className="connection-icon" style={{ color: company.color }}><CompanyIcon icon={company.icon} /></span>
              <div className="connection-copy">
                <div className="connection-title-row"><strong>{company.name}</strong><span>{company.archivedAt ? 'Archived' : `#${activeIndex + 1}`}</span></div>
                <small>{company.description || 'No description'}</small>
                <span className="connection-state">Updated {relative(company.updatedAt)}</span>
              </div>
              <div className="connection-actions">
                {!company.archivedAt ? <>
                  <button type="button" className="btn-secondary connection-refresh" aria-label={`Move ${company.name} up`} title="Move up" disabled={disabled || activeIndex <= 0} onClick={() => void move(company, -1)}><ArrowUp size={13} /></button>
                  <button type="button" className="btn-secondary connection-refresh" aria-label={`Move ${company.name} down`} title="Move down" disabled={disabled || activeIndex < 0 || activeIndex >= active.length - 1} onClick={() => void move(company, 1)}><ArrowDown size={13} /></button>
                  <button type="button" className="btn-secondary connection-refresh" disabled={disabled} onClick={() => openEditor(company)}><Pencil size={13} />Edit</button>
                  <button type="button" className="btn-secondary connection-refresh" disabled={disabled} onClick={() => void setArchived(company, true)}><Archive size={13} />Archive</button>
                  <button type="button" className="btn-secondary connection-refresh danger" disabled={disabled} onClick={() => requestDelete(company)}><Trash2 size={13} />Delete</button>
                </> : <>
                  <button type="button" className="btn-secondary connection-refresh" disabled={disabled} onClick={() => void setArchived(company, false)}><ArchiveRestore size={13} />Restore</button>
                  <button type="button" className="btn-secondary connection-refresh danger" disabled={disabled} onClick={() => requestDelete(company)}><Trash2 size={13} />Delete</button>
                </>}
              </div>
            </div>
          </article>;
        })}
        {visible.length === 0 ? <div className="settings-empty-state connection-empty-state">{query.trim() ? 'No contexts match your search.' : view === 'active' ? 'No contexts yet. Add one to create a stable work boundary.' : 'No archived contexts.'}</div> : null}
      </div>
    </section>

    {editing !== undefined ? <div className="nested-settings-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeEditor(); }}>
      <form className="nested-settings-dialog connection-create-dialog" onSubmit={(event) => void save(event)}>
        <header className="lc-shell-modal-title"><div><h2>{editing ? 'Edit context' : 'Add context'}</h2><p>The internal Context ID is generated once and remains stable when the display name changes.</p></div><button type="button" onClick={closeEditor} aria-label="Close"><X size={17} /></button></header>
        <label><span>Name</span><input required autoFocus maxLength={160} value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme Engineering" /></label>
        <label><span>Description <small>optional</small></span><textarea rows={4} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this context is for" /></label>
        <label><span>Color</span><input type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} /></label>
        <label><span>Icon</span><UiSelect ariaLabel="Context icon" value={icon} options={iconOptions} onChange={(value) => setIcon(value as CompanyIconId)} /></label>
        {notice ? <div className="settings-inline-message" role="status">{notice}</div> : null}
        <div className="nested-settings-dialog-actions"><button type="button" onClick={closeEditor}>Cancel</button><button className="settings-save-button" disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : editing ? 'Save context' : 'Create context'}</button></div>
      </form>
    </div> : null}

    <ShellDialog request={dialog} onClose={() => setDialog(undefined)} />
  </div>;
}
