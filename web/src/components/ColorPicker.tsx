import { useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { HexColorInput, HexColorPicker } from 'react-colorful';
import { Menu } from './ui';
import { useApp } from '../lib/app-context';
import { dropdownColorName } from '../lib/theme';


// A swatch button that opens the portal's 16 dropdown colours (Settings, Theme), a custom colour and "No
// colour". value is #rrggbb (lowercase) or null.
export function ColorPicker({ value, onChange, label = 'Colour' }: { value: string | null; onChange: (v: string | null) => void; label?: string }) {
  const { dropdownColors } = useApp();
  const custom = value !== null && !dropdownColors.includes(value);
  const [showCustom, setShowCustom] = useState(custom);
  return (
    <Menu
      trigger={(open) => (
        <button
          type="button"
          className={`color-swatch trigger${value ? '' : ' none'}`}
          style={value ? { background: value } : undefined}
          onClick={() => { setShowCustom(custom); open(); }}
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
          <button type="button" className={`color-custom-toggle${custom ? ' selected' : ''}`} onClick={() => setShowCustom((v) => !v)} aria-expanded={showCustom}>
            <span className="color-swatch" style={custom ? { background: value! } : undefined} />
            Custom colour
            {showCustom ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {showCustom && <HexPicker value={value ?? '#3b82f6'} onChange={onChange} />}
          <button type="button" className="color-clear" onClick={() => { onChange(null); close(); }} disabled={value === null}>
            No colour
          </button>
        </div>
      )}
    </Menu>
  );
}

// Saturation square, hue bar and a hex box (react-colorful). Gives lowercase #rrggbb.
export function HexPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <div className="hex-picker">
      <HexColorPicker color={value} onChange={(c) => onChange(c.toLowerCase())} />
      <label className="hex-picker-input">
        <span>#</span>
        <HexColorInput color={value} onChange={(c) => onChange(c.toLowerCase())} aria-label="Hex colour" />
      </label>
    </div>
  );
}

// A swatch that opens HexPicker in a popover, in place of <input type="color">.
export function ColorInput({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  return (
    <Menu
      trigger={(open) => (
        <button type="button" className="color-swatch trigger color-input" style={{ background: value }} onClick={open} aria-label={`${label}: ${value}`} title={label} />
      )}
    >
      {() => <HexPicker value={value} onChange={onChange} />}
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
