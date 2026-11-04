import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { EllipsisVertical, Plus, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { api, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { displayName, initials } from '../lib/display';
import { SharingRules } from '../components/SharingRules';
import { EmptyState, SaveBar, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';
import { Menu } from '../components/ui';
import { confirmDialog } from '../components/confirm';

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

type PermissionKey = keyof Omit<ObjectPermission, 'object_type_id'>;

const PERMISSION_COLUMNS: { key: PermissionKey; label: string }[] = [
  { key: 'can_read', label: 'Read' },
  { key: 'can_create', label: 'Create' },
  { key: 'can_edit', label: 'Edit' },
  { key: 'can_delete', label: 'Delete' }
];

// create/edit/delete imply read; no read means none of the others
function applyPermission(cur: ObjectPermission, key: PermissionKey, value: boolean): ObjectPermission {
  const next = { ...cur, [key]: value };
  if (key === 'can_read' && !value) Object.assign(next, { can_create: false, can_edit: false, can_delete: false });
  if (key !== 'can_read' && value) next.can_read = true;
  return next;
}

// header checkbox that ticks or clears a whole column; shows a dash when only some rows are ticked
function ColumnCheck({ label, checked, partial, onChange }: { label: string; checked: boolean; partial: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="column-check">
      {label}
      <input
        type="checkbox"
        aria-label={`${label}: all objects`}
        checked={checked}
        ref={(el) => { if (el) el.indeterminate = partial; }}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
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

  const reloadUsers = useCallback(async () => {
    const r = await api<SearchResult>('POST', '/v1/objects/users/search', { limit: 200, properties: ['name', 'first_name', 'last_name', 'email', 'status'], sorts: [{ property: 'name', direction: 'asc' }] });
    setUsers(r.results.map((u) => ({
      id: u.id,
      name: displayName(u.properties, u.id),
      email: (u.properties.email as string) ?? null,
      deactivated: ([] as unknown[]).concat(u.properties.status ?? []).includes('deactivated')
    })));
  }, []);

  useEffect(() => {
    Promise.all([reloadRoles(), reloadUsers()])
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoaded(true));
  }, [reloadRoles, reloadUsers]);

  return { roles, users, loaded, error, setError, reloadRoles, reloadUsers };
}

export function UserSettings() {
  const { me } = useApp();
  const { roles, users, loaded, error, setError, reloadRoles, reloadUsers } = useAccessData();

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

  // "Sign in as": Super Admins, on another active user who is not a Super Admin
  // (the API checks all of this again; same rule as the user record's menu)
  async function signInAs(u: UserRow) {
    if (!(await confirmDialog('Until you go back to your own account you will see and do everything as them, with their permissions, and every change is recorded as theirs.', { title: `Sign in as ${u.name}?`, confirmLabel: 'Sign in as them' }))) return;
    try {
      await api('POST', `/v1/users/${u.id}/sign-in-as`);
      // a full load, so the menu, objects and views are theirs
      window.location.assign('/');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function setStatus(u: UserRow, status: 'active' | 'deactivated') {
    if (status === 'deactivated' && !(await confirmDialog('They are signed out everywhere, can no longer sign in, and API keys linked to them stop working.', { title: `Deactivate ${u.name}?`, confirmLabel: 'Deactivate', danger: true }))) return;
    setError(null);
    try {
      await api('PATCH', `/v1/objects/users/${u.id}`, { properties: { status: [status] } });
      await reloadUsers();
    } catch (err) {
      setError((err as Error).message);
    }
  }

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
              <tr><th>Name</th><th>Email</th><th>Roles</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const assigned = rolesOf(u.id);
                const available = roles.filter((r) => !assigned.some((a) => a.role.id === r.id));
                const isMe = me.user?.id === u.id;
                const canSignInAs = me.is_admin && !me.signed_in_as_by && !isMe && !u.deactivated && !assigned.some((a) => a.role.is_admin);
                return (
                  <tr key={u.id}>
                    <td className="primary-cell">
                      <span className="person">
                        <span className="person-avatar">{initials(u.name)}</span>
                        <Link to={`/objects/users/${u.id}`}>{u.name}</Link>
                        {isMe && <span className="muted small">You</span>}
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
                          <Select
                            className="role-add"
                            value=""
                            aria-label={`Add a role for ${u.name}`}
                            onChange={(v) => run(() => api('POST', `/v1/roles/${v}/assignments`, { user_id: u.id }))}
                          >
                            <option value="">Add role</option>
                            {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                          </Select>
                        )}
                      </div>
                    </td>
                    <td className="row-actions">
                      {(canSignInAs || !isMe) && (
                        <Menu
                          align="right"
                          trigger={(toggle) => (
                            <button className="icon-btn" onClick={toggle} aria-label={`Actions for ${u.name}`}>
                              <EllipsisVertical size={16} />
                            </button>
                          )}
                        >
                          {(close) => (
                            <>
                              {canSignInAs && <button onClick={() => { close(); signInAs(u); }}>Sign in as {u.name}</button>}
                              {!isMe && (u.deactivated
                                ? <button onClick={() => { close(); setStatus(u, 'active'); }}>Reactivate</button>
                                : <button className="danger" onClick={() => { close(); setStatus(u, 'deactivated'); }}>Deactivate</button>)}
                            </>
                          )}
                        </Menu>
                      )}
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

  // unsaved changes to the role's details (permissions and sharing rules save as they change)
  const dirty = selected === 'new'
    ? draft.name.trim() !== '' || draft.description.trim() !== '' || draft.is_admin
    : !!role && (draft.name !== role.name || draft.description !== (role.description ?? '') || draft.is_admin !== role.is_admin || draft.record_access !== role.record_access);

  // id is a role id or 'new'
  async function pick(id: string, list = roles) {
    if (id !== selected && dirty && !(await confirmDialog('Your unsaved changes to this role are lost.', { title: 'Discard changes?', confirmLabel: 'Discard', danger: true }))) return;
    load(id, list);
  }

  function load(id: string, list = roles) {
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

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!dirty) return;
    const body = { name: draft.name.trim(), description: draft.description.trim() || null, is_admin: draft.is_admin, record_access: draft.record_access };
    if (!body.name) return setError('A role needs a name.');
    if (selected === 'new') {
      const created = (await run(() => api<Role>('POST', '/v1/roles', body), 'Role created.')) as Role | undefined;
      if (created) {
        setSelected(created.id);
        setDraft({ name: created.name, description: created.description ?? '', is_admin: created.is_admin, record_access: created.record_access });
        setMessage('Role created. Now choose which objects it can use.');
      }
    } else if (role) {
      await run(() => api('PATCH', `/v1/roles/${role.id}`, body), 'Saved.');
    }
  }

  async function remove() {
    if (!role || !(await confirmDialog('Its users lose the access it gave them.', { title: `Delete the role "${role.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    const list = (await run(() => api('DELETE', `/v1/roles/${role.id}`).then(reloadRoles))) as Role[] | undefined;
    if (list) {
      setSelected(null);
      if (list.length) load(list[0].id, list);
    }
  }

  const permissionOf = (objectTypeId: string): ObjectPermission =>
    role?.object_permissions.find((p) => p.object_type_id === objectTypeId)
      ?? { object_type_id: objectTypeId, can_read: false, can_create: false, can_edit: false, can_delete: false };

  function putPermission(roleId: string, apiName: string, next: ObjectPermission) {
    const { object_type_id: _, ...body } = next;
    return api('PUT', `/v1/roles/${roleId}/object-permissions/${apiName}`, body);
  }

  function setPermission(objectTypeId: string, apiName: string, key: PermissionKey, value: boolean) {
    if (!role) return;
    run(() => putPermission(role.id, apiName, applyPermission(permissionOf(objectTypeId), key, value)));
  }

  // ticks or clears one column for every object, saving only the rows that change
  function setColumn(key: PermissionKey, value: boolean) {
    if (!role) return;
    const changes = objects
      .map((o) => ({ o, cur: permissionOf(o.object_type_id) }))
      .map(({ o, cur }) => ({ o, cur, next: applyPermission(cur, key, value) }))
      .filter(({ cur, next }) => PERMISSION_COLUMNS.some((c) => cur[c.key] !== next[c.key]));
    if (!changes.length) return;
    run(() => Promise.all(changes.map(({ o, next }) => putPermission(role.id, o.api_name, next))));
  }

  const members = role
    ? role.assignments.map((a) => ({ id: a.id, name: a.user_id ? users.find((u) => u.id === a.user_id)?.name ?? `User ${a.user_id}` : `Team ${a.team_id}` }))
    : [];
  const accessLabel = (r: Role) => (r.is_admin ? 'Super Admin' : RECORD_ACCESS.find((o) => o.value === r.record_access)?.label);

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
            {error && <div className="error">{error}</div>}
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
                    Super Admin: full access to every object, record and setting
                  </label>
                  {!draft.is_admin && (
                    <label className="field">
                      <span>Which records can people with this role see?</span>
                      <Select value={draft.record_access} onChange={(v) => setDraft({ ...draft, record_access: v as Role['record_access'] })}>
                        {RECORD_ACCESS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                      {draft.record_access !== 'all' && <span className="muted small">Plus anything a sharing rule below opens up.</span>}
                    </label>
                  )}
                  {role && (
                    <div className="actions">
                      <button type="button" className="btn ghost danger-text" onClick={remove}><Trash2 size={14} /> Delete role</button>
                    </div>
                  )}
                </form>
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

                <SettingsSection title="Object access" description={role.is_admin ? 'Super Admin roles can use every object.' : 'Create, edit and delete each include read.'}>
                  {!role.is_admin && !role.object_permissions.some((p) => p.can_read) && (
                    <div className="callout warn">This role cannot read any object yet, so its users see nothing. Tick Read for the objects they should use.</div>
                  )}
                  {!role.is_admin && (
                    <div className="access-table">
                      <table className="grid">
                        <thead>
                          <tr>
                            <th>Object</th>
                            {PERMISSION_COLUMNS.map((c) => {
                              const ticked = objects.filter((o) => permissionOf(o.object_type_id)[c.key]).length;
                              return (
                                <th key={c.key} className="cell-check">
                                  <ColumnCheck
                                    label={c.label}
                                    checked={objects.length > 0 && ticked === objects.length}
                                    partial={ticked > 0 && ticked < objects.length}
                                    onChange={(v) => setColumn(c.key, v)}
                                  />
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {objects.map((o) => {
                            const p = permissionOf(o.object_type_id);
                            return (
                              <tr key={o.object_type_id}>
                                <td>{o.label_plural}</td>
                                {PERMISSION_COLUMNS.map(({ key: k }) => (
                                  <td key={k} className="cell-check">
                                    <input
                                      type="checkbox"
                                      aria-label={`${o.label_plural}: ${k.slice(4)}`}
                                      checked={p[k]}
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
      {loaded && (role || selected === 'new') && (
        <SaveBar dirty={dirty} message={message}>
          <button className="btn" disabled={!dirty} onClick={() => {
            if (selected === 'new') { setSelected(null); if (roles.length) load(roles[0].id); return; }
            if (role) setDraft({ name: role.name, description: role.description ?? '', is_admin: role.is_admin, record_access: role.record_access });
          }}>{selected === 'new' ? 'Cancel' : 'Discard'}</button>
          <button className="btn primary" disabled={!dirty} onClick={() => void save()}>{selected === 'new' ? 'Create role' : 'Save role'}</button>
        </SaveBar>
      )}
    </SettingsPage>
  );
}
