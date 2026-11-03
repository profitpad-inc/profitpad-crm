import { useState, type CSSProperties, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Menu } from './ui';

// The 16 preset colours offered for dropdown choices. Any other #rrggbb can
// be picked with the custom colour input.
export const PRESET_COLORS: { value: string; name: string }[] = [
  { value: '#ef4444', name: 'Red' },
  { value: '#f97316', name: 'Orange' },
  { value: '#f59e0b', name: 'Amber' },
  { value: '#eab308', name: 'Yellow' },
  { value: '#84cc16', name: 'Lime' },
  { value: '#22c55e', name: 'Green' },
  { value: '#10b981', name: 'Emerald' },
  { value: '#14b8a6', name: 'Teal' },
  { value: '#06b6d4', name: 'Cyan' },
  { value: '#0ea5e9', name: 'Sky' },
  { value: '#3b82f6', name: 'Blue' },
  { value: '#6366f1', name: 'Indigo' },
  { value: '#8b5cf6', name: 'Violet' },
  { value: '#d946ef', name: 'Fuchsia' },
  { value: '#ec4899', name: 'Pink' },
  { value: '#6b7280', name: 'Gray' }
];

const HEX = /^#[0-9a-f]{6}$/i;

// A swatch button that opens the preset colours, a custom colour and "No
// colour". value is #rrggbb (lowercase) or null.
export function ColorPicker({ value, onChange, label = 'Colour' }: { value: string | null; onChange: (v: string | null) => void; label?: string }) {
  const [text, setText] = useState(value ?? '');
  const custom = value !== null && !PRESET_COLORS.some((c) => c.value === value);
  return (
    <Menu
      trigger={(open) => (
        <button
          type="button"
          className={`color-swatch trigger${value ? '' : ' none'}`}
          style={value ? { background: value } : undefined}
          onClick={() => { setText(value ?? ''); open(); }}
          aria-label={`${label}: ${value ? PRESET_COLORS.find((c) => c.value === value)?.name ?? value : 'none'}`}
          title={label}
        />
      )}
    >
      {(close) => (
        <div className="color-menu">
          <div className="color-grid">
            {PRESET_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className="color-swatch"
                style={{ background: c.value }}
                title={c.name}
                aria-label={c.name}
                onClick={() => { onChange(c.value); close(); }}
              >
                {c.value === value && <Check size={14} color="#fff" strokeWidth={3} />}
              </button>
            ))}
          </div>
          <div className="color-custom">
            <input
              type="color"
              value={value ?? '#3b82f6'}
              onChange={(e) => { onChange(e.target.value.toLowerCase()); setText(e.target.value.toLowerCase()); }}
              aria-label="Custom colour"
              className={custom ? 'selected' : undefined}
            />
            <input
              className="mono"
              value={text}
              placeholder="#rrggbb"
              maxLength={7}
              aria-label="Custom colour as hex"
              onChange={(e) => {
                const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
                setText(v);
                if (HEX.test(v)) onChange(v.toLowerCase());
              }}
            />
          </div>
          <button type="button" className="color-clear" onClick={() => { onChange(null); close(); }} disabled={value === null}>
            No colour
          </button>
        </div>
      )}
    </Menu>
  );
}

// A dropdown value as a pill in its choice's colour.
export function ColorPill({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="color-pill" style={{ '--pill': color } as CSSProperties}>
      {children}
    </span>
  );
}
