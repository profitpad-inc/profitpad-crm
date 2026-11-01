import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api, getSchema, type CrmRecord, type ObjectDef, type Property } from '../lib/api';
import { useApp } from '../lib/app-context';
import { OPERATORS, type Condition, type FieldType } from '../public/conditions';
import { injectFormCss, renderForm } from '../public/form-renderer';

// Form builder on a form's record page. Edits the form's definition (see
// api/src/forms.ts for the format and the rules the API enforces on save):
// questions of its own, contact properties (contacts are upserted by email)
// and ticket properties (each submission creates a ticket), with show-when
// conditions and hidden fixed values.

type FormObject = 'contacts' | 'tickets';

interface Field {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  property?: { object: FormObject; name: string };
  hidden?: boolean;
  value?: unknown;
  conditions?: Condition[];
}

interface Definition {
  fields: Field[];
  submit_label: string;
  success_message: string;
}

const TYPE_LABELS: Record<FieldType, string> = {
  text: 'Short text', email: 'Email', phone: 'Phone', textarea: 'Long text', number: 'Number',
  select: 'Dropdown', multiselect: 'Checkboxes (pick several)', checkbox: 'Single checkbox', date: 'Date', datetime: 'Date and time'
};
const TEXT_TYPES: FieldType[] = ['text', 'textarea', 'email', 'phone'];
const OBJECT_LABEL: Record<FormObject, string> = { contacts: 'Contact', tickets: 'Ticket' };

function parse(raw: unknown): Definition {
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (d && Array.isArray(d.fields)) {
      return {
        fields: d.fields.map((f: Field) => ({
          ...f,
          options: f.options?.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
        })),
        submit_label: d.submit_label ?? 'Submit',
        success_message: d.success_message ?? 'Thanks, your answers were sent.'
      };
    }
  } catch {
    // fall through to an empty form
  }
  return { fields: [], submit_label: 'Submit', success_message: 'Thanks, your answers were sent.' };
}

// Same rule as formProperty in api/src/forms.ts.
function formProperties(schema: ObjectDef | undefined): Property[] {
  return (schema?.properties ?? []).filter((p) =>
    p.row_status === 'active' && !p.read_only && (!p.is_base || p.api_name === 'name') &&
    ['text', 'number', 'dropdown', 'date', 'datetime'].includes(p.type) && p.options.auto_append_users !== true);
}

function typeFor(p: Property): FieldType {
  if (p.type === 'number') return 'number';
  if (p.type === 'date') return 'date';
  if (p.type === 'datetime') return 'datetime';
  if (p.type === 'dropdown') return p.options.single_value === true ? 'select' : 'multiselect';
  if (/email/.test(p.api_name)) return 'email';
  if (/phone/.test(p.api_name)) return 'phone';
  return p.options.single_line === true ? 'text' : 'textarea';
}

const optionsOf = (p: Property) =>
  (p.dropdown_options ?? []).filter((o) => o.row_status === 'active').sort((a, b) => a.display_order - b.display_order).map((o) => ({ value: o.api_value, label: o.label }));

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'q_$1').slice(0, 50) || 'question';
}

