import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';

// A single-choice dropdown with a search box at the top of its list. Keyboard:
// type to filter, arrow keys to move, Enter to pick, Escape to close. Closes
// on outside clicks.
export function SearchSelect({ value, options, onChange, ariaLabel, className }: {
  value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; ariaLabel: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    searchRef.current?.focus();
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, options, value]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className={`search-select${className ? ` ${className}` : ''}`} ref={boxRef}>
      <button type="button" className="search-select-face" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{current?.label ?? value}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="search-select-pop">
          <div className="search-select-search">
            <input
              ref={searchRef}
              value={query}
              placeholder="Search"
              aria-label="Search"
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active].value); }
                else if (e.key === 'Escape') setOpen(false);
              }}
            />
            <Search size={15} />
          </div>
          <ul role="listbox" ref={listRef}>
            {shown.length === 0 && <li className="search-select-none">No matches</li>}
            {shown.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`${i === active ? 'active' : ''}${o.value === value ? ' selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}
              >
                {o.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
