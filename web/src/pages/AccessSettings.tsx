import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, X } from 'lucide-react';
import { api, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { displayName } from '../lib/display';

// Admin pages for who can see what: users get roles (directly; team
// assignments made through the API are shown too), roles get object access.

interface ObjectPermission {
  object_type_id: string;
  can_read: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

// ids are bigints, which the API sends as strings
interface Role {
  id: string;
  name: string;
  description: string | null;
  is_admin: boolean;
  record_access: 'own' | 'team' | 'all';
  object_permissions: ObjectPermission[];
  assignments: { id: string; user_id: string | null; team_id: string | null }[];
}

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  deactivated: boolean;
}

const RECORD_ACCESS: { value: Role['record_access']; label: string }[] = [
  { value: 'all', label: 'All records' },
  { value: 'team', label: 'Records owned by their teams' },
  { value: 'own', label: 'Only records they own' }
];

function useAccessData() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadRoles = useCallback(async () => {
    const res = await api<{ results: Role[] }>('GET', '/v1/roles');
    setRoles(res.results);
    return res.results;
  }, []);

  useEffect(() => {
    Promise.all([
      reloadRoles(),
      api<SearchResult>('POST', '/v1/objects/users/search', { limit: 200, properties: ['name', 'first_name', 'last_name', 'email', 'status'], sorts: [{ property: 'name', direction: 'asc' }] })
        .then((r) => setUsers(r.results.map((u) => ({
          id: u.id,
          name: displayName(u.properties, u.id),
          email: (u.properties.email as string) ?? null,
          deactivated: ([] as unknown[]).concat(u.properties.status ?? []).includes('deactivated')
        }))))
    ])
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoaded(true));
  }, [reloadRoles]);

  return { roles, users, loaded, error, setError, reloadRoles };
}

