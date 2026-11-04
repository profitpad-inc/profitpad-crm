import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { MapPin } from 'lucide-react';
import { api, type Property } from '../lib/api';

// Address autocomplete (api/src/address.ts, Settings → Address autocomplete).
// The street box of an address group suggests addresses from Google Places as
// people type; picking one fills the group's other properties too, through
// PropertyInput's onFill. The Google key stays on the API server.

export interface AddressGroup {
  object: string;
  street_1: string;
  street_2?: string;
  city?: string;
  province?: string;
  postal_code?: string;
  country?: string;
}

interface AddressConfig { enabled: boolean; groups: AddressGroup[] }

export interface PlaceAddress {
  street_1: string;
  street_2: string;
  city: string;
  province_code: string;
  province_name: string;
  postal_code: string;
  country_code: string;
  country_name: string;
  formatted: string;
}

interface Suggestion { place_id: string; main: string; secondary: string; label: string }

// ---- config, loaded once per page load ----

let configPromise: Promise<AddressConfig> | null = null;
let configValue: AddressConfig | null = null;
const listeners = new Set<(c: AddressConfig) => void>();

function loadConfig(): Promise<AddressConfig> {
  configPromise ??= api<AddressConfig>('GET', '/v1/address/config')
    .catch(() => ({ enabled: false, groups: [] }))
    .then((c) => {
      configValue = c;
      listeners.forEach((l) => l(c));
      return c;
    });
  return configPromise;
}

// after Settings → Address autocomplete is saved
export function reloadAddressConfig(): void {
  configPromise = null;
  void loadConfig();
}

function useAddressConfig(object: string | undefined): AddressConfig | null {
  const [config, setConfig] = useState<AddressConfig | null>(configValue);
  useEffect(() => {
    if (!object) return;
    listeners.add(setConfig);
    void loadConfig().then(setConfig);
    return () => { listeners.delete(setConfig); };
  }, [object]);
  return object ? config : null;
}

// The address group whose street box this property is, when autocomplete is on.
export function useAddressGroup(object: string | undefined, property: string): AddressGroup | null {
  const config = useAddressConfig(object);
  if (!config?.enabled) return null;
  return config.groups.find((g) => g.object === object && g.street_1 === property) ?? null;
}

// This object's address groups, whether or not autocomplete is on.
export function useAddressGroups(object: string | undefined): AddressGroup[] {
  const config = useAddressConfig(object);
  return config?.groups.filter((g) => g.object === object) ?? [];
}

const GROUP_ORDER = ['street_1', 'street_2', 'city', 'province', 'postal_code', 'country'] as const;

// Properties in their usual order, except that each address group's
// properties sit together, street to country, where the first of them was.
export function withAddressesTogether<P extends { api_name: string }>(props: P[], groups: AddressGroup[]): P[] {
  let out = props;
  for (const g of groups) {
    const names = GROUP_ORDER.map((k) => g[k]).filter((n): n is string => !!n);
    const members = names.map((n) => out.find((p) => p.api_name === n)).filter((p): p is P => !!p);
    if (members.length < 2) continue;
    const at = out.findIndex((p) => members.includes(p));
    const rest = out.filter((p) => !members.includes(p));
    const before = out.slice(0, at).filter((p) => !members.includes(p)).length;
    out = [...rest.slice(0, before), ...members, ...rest.slice(before)];
  }
  return out;
}

// ---- picked address → input values ----

