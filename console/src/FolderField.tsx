import { useEffect, useId, useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';

const RECENTS_KEY = 'local-coder.recent-workspaces';

function recentWorkspaces(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

function rememberWorkspace(value: string) {
  const clean = value.trim();
  if (!clean) return;
  const next = [clean, ...recentWorkspaces().filter((item) => item !== clean)].slice(0, 5);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

export function FolderField({
  value,
  onChange,
  name,
  required,
  placeholder = '/Users/you/code/project',
  autoFocus = false
}: {
  value: string;
  onChange: (value: string) => void;
  name?: string;
  required?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const listId = useId();
  const [valid, setValid] = useState<boolean>();
  const [checking, setChecking] = useState(false);
  const recents = useMemo(recentWorkspaces, [value]);

  useEffect(() => {
    setValid(undefined);
  }, [value]);

  async function validate() {
    const clean = value.trim();
    if (!clean) {
      setValid(undefined);
      return;
    }
    setChecking(true);
    try {
      const response = await fetch(`/api/fs/exists?path=${encodeURIComponent(clean)}`, { headers: { accept: 'application/json' } });
      const body = (await response.json()) as { exists?: boolean; resolvedPath?: string };
      const exists = response.ok && body.exists === true;
      setValid(exists);
      if (exists) {
        const resolved = body.resolvedPath?.trim() || clean;
        if (resolved !== value) onChange(resolved);
        rememberWorkspace(resolved);
      }
    } catch {
      setValid(undefined);
    } finally {
      setChecking(false);
    }
  }

  async function browse() {
    const selected = await window.lc?.pickDirectory(value.trim() || undefined);
    if (!selected) return;
    onChange(selected);
    rememberWorkspace(selected);
    setValid(true);
  }

  return <div className={`path-field ${valid === false ? 'invalid' : ''}`}>
    <input
      name={name}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => void validate()}
      placeholder={placeholder}
      required={required}
      autoFocus={autoFocus}
      list={window.lc ? undefined : listId}
      aria-invalid={valid === false}
    />
    {!window.lc ? <datalist id={listId}>{recents.map((item) => <option key={item} value={item} />)}</datalist> : null}
    {window.lc ? <button className="path-browse-button" type="button" onClick={() => void browse()}><FolderOpen size={14} /><span>Browse…</span></button> : null}
    {checking ? <small className="path-field-status">Checking…</small> : valid === false ? <small className="path-field-status error">Folder not found</small> : null}
  </div>;
}