export function UserSettings() {
  const { me } = useApp();
  const { roles, users, loaded, error, setError, reloadRoles } = useAccessData();

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await reloadRoles();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const rolesOf = (userId: string) =>
    roles.flatMap((r) => r.assignments.filter((a) => a.user_id === userId).map((a) => ({ role: r, assignmentId: a.id })));

  return (
    <section>
      <h2>Users</h2>
      <p className="muted">
        People sign in with Google when their email matches a user here whose Status is not Deactivated. What they can see comes from their roles; a user
        with no role sees nothing. To add someone, <Link to="/objects/users">create a user record</Link> with their email.
      </p>
      {error && <div className="error">{error}</div>}
      {loaded && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Roles</th></tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const assigned = rolesOf(u.id);
                const available = roles.filter((r) => !assigned.some((a) => a.role.id === r.id));
                return (
                  <tr key={u.id}>
                    <td className="primary-cell">
                      <Link to={`/objects/users/${u.id}`}>{u.name}</Link>
                      {me.user?.id === u.id && <span className="muted small"> (you)</span>}
                      {u.deactivated && <span className="muted small"> · deactivated, cannot sign in</span>}
                    </td>
                    <td>{u.email ?? <span className="muted">no email</span>}</td>
                    <td>
                      <div className="role-chips">
                        {assigned.length === 0 && <span className="muted small">No role</span>}
                        {assigned.map(({ role, assignmentId }) => (
                          <span key={assignmentId} className={`role-chip${role.is_admin ? ' admin' : ''}`}>
                            {role.name}
                            <button
                              className="icon-btn"
                              aria-label={`Remove ${role.name}`}
                              onClick={() => run(() => api('DELETE', `/v1/roles/${role.id}/assignments/${assignmentId}`))}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                        {available.length > 0 && (
                          <select
                            className="role-add"
                            value=""
                            aria-label={`Add a role for ${u.name}`}
                            onChange={(e) => run(() => api('POST', `/v1/roles/${e.target.value}/assignments`, { user_id: u.id }))}
                          >
                            <option value="">Add role…</option>
                            {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </select>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function RoleSettings() {
  const { objects } = useApp();
  const { roles, users, loaded, error, setError, reloadRoles } = useAccessData();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; description: string; is_admin: boolean; record_access: Role['record_access'] }>({
    name: '', description: '', is_admin: false, record_access: 'all'
  });
  const [message, setMessage] = useState<string | null>(null);

  const role = selected && selected !== 'new' ? roles.find((r) => r.id === selected) ?? null : null;

  // id is a role id or 'new'
  function pick(id: string, list = roles) {
    setSelected(id);
    setMessage(null);
    setError(null);
    const r = list.find((x) => x.id === id);
    setDraft(r
      ? { name: r.name, description: r.description ?? '', is_admin: r.is_admin, record_access: r.record_access }
      : { name: '', description: '', is_admin: false, record_access: 'all' });
  }

  useEffect(() => {
    if (loaded && selected === null && roles.length) pick(roles[0].id);
  }, [loaded, roles]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    setMessage(null);
    try {
      const result = await fn();
      await reloadRoles();
      if (done) setMessage(done);
      return result;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = { name: draft.name.trim(), description: draft.description.trim() || null, is_admin: draft.is_admin, record_access: draft.record_access };
    if (!body.name) return setError('A role needs a name.');
    if (selected === 'new') {
      const created = (await run(() => api<Role>('POST', '/v1/roles', body), 'Role created.')) as Role | undefined;
      if (created) {
        setSelected(created.id);
        setMessage('Role created. Now choose which objects it can use.');
      }
    } else if (role) {
      await run(() => api('PATCH', `/v1/roles/${role.id}`, body), 'Saved.');
    }
  }

  async function remove() {
    if (!role || !window.confirm(`Delete the role "${role.name}"? Its users lose the access it gave them.`)) return;
    const list = (await run(() => api('DELETE', `/v1/roles/${role.id}`).then(reloadRoles))) as Role[] | undefined;
    if (list) {
      setSelected(null);
      if (list.length) pick(list[0].id, list);
    }
  }

  // create/edit/delete imply read; no read means none of the others
  function setPermission(objectTypeId: string, apiName: string, key: keyof Omit<ObjectPermission, 'object_type_id'>, value: boolean) {
    if (!role) return;
    const cur = role.object_permissions.find((p) => p.object_type_id === objectTypeId) ?? { object_type_id: objectTypeId, can_read: false, can_create: false, can_edit: false, can_delete: false };
    const next = { ...cur, [key]: value };
    if (key === 'can_read' && !value) Object.assign(next, { can_create: false, can_edit: false, can_delete: false });
    if (key !== 'can_read' && value) next.can_read = true;
    const { object_type_id: _, ...body } = next;
    run(() => api('PUT', `/v1/roles/${role.id}/object-permissions/${apiName}`, body));
  }

  const members = role
    ? role.assignments.map((a) => (a.user_id ? users.find((u) => u.id === a.user_id)?.name ?? `user ${a.user_id}` : `team ${a.team_id}`))
    : [];

  return (
    <section>
      <h2>Roles</h2>
      <p className="muted">
        A role decides which objects its users can read, create, edit and delete, and which records they see. Someone with
        several roles gets the most permissive combination. Assign roles on the <Link to="/settings/users">Users</Link> page.
      </p>
      <div className="actions">
        <label className="field inline">
          <span>Role</span>
          <select value={selected ?? ''} onChange={(e) => pick(e.target.value)}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}{r.is_admin ? ' (admin)' : ''}</option>)}
            {selected === 'new' && <option value="new">New role</option>}
          </select>
        </label>
        <button className="btn" onClick={() => pick('new')}><Plus size={14} /> New role</button>
      </div>

      {(role || selected === 'new') && (
        <form className="role-form" onSubmit={save}>
          <label className="field">
            <span>Name</span>
            <input value={draft.name} maxLength={63} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Description</span>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <div className="checks">
            <label>
              <input type="checkbox" checked={draft.is_admin} onChange={(e) => setDraft({ ...draft, is_admin: e.target.checked })} />
              Admin: full access to every object, record and setting
            </label>
          </div>
          {!draft.is_admin && (
            <label className="field">
              <span>Records they see</span>
              <select value={draft.record_access} onChange={(e) => setDraft({ ...draft, record_access: e.target.value as Role['record_access'] })}>
                {RECORD_ACCESS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          <div className="actions">
            <button className="btn primary">{selected === 'new' ? 'Create role' : 'Save role'}</button>
            {role && <button type="button" className="btn" onClick={remove}><Trash2 size={14} /> Delete role</button>}
            {message && <span className="muted small">{message}</span>}
          </div>
        </form>
      )}
      {error && <div className="error">{error}</div>}

      {role && (
        <>
          <h3>Members</h3>
          <p className={members.length ? '' : 'muted'}>{members.length ? members.join(', ') : 'Nobody has this role yet.'}</p>

          <h3>Object access</h3>
          {!role.is_admin && !role.object_permissions.some((p) => p.can_read) && (
            <div className="error">This role cannot read any object yet, so its users see nothing. Tick Read for the objects they should use.</div>
          )}
          {role.is_admin ? (
            <p className="muted">Admin roles can use every object.</p>
          ) : (
            <div className="access-table">
              <table className="grid">
                <thead>
                  <tr><th>Object</th><th>Read</th><th>Create</th><th>Edit</th><th>Delete</th></tr>
                </thead>
                <tbody>
                  {objects.map((o) => {
                    const p = role.object_permissions.find((x) => x.object_type_id === o.object_type_id);
                    return (
                      <tr key={o.object_type_id}>
                        <td>{o.label_plural}</td>
                        {(['can_read', 'can_create', 'can_edit', 'can_delete'] as const).map((k) => (
                          <td key={k}>
                            <input
                              type="checkbox"
                              aria-label={`${o.label_plural}: ${k.slice(4)}`}
                              checked={p?.[k] ?? false}
                              onChange={(e) => setPermission(o.object_type_id, o.api_name, k, e.target.checked)}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