// The group's properties as input strings (PropertyInput's format). A
// dropdown province or country takes the option whose value is Google's code
// or whose label is its name; with no such option it is left as it is.
// Street 2 is only set when Google has one (a typed suite stays otherwise).
export function addressValues(group: AddressGroup, a: PlaceAddress, properties: Property[], fallbackStreet: string): Record<string, string> {
  const out: Record<string, string> = {};
  const byName = (n?: string) => (n ? properties.find((p) => p.api_name === n && p.record_status === 'active') : undefined);
  const text = (n: string | undefined, v: string) => {
    if (byName(n)) out[n!] = v;
  };
  const choice = (n: string | undefined, code: string, name: string, textValue: string) => {
    const p = byName(n);
    if (!p) return;
    if (p.type !== 'dropdown') {
      out[p.api_name] = textValue;
      return;
    }
    const opts = (p.dropdown_options ?? []).filter((o) => o.record_status === 'active');
    const hit = opts.find((o) => code && o.api_value.toLowerCase() === code.toLowerCase())
      ?? opts.find((o) => name && o.label.toLowerCase() === name.toLowerCase());
    if (hit) out[p.api_name] = hit.api_value;
    else if (!code && !name) out[p.api_name] = '';
  };
  out[group.street_1] = a.street_1 || fallbackStreet;
  if (a.street_2) text(group.street_2, a.street_2);
  text(group.city, a.city);
  text(group.postal_code, a.postal_code);
  choice(group.province, a.province_code, a.province_name, a.province_code);
  choice(group.country, a.country_code, a.country_name, a.country_name);
  return out;
}

// ---- the box ----

const newSession = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`.replace(/\D/g, '')).replace(/-/g, '');

export function AddressInput({ value, onChange, onPick, autoFocus, onFocus, onCommit, onBlur }: {
  value: string;
  onChange: (v: string) => void;
  // the picked address; the caller fills the group
  onPick: (address: PlaceAddress, suggestion: Suggestion) => void;
  autoFocus?: boolean;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
  // Enter with no suggestion highlighted
  onCommit?: () => void;
  onBlur?: () => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const session = useRef(newSession());
  const typed = useRef(false); // only typing asks Google, not the starting value
  const seq = useRef(0);
  const picking = useRef(false);

  useEffect(() => {
    if (!typed.current) return;
    const q = value.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const n = ++seq.current;
    const t = window.setTimeout(async () => {
      try {
        const res = await api<{ suggestions: Suggestion[] }>('POST', '/v1/address/autocomplete', { query: q, session: session.current });
        if (n !== seq.current) return;
        setSuggestions(res.suggestions);
        setActive(-1);
        setOpen(res.suggestions.length > 0 && document.activeElement === inputRef.current);
        setError(null);
      } catch (err) {
        if (n === seq.current) setError((err as Error).message);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [value]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => inputRef.current && setRect(inputRef.current.getBoundingClientRect());
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  async function pick(s: Suggestion) {
    picking.current = true;
    setOpen(false);
    seq.current++; // drop any answer still on its way
    typed.current = false;
    onChange(s.main);
    try {
      const res = await api<{ address: PlaceAddress }>('POST', '/v1/address/details', { place_id: s.place_id, session: session.current });
      onPick(res.address, s);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      session.current = newSession(); // a details call ends Google's session
      picking.current = false;
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open && suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1)); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setOpen(false); return; }
      if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopPropagation(); void pick(suggestions[active]); return; }
    }
    if (e.key === 'Enter' && onCommit) onCommit();
  }

  const style: CSSProperties | undefined = rect
    ? { top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 280) }
    : undefined;

  return (
    <>
      <input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        onFocus={onFocus}
        onChange={(e) => { typed.current = true; onChange(e.target.value); }}
        onKeyDown={onKey}
        onBlur={() => {
          setOpen(false);
          // leaving by picking a suggestion is not leaving: onPick saves
          if (!picking.current) onBlur?.();
        }}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {error && <div className="error-text small">{error}</div>}
      {open && rect && createPortal(
        <div
          className="menu select-menu address-menu"
          style={style}
          // keep focus in the box so leaving it does not save half an address
          onMouseDown={(e) => { e.preventDefault(); picking.current = true; }}
          onMouseUp={() => { picking.current = false; }}
        >
          <div className="select-options" role="listbox">
            {suggestions.map((s, i) => (
              <button
                key={s.place_id}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)}
                onClick={() => void pick(s)}
              >
                <MapPin size={14} aria-hidden />
                <span className="address-option">
                  <span>{s.main}</span>
                  {s.secondary && <span className="muted small">{s.secondary}</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="address-credit muted small">Suggestions from Google</div>
        </div>,
        document.body
      )}
    </>
  );
}
