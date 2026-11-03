import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { api, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { displayName, initials } from '../lib/display';
import { SharingRules } from '../components/SharingRules';
import { EmptyState, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';

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
  { value: 'own', label: 'Only records they own' },
  { value: 'team', label: "Their team's records" },
  { value: 'all', label: 'All records' }
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
    <SettingsPage
      title="Users"
      description={<>
        People sign in with Google or Microsoft when their email matches a user here whose Status is not Deactivated. What
        they can see comes from their roles; a user with no role sees nothing.
      </>}
      actions={<Link className="btn primary" to="/objects/users"><Plus size={14} /> Add a user</Link>}
    >
      {error && <div className="error">{error}</div>}
      {!loaded && <TableSkeleton rows={4} />}
      {loaded && users.length === 0 && (
        <EmptyState icon={<Users size={18} />} title="No users yet" action={<Link className="btn primary" to="/objects/users">Add a user</Link>}>
          Create a user record with someone's email so they can sign in.
        </EmptyState>
      )}
      {loaded && users.length > 0 && (
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
                      <span className="person">
                        <span className="person-avatar">{initials(u.name)}</span>
                        <Link to={`/objects/users/${u.id}`}>{u.name}</Link>
                        {me.user?.id === u.id && <span className="muted small">You</span>}
                        {u.deactivated && <StatusPill tone="off">Deactivated</StatusPill>}
                      </span>
                    </td>
                    <td>{u.email ?? <span className="muted">No email</span>}</td>
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
                            <option value="">Add role</option>
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
    </SettingsPage>
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
    ? role.assignments.map((a) => ({ id: a.id, name: a.user_id ? users.find((u) => u.id === a.user_id)?.name ?? `User ${a.user_id}` : `Team ${a.team_id}` }))
    : [];
  const accessLabel = (r: Role) => (r.is_admin ? 'Admin' : RECORD_ACCESS.find((o) => o.value === r.record_access)?.label);

  return (
    <SettingsPage
      className="wide"
      title="Roles"
      description={<>
        A role decides which objects its users can read, create, edit and delete, and which records they see. Someone with
        several roles gets the most permissive combination. Assign roles on the <Link to="/settings/users">Users</Link> page.
      </>}
      actions={<button className="btn primary" onClick={() => pick('new')}><Plus size={14} /> New role</button>}
    >
      {!loaded ? <TableSkeleton rows={4} /> : (
        <div className="roles-layout">
          <div className="role-list" role="list" aria-label="Roles">
            {roles.map((r) => (
              <button key={r.id} role="listitem" className={selected === r.id ? 'active' : ''} onClick={() => pick(r.id)} aria-current={selected === r.id}>
                {r.name}
                <span>{accessLabel(r)}</span>
              </button>
            ))}
            {selected === 'new' && <button role="listitem" className="active" aria-current>New role<span>Not saved yet</span></button>}
            {roles.length === 0 && selected !== 'new' && <span className="muted small">No roles yet.</span>}
          </div>

          <div className="role-editor">
            {!role && selected !== 'new' && (
              <EmptyState icon={<ShieldCheck size={18} />} title="No role chosen" action={<button className="btn primary" onClick={() => pick('new')}>New role</button>}>
                Pick a role on the left, or create one.
              </EmptyState>
            )}
            {(role || selected === 'new') && (
              <SettingsSection title={selected === 'new' ? 'New role' : 'Details'}>
                <form className="role-form" onSubmit={save}>
                  <label className="field">
                    <span>Name</span>
                    <input value={draft.name} maxLength={63} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>Description</span>
                    <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={draft.is_admin} onChange={(e) => setDraft({ ...draft, is_admin: e.target.checked })} />
                    Admin: full access to every object, record and setting
                  </label>
                  {!draft.is_admin && (
                    <label className="field">
                      <span>Which records can people with this role see?</span>
                      <select value={draft.record_access} onChange={(e) => setDraft({ ...draft, record_access: e.target.value as Role['record_access'] })}>
                        {RECORD_ACCESS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      {draft.record_access !== 'all' && <span className="muted small">Plus anything a sharing rule below opens up.</span>}
                    </label>
                  )}
                  <div className="actions">
                    <button className="btn primary">{selected === 'new' ? 'Create role' : 'Save role'}</button>
                    {role && <button type="button" className="btn ghost danger-text" onClick={remove}><Trash2 size={14} /> Delete role</button>}
                    {message && <span className="muted small" role="status">{message}</span>}
                  </div>
                </form>
                {error && <div className="error">{error}</div>}
              </SettingsSection>
            )}

            {role && (
              <>
                <SettingsSection title="Members" description={members.length ? undefined : 'Nobody has this role yet. Assign it on the Users page.'}>
                  {members.length > 0 && (
                    <div className="member-list">
                      {members.map((m) => (
                        <span key={m.id} className="person"><span className="person-avatar">{initials(m.name)}</span>{m.name}</span>
                      ))}
                    </div>
                  )}
                </SettingsSection>

                <SettingsSection title="Object access" description={role.is_admin ? 'Admin roles can use every object.' : 'Create, edit and delete each include read.'}>
                  {!role.is_admin && !role.object_permissions.some((p) => p.can_read) && (
                    <div className="callout warn">This role cannot read any object yet, so its users see nothing. Tick Read for the objects they should use.</div>
                  )}
                  {!role.is_admin && (
                    <div className="access-table">
                      <table className="grid">
                        <thead>
                          <tr><th>Object</th><th className="cell-check">Read</th><th className="cell-check">Create</th><th className="cell-check">Edit</th><th className="cell-check">Delete</th></tr>
                        </thead>
                        <tbody>
                          {objects.map((o) => {
                            const p = role.object_permissions.find((x) => x.object_type_id === o.object_type_id);
                            return (
                              <tr key={o.object_type_id}>
                                <td>{o.label_plural}</td>
                                {(['can_read', 'can_create', 'can_edit', 'can_delete'] as const).map((k) => (
                                  <td key={k} className="cell-check">
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
                </SettingsSection>

                {!role.is_admin && <SharingRules roleId={role.id} recordAccess={role.record_access} />}
              </>
            )}
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
