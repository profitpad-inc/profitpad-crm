import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { API_BASE, type Property } from '../lib/api';
import { composePhone, loadPhoneRegions, regionForNumber, regionLabel, type PhoneRegions } from '../public/phone-regions';
import { displayPhone, valueType } from '../lib/display';
import { DatePicker } from './DatePicker';

export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Small menu anchored to a trigger; closes on outside click, Escape, scroll
// or resize. The popup is rendered on <body> with fixed positioning so
// scrolling containers (tab strip, table) can't clip it.
export function Menu({ trigger, children, align = 'left' }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = rect !== null;
  useEffect(() => {
    if (!open) return;
    const close = () => setRect(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);
  const toggle = () => setRect((r) => (r ? null : anchorRef.current?.getBoundingClientRect() ?? null));
  const style: CSSProperties | undefined = rect
    ? align === 'right'
      ? { top: rect.bottom + 4, right: Math.max(window.innerWidth - rect.right, 8) }
      : { top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 228) }
    : undefined;
  return (
    <div className="menu-anchor" ref={anchorRef}>
      {trigger(toggle)}
      {rect &&
        createPortal(
          <div className="menu" ref={menuRef} style={style}>
            {children(() => setRect(null))}
          </div>,
          document.body
        )}
    </div>
  );
}

// Converts between API values and form input strings for one property.
export function toInput(p: Property, v: unknown): string {
  if (v === null || v === undefined) return '';
  const t = valueType(p);
  if (t === 'datetime') {
    const d = new Date(String(v));
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  if (Array.isArray(v)) return v.join(';');
  if (p.type === 'text' && p.options.display === 'phone' && typeof v === 'string') return displayPhone(v);
  return String(v);
}

export function fromInput(p: Property, s: string): unknown {
  if (s.trim() === '') return null;
  const t = valueType(p);
  if (t === 'number') return Number(s);
  if (t === 'datetime') return new Date(s).toISOString();
  if (p.type === 'dropdown' && p.options.single_value !== true) return s.split(';').filter(Boolean);
  return s;
}

export function PropertyInput({ property, value, onChange, autoFocus, onCommit }: {
  property: Property; value: string; onChange: (v: string) => void; autoFocus?: boolean; onCommit?: (value?: string) => void;
}) {
  const t = valueType(property);
  const selectAll = autoFocus ? (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => e.currentTarget.select() : undefined;
  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && onCommit) onCommit();
  };
  const blur = () => onCommit?.();
  if (property.type === 'dropdown') {
    const options = (property.dropdown_options ?? []).filter((o) => o.row_status === 'active' || value.split(';').includes(o.api_value));
    if (property.options.single_value === true) {
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onBlur={blur}>
          <option value="">None</option>
          {options.map((o) => (
            <option key={o.api_value} value={o.api_value}>{o.label}</option>
          ))}
        </select>
      );
    }
    const selected = new Set(value.split(';').filter(Boolean));
    return (
      <div className="checks">
        {options.map((o) => (
          <label key={o.api_value}>
            <input
              type="checkbox"
              checked={selected.has(o.api_value)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(o.api_value);
                else next.delete(o.api_value);
                onChange([...next].join(';'));
              }}
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  }
  if (property.type === 'text' && property.options.display === 'phone') {
    return <PhoneInput value={value} onChange={onChange} autoFocus={autoFocus} onCommit={onCommit} />;
  }
  if (t === 'number') return <input type="number" step="any" value={value} onFocus={selectAll} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onKeyDown={keyDown} onBlur={blur} />;
  if (t === 'date' || t === 'datetime') {
    return <DatePicker value={value} onChange={onChange} withTime={t === 'datetime'} autoFocus={autoFocus} onCommit={onCommit} />;
  }
  if (property.options.single_line === true || property.is_base) {
    return <input value={value} onFocus={selectAll} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onKeyDown={keyDown} onBlur={blur} />;
  }
  return <textarea rows={3} value={value} onFocus={selectAll} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} onBlur={blur} />;
}

export function isEditable(p: Property): boolean {
  if (p.row_status !== 'active' || p.type === 'calculation' || p.type === 'file') return false;
  if (p.is_base) return p.api_name === 'name' || p.api_name === 'created_at';
  return !p.read_only;
}

// Phone properties: a country picker and the number. A number typed without
// + gets the picked country's code in front (composePhone); the API checks
// it with Google's libphonenumber and stores +16132220328ext4. Commits when
// focus leaves both controls, not when moving between them.
export function PhoneInput({ value, onChange, autoFocus, onCommit }: {
  value: string; onChange: (v: string) => void; autoFocus?: boolean; onCommit?: (value?: string) => void;
}) {
  const [regions, setRegions] = useState<PhoneRegions | null>(null);
  const [region, setRegion] = useState<string>('');
  const [text, setText] = useState(value);

  useEffect(() => {
    loadPhoneRegions(API_BASE).then((r) => {
      setRegions(r);
      setRegion((cur) => cur || (regionForNumber(value, r.regions, r.default) ?? r.default));
    }).catch(() => undefined);
    // only the starting value picks the region
  }, []);

  const picked = regions?.regions.find((r) => r.region === region);
  const emit = (t: string, r = picked) => {
    const composed = composePhone(t, r);
    onChange(composed);
    return composed;
  };
  return (
    <div
      className="phone-input"
      onBlur={(e) => {
        if (onCommit && !e.currentTarget.contains(e.relatedTarget as Node | null)) onCommit(composePhone(text, picked));
      }}
    >
      {regions && (
        <select
          value={region}
          aria-label="Country"
          onChange={(e) => {
            setRegion(e.target.value);
            emit(text, regions.regions.find((r) => r.region === e.target.value));
          }}
        >
          {regions.regions.map((r) => <option key={r.region} value={r.region}>{regionLabel(r)}</option>)}
        </select>
      )}
      <input
        type="tel"
        value={text}
        autoFocus={autoFocus}
        placeholder="613-222-0328 ext4"
        onChange={(e) => {
          setText(e.target.value);
          emit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onCommit) onCommit(composePhone(text, picked));
        }}
      />
    </div>
  );
}
