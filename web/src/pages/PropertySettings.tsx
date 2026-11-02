import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { api, clearSchemaCache, getSchema, type DropdownOption, type Property, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { nameProperties, recordName } from '../lib/display';
import { Menu, Modal } from '../components/ui';

// Admin page for an object's properties. Every change goes through the
// /v1/schema endpoints, so the database (meta.* functions) enforces the
// naming and option rules; its messages are shown as they come back.

type PropType = 'text' | 'number' | 'dropdown' | 'date' | 'datetime' | 'file' | 'calculation';
type Options = Record<string, unknown>;

const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  dropdown: 'Dropdown',
  date: 'Date',
  datetime: 'Date and time',
  calculation: 'Calculation',
  file: 'File',
  id: 'Record id',
  id_list: 'Record ids'
};

const NEW_TYPES: PropType[] = ['text', 'number', 'dropdown', 'date', 'datetime', 'file', 'calculation'];

const TEXT_DISPLAYS = [
  { value: 'plain', label: 'Plain text' },
  { value: 'url', label: 'Web address' },
  { value: 'phone', label: 'Phone number' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'json', label: 'JSON' },
  { value: 'html', label: 'HTML' }
];

const NUMBER_FORMATS = [
  { value: 'formatted', label: 'Formatted (1,234.5)' },
  { value: 'unformatted', label: 'Unformatted (1234.5)' },
  { value: 'currency', label: 'Currency' },
  { value: 'percentage', label: 'Percentage' }
];

// api_name / api_value from a label: letters, digits, dots, underscores
function slug(label: string): string {
  const s = label.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 63);
  return /^[0-9]/.test(s) ? `p_${s}`.slice(0, 63) : s;
}

function typeLabel(p: Property): string {
  if (p.type === 'calculation') return `Calculation (${TYPE_LABELS[p.calc_output_type ?? 'text'] ?? p.calc_output_type})`;
  if (p.type === 'text' && p.options.display && p.options.display !== 'plain') {
    return `Text, ${TEXT_DISPLAYS.find((d) => d.value === p.options.display)?.label.toLowerCase() ?? p.options.display}`;
  }
  if (p.type === 'dropdown') return p.options.single_value ? 'Dropdown, one choice' : 'Dropdown, many choices';
  return TYPE_LABELS[p.type] ?? p.type;
}

function source(p: Property): string {
  if (p.is_base) return 'System';
  return p.is_native ? 'Built in' : 'Custom';
}

// drops blank values so the API only receives options that were set
function cleanOptions(o: Options): Options {
  const out: Options = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === '' || v === undefined || v === null || v === false) continue;
    out[k] = v;
  }
  return out;
}

