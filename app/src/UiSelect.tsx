import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface UiSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function UiSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Select'
}: {
  value: string;
  options: UiSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return <div className="ui-select" ref={root}>
    <button
      type="button"
      className="ui-select-trigger"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    >
      <span>{selected?.label ?? placeholder}</span>
      <ChevronDown size={13} />
    </button>
    {open ? <div className="ui-select-popover" role="listbox" aria-label={ariaLabel}>
      {options.map((option) => <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={option.value === value}
        disabled={option.disabled}
        className={option.value === value ? 'selected' : ''}
        onClick={() => {
          onChange(option.value);
          setOpen(false);
        }}
      >
        <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
        {option.value === value ? <Check size={14} /> : null}
      </button>)}
    </div> : null}
  </div>;
}