export function FormBuilder({ record, onSaved }: { record: CrmRecord; onSaved: (r: CrmRecord) => void }) {
  const { theme } = useApp();
  const [schemas, setSchemas] = useState<Partial<Record<FormObject, ObjectDef>>>({});
  const [def, setDef] = useState<Definition>(() => parse(record.properties.definition));
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getSchema('contacts'), getSchema('tickets')])
      .then(([contacts, tickets]) => setSchemas({ contacts, tickets }))
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    if (!dirty) setDef(parse(record.properties.definition));
  }, [record.properties.definition, dirty]);

  const propOf = (f: Field) => (f.property ? schemas[f.property.object]?.properties.find((p) => p.api_name === f.property!.name) : undefined);
  // dropdown property options come from the property itself
  const resolved = (f: Field): Field => {
    const p = propOf(f);
    return p?.type === 'dropdown' ? { ...f, options: optionsOf(p) } : f;
  };

  function change(next: Definition) {
    setDef(next);
    setDirty(true);
    setSaved(null);
  }
  const updateField = (name: string, patch: Partial<Field>) =>
    change({ ...def, fields: def.fields.map((f) => (f.name === name ? { ...f, ...patch } : f)) });

  function addProperty(object: FormObject, apiName: string) {
    const p = schemas[object]?.properties.find((x) => x.api_name === apiName);
    if (!p) return;
    const fields = [...def.fields];
    const make = (prop: Property, required = false): Field => ({
      name: `${object === 'contacts' ? 'contact' : 'ticket'}_${prop.api_name}`,
      label: prop.label,
      type: typeFor(prop),
      required,
      property: { object, name: prop.api_name },
      ...(prop.type === 'dropdown' ? { options: optionsOf(prop) } : {})
    });
    // contacts are matched by email, so a form with contact fields asks for it
    if (object === 'contacts' && apiName !== 'email' && !fields.some((f) => f.property?.object === 'contacts' && f.property.name === 'email')) {
      const email = schemas.contacts?.properties.find((x) => x.api_name === 'email');
      if (email) fields.push(make(email, true));
    }
    const field = make(p, object === 'contacts' && apiName === 'email');
    fields.push(field);
    change({ ...def, fields });
    setOpen(field.name);
  }

  function addQuestion(type: FieldType) {
    const used = new Set(def.fields.map((f) => f.name));
    let n = def.fields.filter((f) => !f.property).length + 1;
    while (used.has(`question_${n}`)) n++;
    const field: Field = {
      name: `question_${n}`,
      label: `Question ${n}`,
      type,
      required: false,
      ...(type === 'select' || type === 'multiselect' ? { options: [{ value: 'Option 1', label: 'Option 1' }, { value: 'Option 2', label: 'Option 2' }] } : {})
    };
    change({ ...def, fields: [...def.fields, field] });
    setOpen(field.name);
  }

  function remove(f: Field) {
    const isContactEmail = f.property?.object === 'contacts' && f.property.name === 'email';
    if (isContactEmail && def.fields.some((x) => x !== f && x.property?.object === 'contacts')) {
      setError('Remove the other contact fields first: contacts are matched by email.');
      return;
    }
    const dependents = def.fields.filter((x) => x.conditions?.some((c) => c.field === f.name));
    if (dependents.length && !confirm(`Conditions on ${dependents.map((d) => `"${d.label}"`).join(', ')} use this field and will be removed too. Continue?`)) return;
    change({
      ...def,
      fields: def.fields.filter((x) => x !== f).map((x) => (x.conditions ? { ...x, conditions: x.conditions.filter((c) => c.field !== f.name) } : x))
    });
  }

  function move(i: number, by: -1 | 1) {
    const fields = [...def.fields];
    const [f] = fields.splice(i, 1);
    fields.splice(i + by, 0, f);
    change({ ...def, fields });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const out = await api<Definition>('PUT', `/v1/objects/forms/${record.id}/definition`, def);
      setDef(parse(JSON.stringify(out)));
      setDirty(false);
      setSaved('Saved. The live form uses it right away.');
      onSaved({ ...record, properties: { ...record.properties, definition: JSON.stringify(out) } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const used = new Set(def.fields.filter((f) => f.property).map((f) => `${f.property!.object}.${f.property!.name}`));
  const status = Array.isArray(record.properties.status) ? record.properties.status[0] : record.properties.status;

  return (
    <div className="form-builder">
      <div className="fb-toolbar">
        <h2>Form</h2>
        <div className="fb-modes">
          <button className={`btn small${preview ? '' : ' active'}`} onClick={() => setPreview(false)}><Pencil size={13} /> Edit</button>
          <button className={`btn small${preview ? ' active' : ''}`} onClick={() => setPreview(true)}><Eye size={13} /> Preview</button>
        </div>
        <button className="btn primary push-right" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save form'}</button>
      </div>
      {status !== 'published' && <div className="muted small">The form is not live until its Status is Published.</div>}
      {error && <div className="error">{error}</div>}
      {saved && !dirty && <div className="muted small">{saved}</div>}

      {preview ? (
        <Preview def={{ ...def, fields: def.fields.filter((f) => !f.hidden).map(resolved) }} name={String(record.properties.name ?? '')} primary={theme.primary} />
      ) : (
        <>
          <div className="fb-add">
            {(['contacts', 'tickets'] as FormObject[]).map((o) => (
              <select key={o} value="" onChange={(e) => e.target.value && addProperty(o, e.target.value)} aria-label={`Add ${OBJECT_LABEL[o].toLowerCase()} property`}>
                <option value="">+ {OBJECT_LABEL[o]} property…</option>
                {formProperties(schemas[o]).filter((p) => !used.has(`${o}.${p.api_name}`)).map((p) => (
                  <option key={p.api_name} value={p.api_name}>{p.label}</option>
                ))}
              </select>
            ))}
            <select value="" onChange={(e) => e.target.value && addQuestion(e.target.value as FieldType)} aria-label="Add a question">
              <option value="">+ Question…</option>
              {(Object.keys(TYPE_LABELS) as FieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div className="muted small">
            Contact properties update the contact with the same email, or create one. Ticket properties create a new ticket for each submission, linked to the contact.
          </div>

          {def.fields.length === 0 && <div className="fb-empty muted">No fields yet. Add contact or ticket properties, or questions of your own.</div>}
          <ol className="fb-fields">
            {def.fields.map((f, i) => (
              <FieldRow
                key={f.name}
                field={resolved(f)}
                property={propOf(f)}
                index={i}
                count={def.fields.length}
                earlier={def.fields.slice(0, i).map(resolved)}
                all={def.fields}
                open={open === f.name}
                onToggle={() => setOpen(open === f.name ? null : f.name)}
                onChange={(patch) => updateField(f.name, patch)}
                onRename={(name) => {
                  if (def.fields.some((x) => x.name === name)) return;
                  change({
                    ...def,
                    fields: def.fields.map((x) => x.name === f.name ? { ...x, name } : x.conditions ? { ...x, conditions: x.conditions.map((c) => (c.field === f.name ? { ...c, field: name } : c)) } : x)
                  });
                  setOpen(name);
                }}
                onMove={(by) => move(i, by)}
                onRemove={() => remove(f)}
              />
            ))}
          </ol>

          <div className="fb-settings">
            <label className="field">
              <span>Submit button</span>
              <input value={def.submit_label} onChange={(e) => change({ ...def, submit_label: e.target.value })} />
            </label>
            <label className="field">
              <span>Message after sending</span>
              <textarea rows={2} value={def.success_message} onChange={(e) => change({ ...def, success_message: e.target.value })} />
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function FieldRow({ field: f, property, index, count, earlier, all, open, onToggle, onChange, onRename, onMove, onRemove }: {
  field: Field; property: Property | undefined; index: number; count: number; earlier: Field[]; all: Field[]; open: boolean;
  onToggle: () => void; onChange: (patch: Partial<Field>) => void; onRename: (name: string) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
}) {
  const isContactEmail = f.property?.object === 'contacts' && f.property.name === 'email';
  const missing = f.property && !property;
  const sources = earlier.filter((e) => !e.hidden && OPERATORS[e.type]);
  const badConditions = (f.conditions ?? []).filter((c) => !earlier.some((e) => e.name === c.field));
  const [key, setKey] = useState(f.name);
  useEffect(() => setKey(f.name), [f.name]);

  const tags = [
    f.required && !f.hidden ? 'Required' : null,
    f.hidden ? 'Hidden' : null,
    f.conditions?.length ? 'Conditional' : null
  ].filter(Boolean);

  return (
    <li className={`fb-field${open ? ' open' : ''}`}>
      <div className="fb-field-head">
        <button className="fb-field-title" onClick={onToggle} aria-expanded={open}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span className="fb-label">{f.label || f.name}</span>
          <span className="fb-kind">{f.property ? `${OBJECT_LABEL[f.property.object]} · ${property?.label ?? f.property.name}` : TYPE_LABELS[f.type]}</span>
          {tags.map((t) => <span key={t} className="fb-tag">{t}</span>)}
        </button>
        <button className="icon-btn" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Move up"><ArrowUp size={14} /></button>
        <button className="icon-btn" onClick={() => onMove(1)} disabled={index === count - 1} aria-label="Move down"><ArrowDown size={14} /></button>
        <button className="icon-btn" onClick={onRemove} aria-label="Remove field"><Trash2 size={14} /></button>
      </div>
      {missing && <div className="error">This property was archived or can no longer be filled by a form. Remove the field.</div>}
      {badConditions.length > 0 && <div className="error">A condition points at a field that is not above this one. Move the field or remove the condition.</div>}

      {open && (
        <div className="fb-editor">
          <label className="field">
            <span>Label</span>
            <input value={f.label} onChange={(e) => onChange({ label: e.target.value })} />
          </label>
          <label className="field">
            <span>Help text</span>
            <input value={f.help ?? ''} placeholder="Shown under the label" onChange={(e) => onChange({ help: e.target.value || undefined })} />
          </label>

          {!f.property && (
            <div className="fb-row">
              <label className="field">
                <span>Type</span>
                <select value={f.type} onChange={(e) => {
                  const type = e.target.value as FieldType;
                  const needsOptions = type === 'select' || type === 'multiselect';
                  onChange({ type, options: needsOptions ? (f.options?.length ? f.options : [{ value: 'Option 1', label: 'Option 1' }]) : undefined });
                }}>
                  {(Object.keys(TYPE_LABELS) as FieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Key in submissions</span>
                <input
                  value={key}
                  onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                  onBlur={() => {
                    const next = slug(key);
                    if (next !== f.name && !/^(contact|ticket)_/.test(next) && !all.some((x) => x.name === next)) onRename(next);
                    else setKey(f.name);
                  }}
                />
              </label>
            </div>
          )}

          {f.property && property?.type === 'text' && (
            <label className="field">
              <span>Ask as</span>
              <select value={f.type} onChange={(e) => onChange({ type: e.target.value as FieldType })}>
                {TEXT_TYPES.filter((t) => !(t === 'textarea' && property.options.single_line === true)).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </label>
          )}

          {['text', 'email', 'phone', 'textarea', 'number'].includes(f.type) && !f.hidden && (
            <label className="field">
              <span>Placeholder</span>
              <input value={f.placeholder ?? ''} onChange={(e) => onChange({ placeholder: e.target.value || undefined })} />
            </label>
          )}

          {!f.property && (f.type === 'select' || f.type === 'multiselect') && (
            <label className="field">
              <span>Options, one per line</span>
              <textarea
                rows={Math.min(8, (f.options?.length ?? 1) + 1)}
                value={(f.options ?? []).map((o) => o.label).join('\n')}
                onChange={(e) => onChange({ options: e.target.value.split('\n').map((s) => ({ value: s, label: s })) })}
                onBlur={(e) => onChange({ options: [...new Set(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))].map((s) => ({ value: s, label: s })) })}
              />
            </label>
          )}
          {f.property && (f.type === 'select' || f.type === 'multiselect') && (
            <div className="muted small">Options come from the {property?.label ?? 'property'} property: {(f.options ?? []).map((o) => o.label).join(', ') || 'none'}.</div>
          )}

          {!f.hidden && (
            <label className="field inline fb-check">
              <input type="checkbox" checked={f.required} disabled={isContactEmail} onChange={(e) => onChange({ required: e.target.checked })} />
              <span>Required{isContactEmail ? ' (contacts are matched by email)' : f.conditions?.length ? ' when shown' : ''}</span>
            </label>
          )}

          {f.property && !isContactEmail && property && (
            <div className="fb-hidden">
              <label className="field inline fb-check">
                <input type="checkbox" checked={f.hidden === true} onChange={(e) => onChange({ hidden: e.target.checked || undefined, value: undefined, required: false, conditions: undefined })} />
                <span>Don't ask: always set to a fixed value</span>
              </label>
              {f.hidden && <HiddenValue field={f} property={property} onChange={(value) => onChange({ value })} />}
            </div>
          )}

          {!f.hidden && !isContactEmail && (
            <div className="fb-conditions">
              <div className="small"><strong>Show this field</strong> {f.conditions?.length ? 'only when all of these are true:' : 'always.'}</div>
              {(f.conditions ?? []).map((c, ci) => (
                <ConditionRow
                  key={ci}
                  condition={c}
                  sources={sources}
                  onChange={(next) => onChange({ conditions: f.conditions!.map((x, xi) => (xi === ci ? next : x)) })}
                  onRemove={() => {
                    const rest = f.conditions!.filter((_, xi) => xi !== ci);
                    onChange({ conditions: rest.length ? rest : undefined });
                  }}
                />
              ))}
              {sources.length > 0 ? (
                <button className="btn small" onClick={() => {
                  const s = sources[sources.length - 1];
                  onChange({ conditions: [...(f.conditions ?? []), { field: s.name, operator: OPERATORS[s.type]![0].op, ...(s.options ? { value: [] } : {}) }] });
                }}>
                  <Plus size={13} /> Add condition
                </button>
              ) : (
                <div className="muted small">Conditions use dropdown, checkbox or date fields placed above this one.</div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function HiddenValue({ field: f, property, onChange }: { field: Field; property: Property; onChange: (v: unknown) => void }) {
  if (f.type === 'select') {
    return (
      <select value={typeof f.value === 'string' ? f.value : ''} onChange={(e) => onChange(e.target.value || undefined)} aria-label="Fixed value">
        <option value="">Choose a value…</option>
        {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (f.type === 'multiselect') {
    const current = Array.isArray(f.value) ? (f.value as string[]) : [];
    return (
      <div className="fb-options">
        {(f.options ?? []).map((o) => (
          <label key={o.value} className="fb-check">
            <input type="checkbox" checked={current.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...current, o.value] : current.filter((x) => x !== o.value))} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    );
  }
  const inputType = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : 'text';
  return (
    <input
      type={inputType}
      aria-label={`Fixed ${property.label}`}
      value={f.value === undefined || f.value === null ? '' : f.type === 'datetime' ? String(f.value).slice(0, 16) : String(f.value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : f.type === 'number' ? Number(e.target.value) : e.target.value)}
    />
  );
}

function ConditionRow({ condition: c, sources, onChange, onRemove }: {
  condition: Condition; sources: Field[]; onChange: (c: Condition) => void; onRemove: () => void;
}) {
  const source = sources.find((s) => s.name === c.field);
  const ops = source ? OPERATORS[source.type] ?? [] : [];
  const needsOptions = c.operator === 'is_any_of' || c.operator === 'is_none_of';
  const needsDate = c.operator === 'is_before' || c.operator === 'is_after' || c.operator === 'is_on';
  const chosen = Array.isArray(c.value) ? c.value : [];
  return (
    <div className="fb-condition">
      <div className="fb-condition-line">
        <select value={c.field} onChange={(e) => {
          const s = sources.find((x) => x.name === e.target.value)!;
          onChange({ field: s.name, operator: OPERATORS[s.type]![0].op, ...(s.options ? { value: [] } : {}) });
        }} aria-label="Field">
          {!source && <option value={c.field}>(missing field)</option>}
          {sources.map((s) => <option key={s.name} value={s.name}>{s.label}</option>)}
        </select>
        <select value={c.operator} onChange={(e) => {
          const op = e.target.value as Condition['operator'];
          const list = op === 'is_any_of' || op === 'is_none_of';
          const date = op === 'is_before' || op === 'is_after' || op === 'is_on';
          onChange({ field: c.field, operator: op, ...(list ? { value: chosen } : date ? { value: typeof c.value === 'string' ? c.value : '' } : {}) });
        }} aria-label="Operator">
          {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
        </select>
        {needsDate && <input type="date" value={typeof c.value === 'string' ? c.value : ''} onChange={(e) => onChange({ ...c, value: e.target.value })} aria-label="Date" />}
        <button className="icon-btn push-right" onClick={onRemove} aria-label="Remove condition"><X size={14} /></button>
      </div>
      {needsOptions && source?.options && (
        <div className="fb-options">
          {source.options.map((o) => (
            <label key={o.value} className="fb-check">
              <input type="checkbox" checked={chosen.includes(o.value)} onChange={(e) => onChange({ ...c, value: e.target.checked ? [...chosen, o.value] : chosen.filter((x) => x !== o.value) })} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// The real renderer, fed the unsaved definition; nothing is sent.
function Preview({ def, name, primary }: { def: Definition; name: string; primary: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const form = useMemo(() => ({ name, description: null, definition: def, theme: { primary } }), [def, name, primary]);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    injectFormCss();
    renderForm(ref.current, { apiBase: '', key: 'preview', form, preview: true });
  }, [form, run]);
  return (
    <div className="fb-preview">
      <div className="muted small fb-preview-note">
        Preview of the unsaved form. Conditions work; sending only checks the answers. Hidden fixed values are not shown.
        <button className="btn small" onClick={() => setRun((n) => n + 1)}>Reset</button>
      </div>
      <div className="card"><h3 className="fb-preview-title">{name}</h3><div ref={ref} /></div>
    </div>
  );
}