// compares option objects regardless of key order
function sameKeys(o: Options): string {
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

export function PropertySettings() {
  const { objects, toast } = useApp();
  const [object, setObject] = useState(objects.find((o) => o.api_name === 'contacts')?.api_name ?? objects[0]?.api_name ?? '');
  const [props, setProps] = useState<Property[] | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [editing, setEditing] = useState<Property | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Property | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!object) return;
    const res = await api<{ results: Property[] }>('GET', `/v1/schema/${object}/properties?include_archived=true`);
    setProps(res.results);
  }, [object]);

  useEffect(() => {
    setProps(null);
    setError(null);
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function changed(message: string) {
    clearSchemaCache();
    toast(message);
    await load();
  }

  async function run(fn: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await fn();
      await changed(message);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const sorted = useMemo(() => [...objects].sort((a, b) => a.label_plural.localeCompare(b.label_plural)), [objects]);
  const q = query.trim().toLowerCase();
  const shown = (props ?? [])
    .filter((p) => p.row_status === status)
    .filter((p) => !q || p.label.toLowerCase().includes(q) || p.api_name.toLowerCase().includes(q))
    .sort((a, b) => a.label.localeCompare(b.label));
  const archivedCount = (props ?? []).filter((p) => p.row_status === 'archived').length;
  const base = `/v1/schema/${object}/properties`;

  return (
    <section>
      <h2>Properties</h2>
      <p className="muted">
        Properties are the fields stored on each record. Archiving hides a property everywhere and keeps its values; unarchive it to bring it back.
        Deleting an archived property removes it and all its values for good.
      </p>
      <div className="field-row">
        <select value={object} onChange={(e) => setObject(e.target.value)} aria-label="Object">
          {sorted.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="field-row table-bar">
        <input type="search" placeholder="Search properties" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search properties" />
        <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'archived')} aria-label="Which properties">
          <option value="active">Active</option>
          <option value="archived">Archived ({archivedCount})</option>
        </select>
        <button className="btn primary push-right" onClick={() => setEditing('new')} disabled={!object}><Plus size={14} /> Create property</button>
      </div>
      {props && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>Label</th><th>Internal name</th><th>Type</th><th>Source</th><th /></tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={5} className="muted">{q ? 'No matching properties.' : `No ${status} properties.`}</td></tr>}
              {shown.map((p) => (
                <tr key={p.id}>
                  <td className="primary-cell">
                    <button className="link-btn" onClick={() => setEditing(p)}>{p.label}</button>
                  </td>
                  <td><code className="muted">{p.api_name}</code></td>
                  <td>{typeLabel(p)}</td>
                  <td>{source(p)}</td>
                  <td>
                    <Menu align="right" trigger={(open) => <button className="icon-btn" onClick={open} aria-label={`Actions for ${p.label}`}><MoreHorizontal size={16} /></button>}>
                      {(close) => (
                        <>
                          <button onClick={() => { close(); setEditing(p); }}>Edit</button>
                          {!p.is_base && p.row_status === 'active' && (
                            <button onClick={() => { close(); run(() => api('POST', `${base}/${encodeURIComponent(p.api_name)}/archive`), `${p.label} archived`); }}>Archive</button>
                          )}
                          {p.row_status === 'archived' && (
                            <>
                              <button onClick={() => { close(); run(() => api('POST', `${base}/${encodeURIComponent(p.api_name)}/unarchive`), `${p.label} restored`); }}>Unarchive</button>
                              <button className="danger" onClick={() => { close(); setDeleting(p); }}>Delete permanently</button>
                            </>
                          )}
                        </>
                      )}
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <PropertyEditor
          object={object}
          property={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (message) => { setEditing(null); await changed(message); }}
        />
      )}
      {deleting && (
        <DeleteProperty
          property={deleting}
          onClose={() => setDeleting(null)}
          onDelete={() => api('DELETE', `${base}/${encodeURIComponent(deleting.api_name)}`, { confirm: deleting.api_name })}
          onDeleted={async () => { const label = deleting.label; setDeleting(null); await changed(`${label} deleted`); }}
        />
      )}
    </section>
  );
}

function DeleteProperty({ property, onClose, onDelete, onDeleted }: {
  property: Property; onClose: () => void; onDelete: () => Promise<unknown>; onDeleted: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      await onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Delete ${property.label}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={submit} disabled={busy || confirm !== property.api_name}>Delete permanently</button>
        </>
      }
    >
      <p>This removes the property and every value stored in it, on all records. It cannot be undone.</p>
      <label className="field">
        <span>Type <code>{property.api_name}</code> to confirm</span>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
      </label>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

interface Choice {
  api_value: string;
  label: string;
  row_status: string;
  // set for choices that already exist on the property
  existing?: DropdownOption;
  // api_value follows the label until edited (new choices only)
  auto?: boolean;
}

function PropertyEditor({ object, property, onClose, onSaved }: {
  object: string; property: Property | null; onClose: () => void; onSaved: (message: string) => Promise<void>;
}) {
  const isNew = property === null;
  const [label, setLabel] = useState(property?.label ?? '');
  const [apiName, setApiName] = useState(property?.api_name ?? '');
  const [autoName, setAutoName] = useState(isNew);
  const [description, setDescription] = useState(property?.description ?? '');
  const [type, setType] = useState<PropType>((property?.type as PropType) ?? 'text');
  const [options, setOptions] = useState<Options>(property?.options ?? {});
  const [calcSql, setCalcSql] = useState(property?.calc_sql ?? '');
  const [calcType, setCalcType] = useState(property?.calc_output_type ?? 'number');
  const [choices, setChoices] = useState<Choice[]>(
    [...(property?.dropdown_options ?? [])]
      .sort((a, b) => a.display_order - b.display_order)
      .map((o) => ({ api_value: o.api_value, label: o.label, row_status: o.row_status, existing: o }))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = property?.is_base ?? false;
  const set = (k: string, v: unknown) => setOptions((o) => ({ ...o, [k]: v }));
  const str = (k: string) => (options[k] === undefined || options[k] === null ? '' : String(options[k]));
  const bool = (k: string) => options[k] === true;
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

  function onLabel(v: string) {
    setLabel(v);
    if (autoName) setApiName(slug(v));
  }

  function updateChoice(i: number, patch: Partial<Choice>) {
    setChoices((cs) => cs.map((c, j) => {
      if (j !== i) return c;
      const next = { ...c, ...patch };
      if (patch.label !== undefined && c.auto) next.api_value = slug(patch.label);
      if (patch.api_value !== undefined) next.auto = false;
      return next;
    }));
  }

  function moveChoice(i: number, d: number) {
    setChoices((cs) => {
      const j = i + d;
      if (j < 0 || j >= cs.length) return cs;
      const next = [...cs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // the options the chosen type accepts, so switching types never sends stale keys
  function optionsFor(t: PropType): Options {
    const keep: Record<PropType, string[]> = {
      text: ['single_line', 'display', 'regex', 'regex_scope', 'json_only', 'unique', 'case_insensitive'],
      number: ['format', 'prefix', 'suffix', 'decimals', 'min', 'max', 'currency_code', 'currency_property'],
      dropdown: ['single_value', 'allow_form_add', 'allow_user_add', 'auto_append_users', 'default_value'],
      date: [],
      datetime: ['timezone'],
      file: ['max_files'],
      calculation: ['display', 'format', 'prefix', 'suffix', 'decimals', 'timezone']
    };
    const out: Options = {};
    for (const k of keep[t]) if (k in options) out[k] = options[k];
    if (!out.unique) delete out.case_insensitive;
    if (!out.regex) delete out.regex_scope;
    if (out.format !== 'currency') delete out.currency_code;
    return cleanOptions(out);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const base = `/v1/schema/${object}/properties`;
    try {
      if (!property) {
        const body: Record<string, unknown> = {
          api_name: apiName.trim(), label: label.trim(), type, description: description.trim() || undefined, options: optionsFor(type)
        };
        if (type === 'dropdown') {
          body.dropdown_options = choices.map((c, i) => ({ api_value: c.api_value.trim(), label: c.label.trim(), display_order: i }));
        }
        if (type === 'calculation') {
          body.calc_sql = calcSql;
          body.calc_output_type = calcType;
        }
        await api('POST', base, body);
        await onSaved(`${label.trim()} created`);
        return;
      }

      const url = `${base}/${encodeURIComponent(property.api_name)}`;
      const patch: Record<string, unknown> = {};
      if (label.trim() !== property.label) patch.label = label.trim();
      if (description.trim() !== (property.description ?? '')) patch.description = description.trim();
      if (!locked) {
        const next = optionsFor(type);
        if (sameKeys(next) !== sameKeys(cleanOptions(property.options))) patch.options = next;
      }
      if (type === 'calculation' && (calcSql !== (property.calc_sql ?? '') || calcType !== property.calc_output_type)) {
        patch.calc_sql = calcSql;
        patch.calc_output_type = calcType;
      }
      if (Object.keys(patch).length) await api('PATCH', url, patch);

      if (type === 'dropdown') {
        const kept = new Set(choices.filter((c) => c.existing).map((c) => c.existing!.api_value));
        for (const o of property.dropdown_options ?? []) {
          if (!kept.has(o.api_value)) await api('DELETE', `${url}/options/${encodeURIComponent(o.api_value)}`);
        }
        for (const [i, c] of choices.entries()) {
          if (!c.existing) {
            await api('POST', `${url}/options`, { api_value: c.api_value.trim(), label: c.label.trim(), display_order: i });
            continue;
          }
          const o = c.existing;
          const change: Record<string, unknown> = {};
          if (c.label.trim() !== o.label) change.label = c.label.trim();
          if (o.display_order !== i) change.display_order = i;
          if (c.row_status !== o.row_status) change.row_status = c.row_status;
          if (Object.keys(change).length) await api('PATCH', `${url}/options/${encodeURIComponent(o.api_value)}`, change);
        }
      }
      await onSaved(`${label.trim()} saved`);
    } catch (e) {
      // a failed step may have saved earlier ones, so reload on the next open
      clearSchemaCache();
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const numberOptions = (
    <>
      <div className="field-row">
        <label className="field">
          <span>Format</span>
          <select value={str('format')} onChange={(e) => set('format', e.target.value)}>
            <option value="">Default</option>
            {NUMBER_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        {str('format') === 'currency' && type === 'number' && (
          <label className="field">
            <span>Currency code</span>
            <input value={str('currency_code')} maxLength={3} placeholder="USD" onChange={(e) => set('currency_code', e.target.value.toUpperCase())} style={{ width: 90 }} />
          </label>
        )}
        <label className="field">
          <span>Decimals</span>
          <input type="number" min={0} max={10} value={str('decimals')} onChange={(e) => set('decimals', num(e.target.value))} style={{ width: 90 }} />
        </label>
        <label className="field">
          <span>Prefix</span>
          <input value={str('prefix')} maxLength={63} onChange={(e) => set('prefix', e.target.value)} style={{ width: 90 }} />
        </label>
        <label className="field">
          <span>Suffix</span>
          <input value={str('suffix')} maxLength={63} onChange={(e) => set('suffix', e.target.value)} style={{ width: 90 }} />
        </label>
      </div>
      {type === 'number' && (
        <div className="field-row">
          <label className="field">
            <span>Minimum</span>
            <input type="number" value={str('min')} onChange={(e) => set('min', num(e.target.value))} style={{ width: 120 }} />
          </label>
          <label className="field">
            <span>Maximum</span>
            <input type="number" value={str('max')} onChange={(e) => set('max', num(e.target.value))} style={{ width: 120 }} />
          </label>
        </div>
      )}
    </>
  );

  return (
    <Modal
      wide
      title={property ? `Edit ${property.label}` : 'Create property'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !label.trim() || !apiName.trim()}>{isNew ? 'Create' : 'Save'}</button>
        </>
      }
    >
      <div className="prop-editor">
        <div className="field-row">
          <label className="field grow">
            <span>Label</span>
            <input value={label} maxLength={63} onChange={(e) => onLabel(e.target.value)} autoFocus />
          </label>
          <label className="field grow">
            <span>Internal name</span>
            <input
              value={apiName}
              maxLength={63}
              disabled={!isNew}
              onChange={(e) => { setAutoName(false); setApiName(e.target.value); }}
            />
          </label>
        </div>
        {isNew && <p className="muted small">The internal name is used by the API, imports and reports. It cannot be changed later.</p>}
        <label className="field">
          <span>Description</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span>Type</span>
          {property ? (
            <input value={typeLabel(property)} disabled />
          ) : (
            <select value={type} onChange={(e) => setType(e.target.value as PropType)}>
              {NEW_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          )}
        </label>
        {locked && <p className="muted small">This is a system property: only its label and description can be changed.</p>}

        {!locked && type === 'text' && (
          <>
            <label className="field">
              <span>Shown as</span>
              <select value={str('display')} onChange={(e) => set('display', e.target.value)}>
                <option value="">Plain text</option>
                {TEXT_DISPLAYS.filter((d) => d.value !== 'plain').map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </label>
            <div className="checks">
              <label><input type="checkbox" checked={bool('single_line')} onChange={(e) => set('single_line', e.target.checked)} /> Single line (no line breaks)</label>
              <label><input type="checkbox" checked={bool('unique')} onChange={(e) => set('unique', e.target.checked)} /> Unique: no two records may share a value</label>
              {bool('unique') && (
                <label className="child"><input type="checkbox" checked={bool('case_insensitive')} onChange={(e) => set('case_insensitive', e.target.checked)} /> Ignore upper and lower case when comparing</label>
              )}
              <label><input type="checkbox" checked={bool('json_only')} onChange={(e) => set('json_only', e.target.checked)} /> Must be valid JSON</label>
            </div>
            <div className="field-row">
              <label className="field grow">
                <span>Pattern (regular expression, optional)</span>
                <input className="mono" value={str('regex')} onChange={(e) => set('regex', e.target.value)} placeholder="^[A-Z]{2}[0-9]{4}$" />
              </label>
              {str('regex') && (
                <label className="field">
                  <span>Checked</span>
                  <select value={str('regex_scope') || 'all'} onChange={(e) => set('regex_scope', e.target.value === 'all' ? undefined : e.target.value)}>
                    <option value="all">Everywhere</option>
                    <option value="ui">In the app only</option>
                  </select>
                </label>
              )}
            </div>
          </>
        )}

        {!locked && type === 'number' && numberOptions}

        {!locked && type === 'file' && (
          <label className="field">
            <span>Most files per record (empty for no limit)</span>
            <input type="number" min={1} step={1} value={str('max_files')} onChange={(e) => set('max_files', num(e.target.value))} style={{ width: 120 }} />
          </label>
        )}

        {!locked && type === 'datetime' && (
          <label className="field">
            <span>Time zone (optional, e.g. America/Toronto)</span>
            <input value={str('timezone')} onChange={(e) => set('timezone', e.target.value)} />
          </label>
        )}

        {!locked && type === 'calculation' && (
          <>
            <label className="field">
              <span>Result type</span>
              <select value={calcType} onChange={(e) => setCalcType(e.target.value as typeof calcType)}>
                {(['number', 'text', 'date', 'datetime'] as const).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </label>
            <label className="field">
              <span>SQL expression (the current record is <code>r</code>)</span>
              <textarea className="mono" rows={6} value={calcSql} onChange={(e) => setCalcSql(e.target.value)} placeholder="coalesce(r.quantity, 0) * coalesce(r.unit_price, 0)" />
            </label>
            {property?.calc_last_error && <div className="error">Last run failed: {property.calc_last_error}</div>}
            <CalcTester object={object} sql={calcSql} outputType={calcType} />
            {calcType === 'number' && numberOptions}
            {calcType === 'datetime' && (
              <label className="field">
                <span>Time zone (optional)</span>
                <input value={str('timezone')} onChange={(e) => set('timezone', e.target.value)} />
              </label>
            )}
          </>
        )}

        {!locked && type === 'dropdown' && (
          <>
            <div className="checks">
              <label><input type="checkbox" checked={bool('single_value')} onChange={(e) => set('single_value', e.target.checked)} /> One choice per record</label>
              <label><input type="checkbox" checked={bool('allow_user_add')} onChange={(e) => set('allow_user_add', e.target.checked)} /> API writes may add new choices</label>
              <label><input type="checkbox" checked={bool('auto_append_users')} onChange={(e) => set('auto_append_users', e.target.checked)} /> Fill choices with every active user</label>
            </div>
            <label className="field">
              <span>Default</span>
              <select value={str('default_value')} onChange={(e) => set('default_value', e.target.value)}>
                <option value="">None (the value can be empty)</option>
                {choices.filter((c) => c.existing && c.row_status !== 'archived').map((c) => (
                  <option key={c.api_value} value={c.api_value}>{c.label}: new records start with it, never empty</option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Choices</span>
              <div className="choice-list">
                {choices.length === 0 && <div className="muted small">No choices yet.</div>}
                {choices.map((c, i) => (
                  <div key={c.existing?.api_value ?? `new-${i}`} className={`choice-row${c.row_status === 'archived' ? ' archived' : ''}`}>
                    <input value={c.label} maxLength={63} placeholder="Label" onChange={(e) => updateChoice(i, { label: e.target.value })} aria-label="Choice label" />
                    <input
                      className="mono"
                      value={c.api_value}
                      maxLength={63}
                      placeholder="internal_value"
                      disabled={!!c.existing}
                      onChange={(e) => updateChoice(i, { api_value: e.target.value })}
                      aria-label="Choice internal value"
                    />
                    <button className="icon-btn" onClick={() => moveChoice(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp size={14} /></button>
                    <button className="icon-btn" onClick={() => moveChoice(i, 1)} disabled={i === choices.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
                    {c.existing ? (
                      <button className="btn small" onClick={() => updateChoice(i, { row_status: c.row_status === 'archived' ? 'active' : 'archived' })}>
                        {c.row_status === 'archived' ? 'Unarchive' : 'Archive'}
                      </button>
                    ) : <span className="choice-new muted small">New</span>}
                    <button className="icon-btn" onClick={() => setChoices((cs) => cs.filter((_, j) => j !== i))} aria-label="Remove choice"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              <div>
                <button className="btn small" onClick={() => setChoices((cs) => [...cs, { api_value: '', label: '', row_status: 'active', auto: true }])}>
                  <Plus size={14} /> Add choice
                </button>
              </div>
              {!isNew && (
                <p className="muted small">
                  Archived choices stay on records that have them but can't be picked again. Removing a choice deletes it, which the database refuses while records still use it.
                </p>
              )}
            </div>
          </>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

interface CalcResult {
  value: string | null;
  dependencies: { rel_object: string; column_name: string }[];
  ms: number;
}

// Pick a record of the object and run the unsaved expression on it. The API
// applies the same checks as saving, and nothing is written.
function CalcTester({ object, sql, outputType }: { object: string; sql: string; outputType: string }) {
  const { objects } = useApp();
  const [record, setRecord] = useState<{ id: string; name: string } | null>(null);
  const [q, setQ] = useState('');
  const [picking, setPicking] = useState(false);
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!picking) return;
    const h = setTimeout(async () => {
      try {
        const s = await getSchema(object);
        const res = await api<SearchResult>('POST', `/v1/objects/${object}/search`, { query: q.trim() || undefined, limit: 8, properties: nameProperties(s.properties) });
        setResults(res.results.map((r) => ({ id: r.id, name: recordName(r) })));
      } catch (e) {
        setError((e as Error).message);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [picking, q, object]);

  // a stale result would describe different SQL or another record
  useEffect(() => setResult(null), [sql, outputType, record]);

  async function run() {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<CalcResult>('POST', `/v1/schema/${object}/calculations/test`, { calc_sql: sql, calc_output_type: outputType, record_id: record.id }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const objectLabel = (code: string) => objects.find((o) => o.object_type_id === code)?.label_plural ?? code;

  return (
    <div className="calc-test">
      <span className="calc-test-title">Test on a record</span>
      {record && !picking ? (
        <div className="field-row">
          <span className="calc-test-record">{record.name} <span className="muted small">#{record.id}</span></span>
          <button className="btn small" onClick={() => { setPicking(true); setQ(''); }}>Change</button>
          <button className="btn small primary push-right" onClick={run} disabled={busy || !sql.trim()}>{busy ? 'Running…' : 'Run test'}</button>
        </div>
      ) : (
        <div className="calc-test-pick">
          <input type="search" placeholder="Search records" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setPicking(true)} aria-label="Search records to test on" />
          {picking && (
            <div className="calc-test-results">
              {results.length === 0 && <div className="muted small">No records found.</div>}
              {results.map((r) => (
                <button key={r.id} onClick={() => { setRecord(r); setPicking(false); }}>
                  {r.name} <span className="muted small">#{r.id}</span>
                </button>
              ))}
            </div>
          )}
          {record && picking && <button className="btn small" onClick={() => setPicking(false)}>Cancel</button>}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="calc-test-result">
          <div>
            Result: {result.value === null ? <span className="muted">empty (null)</span> : <code>{result.value}</code>}
            <span className="muted small"> · {result.ms} ms</span>
          </div>
          {result.dependencies.length > 0 && (
            <div className="muted small">
              Reads: {result.dependencies.map((d) => `${objectLabel(d.rel_object)}${d.column_name === '*' ? '' : `.${d.column_name}`}`).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
