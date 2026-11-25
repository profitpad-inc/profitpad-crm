import { useEffect, useState } from 'react';
import { SaveHint } from './SaveHint';
import { api, ApiError, getSchema, type CrmRecord, type ObjectDef } from '../lib/api';
import { Modal, PropertyInput, fromInput } from './ui';
import { Select } from './Select';
import { useApp } from '../lib/app-context';

// Create a user: first name, last name, email, phone and a role. The role is
// a role assignment (the Users or Roles permission; Super Admin roles only
// for Super Admins), not a property, so this is its own form
// rather than the generic CreateRecordModal. The API requires the same four
// (role goes in the create properties, see api/src/routes/users.ts).

type FieldKey = 'first_name' | 'last_name' | 'email' | 'phone';

const FIELDS: { key: FieldKey; label: string; required: boolean }[] = [
  { key: 'first_name', label: 'First name', required: true },
  { key: 'last_name', label: 'Last name', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'phone', label: 'Phone', required: false }
];

interface RoleOption { id: string; name: string; is_admin: boolean }

// The schema and roles are preloaded by the pages that open this modal
// (preloadCreateUser on mount), so the form opens fully drawn instead of
// flashing its loading state. The modal still refreshes them each time it
// opens, in case roles changed since.
interface Prefetched { schema: ObjectDef; roles: RoleOption[] }
let cached: Prefetched | null = null;
let pending: Promise<Prefetched> | null = null;

function loadCreateUser(): Promise<Prefetched> {
  if (!pending) {
    pending = Promise.all([getSchema('users'), api<{ results: RoleOption[] }>('GET', '/v1/roles')])
      .then(([schema, r]) => (cached = { schema, roles: r.results.map((x) => ({ id: String(x.id), name: x.name, is_admin: x.is_admin })) }))
      .finally(() => { pending = null; });
  }
  return pending;
}

export function preloadCreateUser(): void {
  if (!cached) loadCreateUser().catch(() => {});
}

export function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (record: CrmRecord) => void }) {
  const { me } = useApp();
  const [schema, setSchema] = useState<ObjectDef | null>(cached?.schema ?? null);
  const [roles, setRoles] = useState<RoleOption[] | null>(cached?.roles ?? null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCreateUser()
      .then((d) => {
        if (cancelled) return;
        setSchema(d.schema);
        setRoles(d.roles);
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

  const missing = [...FIELDS.filter((f) => f.required && !(values[f.key] ?? '').trim()).map((f) => `a ${f.label.toLowerCase()}`), !roleId && 'a role'];
  const ready = !!schema && !!roles && missing.every((m) => !m);

  return (
    <Modal
      title="Create user"
      onClose={onClose}
      footer={
        <>
          {!!schema && !!roles && <SaveHint missing={missing} />}
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
                : <input type="text" inputMode={f.key === 'email' ? 'email' : undefined} autoCapitalize={f.key === 'email' ? 'none' : undefined} disabled={!schema} value={values[f.key] ?? ''} onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))} />}
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
            options={[{ value: '', label: 'Pick a role', disabled: true }, ...(roles ?? []).filter((r) => me.is_admin || !r.is_admin).map((r) => ({ value: r.id, label: r.name }))]}
          />
          {error?.field === 'role' && <div className="error prop-error" role="alert">{error.message}</div>}
        </label>
        {error && !error.field && <div className="error">{error.message}</div>}
      </div>
    </Modal>
  );
}
