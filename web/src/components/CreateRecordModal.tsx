import { useState } from 'react';
import { api, ApiError, type CrmRecord, type ObjectDef } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Modal, PropertyInput, fromInput, isEditable } from './ui';

// Create form: the identifying fields first, then the object's other native
// properties. Contacts get a name built from first + last when left blank.
const PREFERRED: Record<string, string[]> = {
  contacts: ['first_name', 'last_name', 'email', 'phone', 'job_title', 'lifecycle_stage', 'owner'],
  companies: ['name', 'domain', 'industry', 'phone', 'owner'],
  deals: ['name', 'amount', 'currency', 'pipeline', 'stage', 'close_date', 'owner'],
  tasks: ['name', 'task_type', 'status', 'priority', 'due_at', 'owner'],
  users: ['first_name', 'last_name', 'email', 'status'],
  // the builder, the link card and Status on the record page do the rest
  forms: ['name', 'description']
};
// Values every new record of the object starts with, not asked.
const STARTS_WITH: Record<string, Record<string, unknown>> = {
  forms: { status: 'draft' }
};

export function CreateRecordModal({ object, onClose, onCreated }: { object: ObjectDef; onClose: () => void; onCreated: (r: CrmRecord) => void }) {
  const { me } = useApp();
  const editable = object.properties.filter((p) => isEditable(p) && p.api_name !== 'created_at');
  const preferred = PREFERRED[object.api_name];
  const fields = preferred
    ? preferred.map((n) => editable.find((p) => p.api_name === n)).filter((p): p is NonNullable<typeof p> => !!p)
    : [editable.find((p) => p.api_name === 'name'), ...editable.filter((p) => !p.is_base).slice(0, 6)].filter((p): p is NonNullable<typeof p> => !!p);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const owner = editable.find((p) => p.api_name === 'owner');
    const defaults: Record<string, string> = {};
    if (owner && me.user && owner.dropdown_options?.some((o) => o.api_value === me.user!.id)) defaults.owner = me.user.id;
    return defaults;
  });
  // property: shown under that field when the API says which one failed
  const [error, setError] = useState<{ message: string; property?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const properties: Record<string, unknown> = { ...STARTS_WITH[object.api_name] };
    for (const p of fields) {
      const v = values[p.api_name];
      if (v !== undefined && v !== '') properties[p.api_name] = fromInput(p, v);
    }
    if (!properties.name && (properties.first_name || properties.last_name) && object.properties.some((p) => p.api_name === 'first_name')) {
      properties.name = [properties.first_name, properties.last_name].filter(Boolean).join(' ');
    }
    try {
      const created = await api<CrmRecord>('POST', `/v1/objects/${object.api_name}`, { properties });
      onCreated(created);
    } catch (err) {
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
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
        </>
      }
    >
      <div className="form">
        {fields.map((p, i) => (
          <label key={p.api_name} className="field">
            <span>{p.label}</span>
            <PropertyInput property={p} value={values[p.api_name] ?? ''} autoFocus={i === 0} onChange={(v) => setValues((s) => ({ ...s, [p.api_name]: v }))} />
            {error?.property === p.api_name && <div className="error prop-error" role="alert">{error.message}</div>}
          </label>
        ))}
        {error && !error.property && <div className="error">{error.message}</div>}
      </div>
    </Modal>
  );
}
