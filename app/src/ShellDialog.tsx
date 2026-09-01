import { useEffect, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';

/**
 * An in-app prompt or confirmation.
 *
 * window.prompt and window.confirm worked, but they render as system sheets:
 * unstyled, positioned by the OS, and visibly a different program from the one
 * around them. They also block the renderer, so nothing can update underneath.
 */
export type ShellDialogRequest =
  | {
      kind: 'prompt';
      title: string;
      label: string;
      value: string;
      confirmLabel: string;
      placeholder?: string;
      onConfirm: (value: string) => void;
    }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
    };

export function ShellDialog({
  request,
  onClose
}: {
  request?: ShellDialogRequest;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Seed from the request rather than at mount: the same dialog instance is
  // reused for the next rename, and a stale value would be pre-filled.
  useEffect(() => {
    if (request?.kind !== 'prompt') return;
    setValue(request.value);
    // Select the current name so typing replaces it, as a rename should.
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request, onClose]);

  if (!request) return null;

  const canConfirm = request.kind === 'confirm' || value.trim().length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canConfirm) return;
    // Close first: onConfirm starts an async mutation, and leaving the dialog
    // up until it resolves reads as a stuck button.
    onClose();
    if (request.kind === 'prompt') request.onConfirm(value.trim());
    else request.onConfirm();
  }

  return <div
    className="lc-shell-modal-backdrop"
    role="presentation"
    onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}
  >
    <form className="shell-dialog" role="dialog" aria-modal="true" aria-label={request.title} onSubmit={submit}>
      <div className="lc-shell-modal-title">
        <h2 className="dialog-title">{request.title}</h2>
        <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>

      {request.kind === 'prompt'
        ? <label>
            <span>{request.label}</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
              autoFocus
            />
          </label>
        : <p className="shell-dialog-message">{request.message}</p>}

      <div className="lc-shell-modal-actions">
        <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>
        <button
          className={`btn-primary ${request.kind === 'confirm' && request.danger ? 'danger' : ''}`}
          disabled={!canConfirm}
        >{request.confirmLabel}</button>
      </div>
    </form>
  </div>;
}
