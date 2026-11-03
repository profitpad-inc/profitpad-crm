import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// A single-choice dropdown drawn like the app's menus (Menu in ui.tsx): a
// field-like button that opens a list of choices on <body>, so scrolling
// containers cannot clip it. Used for every dropdown in the app and in custom
// views (view-runtime/kit.tsx), so it has no imports beyond React.
//
// Choices come from `options` or from <option> children (inside fragments or
// <optgroup>s too), so it reads like a native <select>. Lists longer than 10
// get a search box. Keyboard: arrows, Home/End, Enter, Escape, and typing a
// letter jumps to the next choice starting with it. onBlur fires when focus
// leaves both the button and the open list, like a native select's blur.

export interface SelectOption { value: string; label: string; disabled?: boolean }

const SEARCH_FROM = 11;

function optionsFrom(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  const walk = (nodes: ReactNode) => Children.forEach(nodes, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ children?: ReactNode; value?: string | number; disabled?: boolean }>;
    if (el.type === Fragment || el.type === 'optgroup') walk(el.props.children);
    else if (el.type === 'option') {
      const label = Children.toArray(el.props.children).join('');
      out.push({ value: String(el.props.value ?? label), label, disabled: el.props.disabled });
    }
  });
  walk(children);
  return out;
}

export function Select({ value: raw, onChange, options, children, id, className, style, disabled, autoFocus, onBlur, title, face, search, 'aria-label': ariaLabel }: {
  value: string | number; onChange: (value: string) => void; options?: SelectOption[]; children?: ReactNode;
  id?: string; className?: string; style?: CSSProperties; disabled?: boolean; autoFocus?: boolean; onBlur?: () => void; title?: string;
  // shown on the closed button instead of the picked choice's label
  face?: ReactNode;
  // force the search box on or off (default: on for long lists)
  search?: boolean;
  'aria-label'?: string;
}) {
  const value = String(raw);
  const all = options ?? optionsFrom(children);
  const current = all.find((o) => o.value === value);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const faceRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const open = rect !== null;
  const searchable = search ?? all.length >= SEARCH_FROM;
  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all;

  const close = () => setRect(null);
  const openList = () => {
    if (disabled || !faceRef.current) return;
    setQuery('');
    setActive(Math.max(0, all.findIndex((o) => o.value === value)));
    setRect(faceRef.current.getBoundingClientRect());
  };
  const pick = (o: SelectOption | undefined) => {
    if (!o || o.disabled) return;
    close();
    faceRef.current?.focus();
    if (o.value !== value) onChange(o.value);
  };
  const leave = (e: React.FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && (faceRef.current?.contains(to) || popRef.current?.contains(to))) return;
    close();
    onBlur?.();
  };

  useEffect(() => {
    if (!open) return;
    if (searchable) searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!faceRef.current?.contains(t) && !popRef.current?.contains(t)) close();
    };
    const onScroll = (e: Event) => {
      if (!popRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, searchable]);

  // keep the list inside the window when it is wider than the button
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop || !rect) return;
    const over = rect.left + pop.offsetWidth - (window.innerWidth - 8);
    pop.style.left = `${Math.max(8, over > 0 ? rect.left - over : rect.left)}px`;
  }, [rect, shown.length]);

  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const move = (from: number, step: number) => {
    for (let i = from + step; i >= 0 && i < shown.length; i += step) if (!shown[i].disabled) return setActive(i);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(active, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(active, -1); }
    else if (e.key === 'Home') { e.preventDefault(); move(-1, 1); }
    else if (e.key === 'End') { e.preventDefault(); move(shown.length, -1); }
    else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) { e.preventDefault(); pick(shown[active]); }
    else if (e.key === 'Escape') {
      // stops a modal around it closing too
      e.preventDefault();
      e.stopPropagation();
      close();
      faceRef.current?.focus();
    }
    else if (e.key === 'Tab') { close(); faceRef.current?.focus(); }
    else if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      const n = shown.length;
      for (let s = 1; s <= n; s++) {
        const i = (active + s) % n;
        if (!shown[i].disabled && shown[i].label.toLowerCase().startsWith(k)) return setActive(i);
      }
    }
  };

  const below = rect ? window.innerHeight - rect.bottom - 8 : 0;
  const above = rect ? rect.top - 8 : 0;
  const up = below < 240 && above > below;
  const popStyle: CSSProperties | undefined = rect
    ? {
        left: rect.left,
        minWidth: rect.width,
        maxHeight: Math.min(340, up ? above - 4 : below - 4),
        ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 })
      }
    : undefined;

  return (
    <>
      <button
        type="button"
        ref={faceRef}
        id={id}
        className={`select-face${className ? ` ${className}` : ''}`}
        style={style}
        title={title}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKey}
        onBlur={leave}
      >
        <span className="select-face-label">{face ?? current?.label ?? value}</span>
      </button>
      {rect &&
        createPortal(
          <div
            className="menu select-menu"
            ref={popRef}
            style={popStyle}
            onBlur={leave}
            onKeyDown={onKey}
            // clicks inside keep focus where it is (the button or the search box)
            onMouseDown={(e) => e.target !== searchRef.current && e.preventDefault()}
          >
            {searchable && (
              <input
                ref={searchRef}
                className="select-search"
                value={query}
                placeholder="Search"
                aria-label="Search"
                onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              />
            )}
            <div className="select-options" role="listbox" aria-label={ariaLabel} ref={listRef}>
              {shown.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={o.value === value}
                  disabled={o.disabled}
                  className={`${i === active ? 'active' : ''}${o.value === value ? ' selected' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                >
                  <span>{o.label || ' '}</span>
                  {o.value === value && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
            {shown.length === 0 && <p className="select-none">No matches</p>}
          </div>,
          document.body
        )}
    </>
  );
}
