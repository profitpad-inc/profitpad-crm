import { useLayoutEffect, useRef, useState } from 'react';
import { Plus, Star, Trash2 } from 'lucide-react';
import { Select } from './Select';
import { confirmDialog } from './confirm';
import { PhoneInput, type PhoneSource } from './PhoneInput';
import { displayPhone } from '../lib/display';
import { MAX_LABEL, MULTI_LABELS, decodeEntries, encodeEntries, entriesOf, labelText, type MultiEntry, type MultiType } from '../lib/multi-values';

// Email and phone properties: a small table of addresses or numbers, each
// with an optional label (Work, Cell, ... or custom text). The first row is
// the primary.

// +1 613-222-0321 ext9 and +16132220321ext9 are the same number
const phoneKey = (v: string) => v.toLowerCase().replace(/ext|x/, 'x').replace(/[^0-9x+]/g, '');
const shownValue =(type: MultiType, value: string) => (type === 'phone' ? displayPhone(value) : value);

// Before saving an email or phone list: when the primary (first entry)
// becomes a different value, asks first, since the CRM sends to the primary.
// true when there is nothing to ask or the user agreed.
export async function confirmPrimaryChange(type: MultiType, before: unknown, after: unknown): Promise<boolean> {
  const was = entriesOf(before)[0]?.value;
  const next = entriesOf(after)[0]?.value;
  if (!was || !next || was === next) return true;
  const noun = type === 'email' ? 'email' : 'phone number';
  return confirmDialog(
    type === 'email'
      ? `${next} will become the primary email instead of ${was}. Emails and campaigns from the CRM go to the primary address.`
      : `${displayPhone(next)} will become the primary phone number instead of ${displayPhone(was)}.`,
    { title: `Change the primary ${noun}?`, confirmLabel: 'Make primary' }
  );
}

