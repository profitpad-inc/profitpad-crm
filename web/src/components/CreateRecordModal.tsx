import { useEffect, useState } from 'react';
import { api, ApiError, type CrmRecord, type ObjectDef } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Modal, PropertyInput, fromInput, isEditable } from './ui';
import { Select } from './Select';
import { loadTemplateChoices, templateOptions, TEMPLATE_OBJECTS, type TemplateChoice } from '../lib/templates';
import '../lists.css';

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
// copyLinks: offers to link the new record to that record's companies and
// contacts too (one switch per object, on by default).
// startWith: values the new record takes without asking (a deal's amount and
// currency); dropdown values this object does not offer are left out.
export function CreateRecordModal({ object, onClose, onCreated, associations, copyLines, copyLinks, startWith }: {
  object: ObjectDef;
  onClose: () => void;
  onCreated: (r: CrmRecord) => void;
  associations?: { object: string; id: string }[];
  copyLines?: { object: string; id: string; count: number; label: string };
  copyLinks?: { label: string; groups: { object: string; singular: string; plural: string; records: { id: string; name: string }[] }[] };
  startWith?: Record<string, unknown>;
}) {
  const { me, objects } = useApp();
  // a list's object is picked from the objects a list can hold: the main CRM
  // objects first, then the rest A to Z
  const LIST_FIRST = ['contacts', 'companies', 'deals', 'tickets'];
  const rank = (o: { api_name: string }) => { const i = LIST_FIRST.indexOf(o.api_name); return i < 0 ? LIST_FIRST.length : i; };
  const listObjects = objects.filter((o) => o.kind !== 'system' && o.api_name !== 'lists')
    .sort((x, y) => rank(x) - rank(y) || x.label_plural.localeCompare(y.label_plural))
    .map((o) => ({ value: o.api_name, label: o.label_plural }));
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
    if (object.api_name === 'lists') defaults.list_type = 'dynamic';
    return defaults;
  });
  // property: shown under that field when the API says which one failed
  const [error, setError] = useState<{ message: string; property?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState(true);
  // the copyLinks objects switched off
  const [skipLinks, setSkipLinks] = useState<Set<string>>(() => new Set());
  const [created, setCreated] = useState<CrmRecord | null>(null);
  // properties a picked address filled (Settings → Address autocomplete),
  // saved even when the form doesn't show them
  const [filled, setFilled] = useState<Set<string>>(() => new Set());
  // published document templates for this object; '' = the default, so later
  // default changes still apply
  const [templates, setTemplates] = useState<TemplateChoice[]>([]);
  const [template, setTemplate] = useState('');
  // lists: a name and an object before Create; a static list has no refresh schedule
  const isList = object.api_name === 'lists';
  const required = isList ? ['name', 'list_object'] : [];
  const missing = required.some((n) => !String(values[n] ?? '').trim());
  const listStatic = isList && values.list_type === 'static';

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
        const links = [
          ...(associations ?? []),
          ...(copyLinks?.groups ?? []).filter((g) => !skipLinks.has(g.object)).flatMap((g) => g.records.map((r) => ({ object: g.object, id: r.id }))),
          ...(template ? [{ object: 'document_templates', id: template }] : [])
        ];
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
          <button className="btn primary" onClick={save} disabled={busy || missing} title={missing ? 'Give the list a name and pick its object first' : undefined}>
            {busy ? 'Creating…' : created ? 'Try copying again' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form">
        {fields.filter((p) => !(listStatic && p.api_name === 'refresh_schedule')).map((p, i) => (
          <label key={p.api_name} className="field">
            <span title={p.description || undefined}>{p.label}{required.includes(p.api_name) && <span className="required-mark" aria-label="required"> *</span>}</span>
            {object.api_name === 'lists' && p.api_name === 'list_object' ? (
              <Select value={String(values[p.api_name] ?? '')} aria-label={p.label} search
                onChange={(v) => setValues((s) => ({ ...s, [p.api_name]: v }))}
                options={[{ value: '', label: 'Pick an object' }, ...listObjects]} />
            ) : (
              <PropertyInput property={p} object={object.api_name} value={values[p.api_name] ?? ''} autoFocus={i === 0} onChange={(v) => setValues((s) => ({ ...s, [p.api_name]: v }))}
                onFill={(v) => { setValues((s) => ({ ...s, ...v })); setFilled((f) => new Set([...f, ...Object.keys(v)])); }}
              />
            )}
            {isList && p.api_name === 'list_type' && <ListTypeHelp type={listStatic ? 'static' : 'dynamic'} />}
            {error?.property === p.api_name && <div className="error prop-error" role="alert">{error.message}</div>}
          </label>
        ))}
        {templates.length > 0 && (
          <label className="field">
            <span>Template</span>
            <Select value={template} onChange={setTemplate} options={templateOptions(templates)} />
          </label>
        )}
        {((copyLines && copyLines.count > 0) || (copyLinks && copyLinks.groups.length > 0)) && (
          <div className="checks">
            {copyLines && copyLines.count > 0 && (
              <label><input type="checkbox" checked={copy} disabled={!!created} onChange={(e) => setCopy(e.target.checked)} /> Copy the {copyLines.label}'s {copyLines.count} line {copyLines.count === 1 ? 'item' : 'items'}</label>
            )}
            {copyLinks?.groups.map((g) => (
              <label key={g.object}>
                <input type="checkbox" checked={!skipLinks.has(g.object)} disabled={!!created}
                  onChange={(e) => setSkipLinks((s) => { const n = new Set(s); if (e.target.checked) n.delete(g.object); else n.add(g.object); return n; })} />
                {' '}Link the {copyLinks.label}'s {g.records.length === 1 ? `${g.singular}: ${g.records[0].name}` : `${g.records.length} ${g.plural}: ${g.records.map((r) => r.name).join(', ')}`}
              </label>
            ))}
          </div>
        )}
        {error && !error.property && <div className="error">{error.message}</div>}
      </div>
    </Modal>
  );
}

// What the two kinds of list are, under the Type menu: the picked one first.
function ListTypeHelp({ type }: { type: 'static' | 'dynamic' }) {
  const dynamic = <p key="d" className={`list-type-help${type === 'dynamic' ? ' picked' : ''}`}><strong>Dynamic:</strong> the records that match the filters you set on the list, worked out again on a schedule (every 15 minutes to daily), so records join and leave by themselves. For groups that change, like contacts in Toronto or deals closing this month. A list can switch type later.</p>;
  const fixed = <p key="s" className={`list-type-help${type === 'static' ? ' picked' : ''}`}><strong>Static:</strong> the records you add, by hand, with Add to list from a table, or once from filters. Nothing joins or leaves unless someone changes it. For a fixed group, like the guests of one event.</p>;
  return <div className="list-type-helps">{type === 'dynamic' ? [dynamic, fixed] : [fixed, dynamic]}</div>;
}
