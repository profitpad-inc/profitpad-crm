import { useEffect, useState } from 'react';
import { api, ApiError, getSchema, type CrmRecord, type ObjectDef } from '../lib/api';
import { Modal, PropertyInput, fromInput } from './ui';
import { Select } from './Select';

// Create a user: first name, last name, email, phone and a role. The role is
// a role assignment (admin only), not a property, so this is its own form
// rather than the generic CreateRecordModal. The API requires the same four
// (role goes in the create properties, see api/src/routes/users.ts).

type FieldKey = 'first_name' | 'last_name' | 'email' | 'phone';

const FIELDS: { key: FieldKey; label: string; required: boolean }[] = [
  { key: 'first_name', label: 'First name', required: true },
  { key: 'last_name', label: 'Last name', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'phone', label: 'Phone', required: false }
];

interface RoleOption { id: string; name: string }

export function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (record: CrmRecord) => void }) {
  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [roles, setRoles] = useState<RoleOption[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSchema('users'), api<{ results: RoleOption[] }>('GET', '/v1/roles')])
      .then(([s, r]) => {
        if (cancelled) return;
        setSchema(s);
        setRoles(r.results.map((x) => ({ id: String(x.id), name: x.name })));
      })
      .catch((err) => !cancelled && setError({ message: (err as Error).message }));
    return () => { cancelled = true; };
  }, []);

  const propertyOf = (key: string) => schema?.properties.find((p) => p.api_name === key);

  async function save() {
    if (!schema) return;
    for (const f of FIELDS) {
      if (f.required && !(values[f.key] ?? '').trim()) {
        setError({ message: `${f.label} is required.`, field: f.key });
        return;
      }
    }
    if (!roleId) {
      setError({ message: 'Role is required.', field: 'role' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const properties: Record<string, unknown> = { role: roleId };
      for (const f of FIELDS) {
        const p = propertyOf(f.key);
        const v = (values[f.key] ?? '').trim();
        if (p && v) properties[f.key] = fromInput(p, v);
      }
      // a calculated name fills itself; an editable one gets first + last
      const name = propertyOf('name');
      if (name && !name.read_only && name.type !== 'calculation') {
        properties.name = [properties.first_name, properties.last_name].filter(Boolean).join(' ');
      }
      onCreated(await api<CrmRecord>('POST', '/v1/objects/users', { properties }));
    } catch (err) {
      const property = err instanceof ApiError ? err.details?.property : undefined;
      setError({ message: (err as Error).message, field: property === 'role' || FIELDS.some((f) => f.key === property) ? property : undefined });
      setBusy(false);
    }
  }

  const ready = !!schema && !!roles;

  return (
    <Modal
      title="Create user"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !ready}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form">
        {FIELDS.map((f, i) => {
          const p = propertyOf(f.key);
          return (
            <label key={f.key} className="field">
              <span>{f.label}{f.required && ' *'}</span>
              {p
                ? <PropertyInput property={p} object="users" value={values[f.key] ?? ''} autoFocus={i === 0} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                : <input type={f.key === 'email' ? 'email' : 'text'} disabled={!schema} value={values[f.key] ?? ''} onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))} />}
              {error?.field === f.key && <div className="error prop-error" role="alert">{error.message}</div>}
            </label>
          );
        })}
        <label className="field">
          <span>Role *</span>
          <Select
            value={roleId}
            onChange={setRoleId}
            loading={!roles}
            options={[{ value: '', label: 'Pick a role', disabled: true }, ...(roles ?? []).map((r) => ({ value: r.id, label: r.name }))]}
          />
          {error?.field === 'role' && <div className="error prop-error" role="alert">{error.message}</div>}
        </label>
        {error && !error.field && <div className="error">{error.message}</div>}
      </div>
    </Modal>
  );
}
