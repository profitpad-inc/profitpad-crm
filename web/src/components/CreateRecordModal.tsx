import { useEffect, useState } from 'react';
import { api, ApiError, type CrmRecord, type ObjectDef } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Modal, PropertyInput, fromInput, isEditable } from './ui';
import { Select } from './Select';
import { loadTemplateChoices, templateOptions, TEMPLATE_OBJECTS, type TemplateChoice } from '../lib/templates';

// New quotes expire this many days from today unless the user picks a date.
const QUOTE_EXPIRY_DAYS = 30;

function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


// Create form: the fields, their order and starting values come from the API
// (create_form in the object's schema, api/src/native-ui.ts), which also
// describes this form to AI view builders.

// associations: records the new one is linked to (a quote made from a deal).
// copyLines: offers to copy that record's line items onto the new one.
// startWith: values the new record takes without asking (a deal's amount and
// currency); dropdown values this object does not offer are left out.
export function CreateRecordModal({ object, onClose, onCreated, associations, copyLines, startWith }: {
  object: ObjectDef;
  onClose: () => void;
  onCreated: (r: CrmRecord) => void;
  associations?: { object: string; id: string }[];
  copyLines?: { object: string; id: string; count: number; label: string };
  startWith?: Record<string, unknown>;
}) {
  const { me } = useApp();
  const editable = object.properties.filter((p) => isEditable(p) && p.api_name !== 'created_at');
  const form = object.create_form;
  const fields = form.fields.map((n) => editable.find((p) => p.api_name === n)).filter((p): p is NonNullable<typeof p> => !!p);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    for (const p of editable) {
      if (!form.starts_as_me.includes(p.api_name) || !me.user) continue;
      if (p.dropdown_options?.some((o) => o.api_value === me.user!.id && o.record_status === 'active')) defaults[p.api_name] = me.user.id;
    }
    if (object.api_name === 'quotes' && fields.some((p) => p.api_name === 'expiration_date')) defaults.expiration_date = daysFromToday(QUOTE_EXPIRY_DAYS);
    return defaults;
  });
  // property: shown under that field when the API says which one failed
  const [error, setError] = useState<{ message: string; property?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState(true);
  const [created, setCreated] = useState<CrmRecord | null>(null);
  // properties a picked address filled (Settings → Address autocomplete),
  // saved even when the form doesn't show them
  const [filled, setFilled] = useState<Set<string>>(() => new Set());
  // published document templates for this object; '' = the default, so later
  // default changes still apply
  const [templates, setTemplates] = useState<TemplateChoice[]>([]);
  const [template, setTemplate] = useState('');

  useEffect(() => {
    if (!TEMPLATE_OBJECTS.includes(object.api_name)) return;
    let cancelled = false;
    loadTemplateChoices(object.api_name).then((list) => {
      if (!cancelled) setTemplates(list);
    }).catch(() => { /* no access to templates: the picker stays hidden */ });
    return () => { cancelled = true; };
  }, [object.api_name]);

  async function save() {
    setBusy(true);
    setError(null);
    const properties: Record<string, unknown> = { ...form.starts_with };
    for (const [k, v] of Object.entries(startWith ?? {})) {
      const p = object.properties.find((x) => x.api_name === k && isEditable(x));
      if (!p || v === null || v === undefined || v === '') continue;
      if (p.type === 'dropdown' && !p.dropdown_options?.some((o) => o.record_status === 'active' && o.api_value === v)) continue;
      properties[k] = v;
    }
    for (const p of editable.filter((x) => fields.includes(x) || filled.has(x.api_name))) {
      const v = values[p.api_name];
      if (v !== undefined && v !== '') properties[p.api_name] = fromInput(p, v);
    }
    // a calculated name (contacts by default) fills itself
    if (!properties.name && (properties.first_name || properties.last_name) && editable.some((p) => p.api_name === 'name') && object.properties.some((p) => p.api_name === 'first_name')) {
      properties.name = [properties.first_name, properties.last_name].filter(Boolean).join(' ');
    }
    let record = created;
    try {
      // a retry after a failed copy does not create the record twice
      if (!record) {
        const links = template ? [...(associations ?? []), { object: 'document_templates', id: template }] : associations;
        record = await api<CrmRecord>('POST', `/v1/objects/${object.api_name}`, { properties, associations: links });
        setCreated(record);
      }
      if (copyLines && copy && copyLines.count > 0) {
        await api('POST', `/v1/objects/${object.api_name}/${record.id}/lines/copy`, { from_object: copyLines.object, from_id: copyLines.id });
      }
      onCreated(record);
    } catch (err) {
      if (record) {
        setError({ message: `The ${object.label_singular.toLowerCase()} was created, but its line items were not copied: ${(err as Error).message}` });
        setBusy(false);
        return;
      }
      const property = err instanceof ApiError ? err.details?.property : undefined;
      setError({ message: (err as Error).message, property: fields.some((p) => p.api_name === property) ? property : undefined });
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Create ${object.label_singular.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Creating…' : created ? 'Try copying again' : 'Create'}</button>
        </>
      }
    >
      <div className="form">
        {fields.map((p, i) => (
          <label key={p.api_name} className="field">
            <span>{p.label}</span>
            <PropertyInput property={p} object={object.api_name} value={values[p.api_name] ?? ''} autoFocus={i === 0} onChange={(v) => setValues((s) => ({ ...s, [p.api_name]: v }))}
              onFill={(v) => { setValues((s) => ({ ...s, ...v })); setFilled((f) => new Set([...f, ...Object.keys(v)])); }}
            />
            {error?.property === p.api_name && <div className="error prop-error" role="alert">{error.message}</div>}
          </label>
        ))}
        {templates.length > 0 && (
          <label className="field">
            <span>Template</span>
            <Select value={template} onChange={setTemplate} options={templateOptions(templates)} />
          </label>
        )}
        {copyLines && copyLines.count > 0 && (
          <div className="checks">
            <label><input type="checkbox" checked={copy} disabled={!!created} onChange={(e) => setCopy(e.target.checked)} /> Copy the {copyLines.label}'s {copyLines.count} line {copyLines.count === 1 ? 'item' : 'items'}</label>
          </div>
        )}
        {error && !error.property && <div className="error">{error.message}</div>}
      </div>
    </Modal>
  );
}