// Read-only: one row per entry: the value, then its label.
export function MultiValueTable({ type, value }: { type: MultiType; value: unknown }) {
  const list = entriesOf(value);
  if (list.length === 0) return <span className="muted empty-value">--</span>;
  return (
    <table className="mv-table">
      <tbody>
        {list.map((e, i) => (
          <tr key={e.value}>
            <td className="mv-value">
              {/* plain text: a click on the row opens the editor */}
              <span>{shownValue(type, e.value)}</span>
              {i === 0 && list.length > 1 && <span className="mv-primary">Primary</span>}
            </td>
            <td className="mv-label">{labelText(e.label)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Row extends MultiEntry {
  id: number;
  // the label picker is on "Custom…" (a text box for the label)
  custom: boolean;
}

const CUSTOM = '__custom';

// Marks a value box whose text runs past its edges (data-clip left, right
// or both), so the CSS can fade the side that is cut off.
function markClipped(input: HTMLInputElement) {
  const left = input.scrollLeft > 1;
  const right = input.scrollLeft + input.clientWidth < input.scrollWidth - 1;
  const clip = left && right ? 'both' : left ? 'left' : right ? 'right' : '';
  if (clip) input.dataset.clip = clip;
  else delete input.dataset.clip;
}
const valueInputs = (el: HTMLElement | null) => (el ? [...el.querySelectorAll<HTMLInputElement>('.mv-value input')] : []);

// Editing: rows of value, label, make primary and remove, then "+ Add".
// value and onChange carry the list as JSON (encodeEntries), like every
// property editor's one string; the caller saves it.
export function MultiValueEditor({ type, value, onChange, autoFocus, phoneSource, onSave, onCancel }: {
  type: MultiType;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  phoneSource: PhoneSource;
  // Enter in a box (the record page saves; the create form has no onSave)
  onSave?: () => void;
  onCancel?: () => void;
}) {
  const nextId = useRef(0);
  const presets = MULTI_LABELS[type];
  const toRow = (e: MultiEntry): Row => ({ ...e, id: nextId.current++, custom: !!e.label && !presets.some((p) => p.key === e.label) });
  const [rows, setRows] = useState<Row[]>(() => {
    const list = decodeEntries(value).map(toRow);
    return list.length ? list : [toRow({ value: '' })];
  });
  const [focusId, setFocusId] = useState<number | null>(autoFocus ? rows[0]?.id ?? null : null);

  // a typed label that names a preset ("work", "Mobile ") is that preset
  const presetFor = (label: string | undefined) => {
    const t = label?.trim().toLowerCase();
    return t ? presets.find((p) => p.key.toLowerCase() === t || p.label.toLowerCase() === t) : undefined;
  };
  const update = (next: Row[]) => {
    setRows(next);
    onChange(encodeEntries(next.map((r) => {
      const preset = r.custom ? presetFor(r.label) : undefined;
      return preset ? { ...r, label: preset.key } : r;
    })));
  };
  const set = (id: number, patch: Partial<Row>) => update(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () => {
    const row = toRow({ value: '' });
    setFocusId(row.id);
    update([...rows, row]);
  };
  const remove = (id: number) => {
    const next = rows.filter((r) => r.id !== id);
    update(next.length ? next : [toRow({ value: '' })]);
  };
  const makePrimary = (id: number) => {
    const row = rows.find((r) => r.id === id);
    if (row) update([row, ...rows.filter((r) => r.id !== id)]);
  };
  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && onSave) {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };
  // fade cut-off text: after edits, resizes, scrolling and caret moves
  const editorRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    valueInputs(editorRef.current).forEach(markClipped);
  }, [rows]);
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => valueInputs(el).forEach(markClipped));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const recheck = (e: React.SyntheticEvent) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.closest('.mv-value')) requestAnimationFrame(() => markClipped(t));
  };

  const noun = type === 'email' ? 'email' : 'phone';
  const filled = rows.filter((r) => r.value.trim() !== '').length;

  return (
    <div
      className="mv-editor" ref={editorRef} onKeyDown={keyDown}
      onKeyUp={recheck} onMouseUp={recheck} onInput={recheck} onFocus={recheck} onBlur={recheck} onScrollCapture={recheck}
    >
      <table className="mv-table editing">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td className="mv-value">
                {type === 'phone' ? (
                  <PhoneInput
                    value={r.value ? displayPhone(r.value) : ''}
                    // the box reports the number formatted after checking it;
                    // the same number keeps its stored form, so nothing looks changed
                    onChange={(v) => { if (phoneKey(v) !== phoneKey(r.value)) set(r.id, { value: v }); }}
                    autoFocus={focusId === r.id}
                    source={phoneSource}
                    check
                  />
                ) : (
                  <input
                    type="text" inputMode="email" autoCapitalize="none" value={r.value} placeholder="name@example.com" autoFocus={focusId === r.id}
                    onChange={(e) => set(r.id, { value: e.target.value })}
                    aria-label={`Email ${i + 1}`}
                  />
                )}
              </td>
              <td className="mv-label">
                {r.custom ? (
                  <input
                    value={r.label ?? ''} maxLength={MAX_LABEL} placeholder="Label" autoFocus={r.custom && !r.label}
                    onChange={(e) => set(r.id, { label: e.target.value })}
                    onBlur={() => {
                      const preset = presetFor(r.label);
                      if (preset) set(r.id, { custom: false, label: preset.key });
                      else if (!r.label?.trim()) set(r.id, { custom: false, label: undefined });
                    }}
                    aria-label={`Label for ${noun} ${i + 1}`}
                  />
                ) : (
                  <Select
                    value={r.label ?? ''}
                    aria-label={`Label for ${noun} ${i + 1}`}
                    onChange={(v) => (v === CUSTOM ? set(r.id, { custom: true, label: '' }) : set(r.id, { label: v || undefined }))}
                    options={[{ value: '', label: 'No label' }, ...presets.map((p) => ({ value: p.key, label: p.label })), { value: CUSTOM, label: 'Custom…' }]}
                  />
                )}
              </td>
              <td className="mv-actions">
                <button
                  type="button" className={`icon-btn${i === 0 ? ' mv-is-primary' : ''}`} onClick={() => makePrimary(r.id)} disabled={i === 0 || !r.value.trim()}
                  aria-label={i === 0 ? 'Primary' : `Make ${r.value || 'this'} the primary ${noun}`} title={i === 0 ? 'Primary' : 'Make primary'}
                >
                  <Star size={14} fill={i === 0 && filled > 0 ? 'currentColor' : 'none'} />
                </button>
                <button type="button" className="icon-btn danger" onClick={() => remove(r.id)} aria-label={`Remove ${r.value || `${noun} ${i + 1}`}`} title="Remove">
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn small ghost mv-add" onClick={add}>
        <Plus size={13} /> Add {noun}
      </button>
    </div>
  );
}
