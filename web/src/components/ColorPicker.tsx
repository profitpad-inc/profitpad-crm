import { useState, type CSSProperties, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Menu } from './ui';
import { useApp } from '../lib/app-context';
import { dropdownColorName } from '../lib/theme';


const HEX = /^#[0-9a-f]{6}$/i;

// A swatch button that opens the portal's 16 dropdown colours (Settings, Theme), a custom colour and "No
// colour". value is #rrggbb (lowercase) or null.
export function ColorPicker({ value, onChange, label = 'Colour' }: { value: string | null; onChange: (v: string | null) => void; label?: string }) {
  const { dropdownColors } = useApp();
  const [text, setText] = useState(value ?? '');
  const custom = value !== null && !dropdownColors.includes(value);
  return (
    <Menu
      trigger={(open) => (
        <button
          type="button"
          className={`color-swatch trigger${value ? '' : ' none'}`}
          style={value ? { background: value } : undefined}
          onClick={() => { setText(value ?? ''); open(); }}
          aria-label={`${label}: ${value ? (dropdownColors.includes(value) ? dropdownColorName(value, dropdownColors.indexOf(value)) : value) : 'none'}`}
          title={label}
        />
      )}
    >
      {(close) => (
        <div className="color-menu">
          <div className="color-grid">
            {dropdownColors.map((c, i) => (
              <button
                key={i}
                type="button"
                className="color-swatch"
                style={{ background: c }}
                title={dropdownColorName(c, i)}
                aria-label={dropdownColorName(c, i)}
                onClick={() => { onChange(c); close(); }}
              >
                {c === value && <Check size={14} color="#fff" strokeWidth={3} />}
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
