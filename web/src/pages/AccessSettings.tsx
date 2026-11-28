import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { EllipsisVertical, Plus, ShieldCheck, Table2, Trash2, Users, X } from 'lucide-react';
import { API_BASE, api, can, type RolePermission, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { displayName } from '../lib/display';
import { primaryValue } from '../lib/multi-values';
import { UserAvatar } from '../components/UserAvatar';
import { SharingRules } from '../components/SharingRules';
import { EmptyState, SaveBar, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';
import { Menu } from '../components/ui';
import { confirmDialog } from '../components/confirm';
import { SaveHint } from '../components/SaveHint';
import { CreateUserModal, preloadCreateUser } from '../components/CreateUserModal';
import { CALENDAR_ERRORS } from './CalendarSettings';

// Admin pages for who can see what: users get roles (directly; team
// assignments made through the API are shown too), roles get object access
// (on the records they own, or on all records) and permissions for settings.

// can_read, can_edit and can_delete reach the records the role's users own;
// the *_all switches reach every record
interface ObjectPermission {
  object_type_id: string;
  can_read: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_read_all: boolean;
  can_edit_all: boolean;
  can_delete_all: boolean;
}

// ids are bigints, which the API sends as strings
interface Role {
  id: string;
  name: string;
  description: string | null;
  is_admin: boolean;
  // what "records they own" means: owned by them, or by them or a teammate
  record_access: 'own' | 'team';
  knowledge_access: 'none' | 'read' | 'edit';
  permissions: RolePermission[];
  object_permissions: ObjectPermission[];
  assignments: { id: string; user_id: string | null; team_id: string | null }[];
}

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  deactivated: boolean;
}

// GET /v1/users/connections: whether each user's mail and calendar reach the CRM; the details come with
// the Users or Roles permission
interface UserConnections {
  user_id: string;
  email: boolean;
  calendar: boolean;
  mailboxes?: { address: string; provider: 'google' | 'microsoft' | null; linked_id: string | null }[];
  calendars?: { id: string; provider: 'google' | 'microsoft'; email: string | null; status: string; via_service: boolean }[];
  linkable?: string[];
}
const CALENDAR_PROVIDER = { google: 'Google Calendar', microsoft: 'Outlook calendar' };

type PermissionKey = keyof Omit<ObjectPermission, 'object_type_id'>;

// the table's columns, grouped under Read, Create, Edit and Delete
const PERMISSION_GROUPS: { label: string; columns: { key: PermissionKey; label: string }[] }[] = [
  { label: 'Read', columns: [{ key: 'can_read', label: 'Own' }, { key: 'can_read_all', label: 'All' }] },
  { label: 'Create', columns: [{ key: 'can_create', label: '' }] },
  { label: 'Edit', columns: [{ key: 'can_edit', label: 'Own' }, { key: 'can_edit_all', label: 'All' }] },
  { label: 'Delete', columns: [{ key: 'can_delete', label: 'Own' }, { key: 'can_delete_all', label: 'All' }] }
];
const PERMISSION_COLUMNS = PERMISSION_GROUPS.flatMap((g) => g.columns.map((c) => ({ ...c, group: g.label })));
const columnName = (c: { group: string; label: string }) => (c.label ? `${c.group} ${c.label === 'Own' ? 'own records' : 'all records'}` : c.group);

const NO_ACCESS = { can_read: false, can_create: false, can_edit: false, can_delete: false, can_read_all: false, can_edit_all: false, can_delete_all: false };

// Turning one switch on or off keeps the rest consistent (the API does the
// same): "all" includes "own", create/edit/delete include read, edit all and
// delete all include read all. Off works the other way round.
function applyPermission(cur: ObjectPermission, key: PermissionKey, value: boolean): ObjectPermission {
  const n = { ...cur, [key]: value };
  if (value) {
    if (key === 'can_edit_all') n.can_edit = true;
    if (key === 'can_delete_all') n.can_delete = true;
    if (n.can_edit_all || n.can_delete_all) n.can_read_all = true;
    if (n.can_read_all || n.can_create || n.can_edit || n.can_delete) n.can_read = true;
  } else {
    if (key === 'can_read') Object.assign(n, NO_ACCESS);
    if (key === 'can_read_all') Object.assign(n, { can_edit_all: false, can_delete_all: false });
    if (key === 'can_edit') n.can_edit_all = false;
    if (key === 'can_delete') n.can_delete_all = false;
  }
  return n;
}

// Permissions besides objects, in the order shown
const ROLE_PERMISSIONS: { key: RolePermission; label: string; hint: string }[] = [
  { key: 'users', label: 'Users', hint: 'Add users, give and take roles, send invites, see sign-in history and sign people out. Adding and deactivating users also needs Create and Edit on Users under Object access.' },
  { key: 'roles', label: 'Roles', hint: 'Create and change roles, their object access, permissions and sharing rules, and give roles to users.' },
  { key: 'properties', label: 'Properties', hint: 'Add, change and archive properties and dropdown choices, and manage option lists.' },
  { key: 'import', label: 'Import', hint: 'Import records from a spreadsheet, for objects the role can create.' },
  { key: 'export', label: 'Export', hint: 'Export records it can read to CSV or Excel.' },
  { key: 'integrations', label: 'Integrations', hint: 'Embed domains, view integrations, webhooks, mailboxes, meetings, notification emails, payments, email, card scanner and address autocomplete.' },
  { key: 'api_keys', label: 'API keys', hint: 'Create, rotate and revoke API keys.' },
  { key: 'security_log', label: 'Security log', hint: 'See sign-ins, key and role changes, and exports.' },
  { key: 'owner_rotations', label: 'Owner rotations', hint: 'Create and change owner rotations (who gets new records, time off, boosts, shares, pause) and see their log and report. Connected apps such as Claude can be given this one.' }
];

// header checkbox that ticks or clears a whole column; shows a dash when only some rows are ticked
function ColumnCheck({ label, name, checked, partial, onChange }: { label: string; name?: string; checked: boolean; partial: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="column-check">
      {label}
      <input
        type="checkbox"
        aria-label={`${name ?? label}: every object`}
        checked={checked}
        ref={(el) => { if (el) el.indeterminate = partial; }}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

const KNOWLEDGE_ACCESS: { value: Role['knowledge_access']; label: string }[] = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read' },
  { value: 'edit', label: 'Read and edit (add, change, delete articles)' }
];

const RECORD_ACCESS: { value: Role['record_access']; label: string }[] = [
  { value: 'own', label: 'Records they own' },
  { value: 'team', label: 'Records they or their team own' }
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
    const r = await api<SearchResult>('QUERY', '/v1/objects/users/search', { limit: 200, properties: ['name', 'first_name', 'last_name', 'email', 'status'], sorts: [{ property: 'name', direction: 'asc' }] });
    setUsers(r.results.map((u) => ({
      id: u.id,
      name: displayName(u.properties, u.id),
      email: primaryValue(u.properties.email),
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
  const { me, toast } = useApp();
  const { roles, users, loaded, error, setError, reloadRoles, reloadUsers } = useAccessData();
  const [show, setShow] = useState<'active' | 'deactivated'>('active');
  const [creating, setCreating] = useState(false);
  const shown = users.filter((u) => (show === 'active') === !u.deactivated);
  // giving roles (and so adding users): the Users or Roles permission; invites,
  // deactivating and sign-outs: Users. Super Admin roles, and the roles of a
  // Super Admin, stay with Super Admins (the API checks all of this again).
  const canAssign = can(me, 'users') || can(me, 'roles');
  const canManage = can(me, 'users');
  // email and calendar for each user; Super Admins can connect them for someone else
  const [connections, setConnections] = useState<Map<string, UserConnections> | null>(null);
  const [canConnect, setCanConnect] = useState(false);
  const [calendarConfig, setCalendarConfig] = useState<{ google: boolean; microsoft: boolean }>({ google: false, microsoft: false });
  const [notice, setNotice] = useState<string | null>(null);
  const reloadConnections = useCallback(async () => {
    const r = await api<{ results: UserConnections[]; can_connect: boolean }>('GET', '/v1/users/connections');
    setConnections(new Map(r.results.map((c) => [c.user_id, c])));
    setCanConnect(r.can_connect);
  }, []);
  useEffect(() => {
    reloadConnections().catch(() => setConnections(null));
    api<{ google: boolean; microsoft: boolean }>('GET', '/v1/calendar/config').then(setCalendarConfig).catch(() => undefined);
  }, [reloadConnections]);
  // back from connecting a calendar for someone (the provider round trip), shown once
  const [params] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    const failed = params.get('calendar_error');
    if (params.get('calendar') === 'connected') toast('Calendar connected');
    else if (failed) setNotice([CALENDAR_ERRORS[failed] ?? CALENDAR_ERRORS.failed, params.get('calendar_detail')].filter(Boolean).join(' '));
    if (params.has('calendar') || failed) navigate('/settings/users', { replace: true });
  }, [params, navigate, toast]);
  useEffect(() => { if (canAssign) preloadCreateUser(); }, [canAssign]);
  // the sign-in options this CRM has set up, named in the description
  const [signIn, setSignIn] = useState('Google or Microsoft');
  useEffect(() => {
    api<{ google?: boolean; microsoft?: boolean }>('GET', '/v1/auth/config', undefined, null)
      .then((c) => {
        if (c.google && !c.microsoft) setSignIn('Google');
        else if (c.microsoft && !c.google) setSignIn('Microsoft');
      })
      .catch(() => undefined);
  }, []);

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

  // an email from the system sender (Settings → Notification emails) asking them to sign in
  async function sendInvite(u: UserRow) {
    if (!(await confirmDialog(`They get an email at ${u.email} asking them to sign in.`, { title: `Send ${u.name} an invite?`, confirmLabel: 'Send invite' }))) return;
    setError(null);
    try {
      const r = await api<{ to: string }>('POST', `/v1/users/${u.id}/invite`);
      toast(`Invite on its way to ${r.to}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // the user's own address, reached through the organization's mailbox service account
  async function linkMailbox(u: UserRow, address: string) {
    if (!(await confirmDialog(`The CRM reaches ${address} through the organization's mailbox service account, as if ${u.name} had signed in with it: they can send from it, their email is logged by their setting, and their calendar is checked when Settings > Meetings has calendars on.`, { title: `Connect ${address}?`, confirmLabel: 'Connect' }))) return;
    await connectionChange(() => api('POST', `/v1/users/${u.id}/linked-mailboxes`, { address }), 'Connected');
  }

  async function connectCalendar(u: UserRow, provider: 'google' | 'microsoft') {
    if (!(await confirmDialog(`You go to ${provider === 'google' ? 'Google' : 'Microsoft'} next. Sign in there with ${u.name}'s account (not yours) and allow calendar access; the calendar is then connected for them.`, { title: `Connect a calendar for ${u.name}?`, confirmLabel: 'Continue' }))) return;
    window.location.href = `${API_BASE}/v1/calendar/${provider}/connect?for=${encodeURIComponent(u.id)}`;
  }

  async function removeConnection(u: UserRow, what: string, path: string) {
    if (!(await confirmDialog(`${u.name} can connect it again, or you can.`, { title: `Remove ${what}?`, confirmLabel: 'Remove', danger: true }))) return;
    await connectionChange(() => api('DELETE', path), 'Removed');
  }

  async function connectionChange(fn: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await fn();
      toast(message);
      await reloadConnections();
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
        People sign in with {signIn} when their email matches a user here whose Status is not Deactivated. What
        they can see comes from their roles; a user with no role sees nothing.
      </>}
      actions={<>
        <Link className="btn" to="/objects/users"><Table2 size={14} /> View table</Link>
        {canAssign && <button className="btn primary" onClick={() => setCreating(true)}><Plus size={14} /> Add a user</button>}
      </>}
    >
      {loaded && users.length > 0 && (
        <div className="settings-toolbar">
          <div className="segmented" role="group" aria-label="Which users">
            <button type="button" aria-pressed={show === 'active'} onClick={() => setShow('active')}>Active</button>
            <button type="button" aria-pressed={show === 'deactivated'} onClick={() => setShow('deactivated')}>Deactivated</button>
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {notice && <div className="error">{notice}</div>}
      {!loaded && <TableSkeleton rows={4} />}
      {loaded && users.length === 0 && (
        <EmptyState icon={<Users size={18} />} title="No users yet" action={canAssign ? <button className="btn primary" onClick={() => setCreating(true)}>Add a user</button> : undefined}>
          Create a user record with someone's email so they can sign in.
        </EmptyState>
      )}
      {loaded && users.length > 0 && shown.length === 0 && (
        <EmptyState icon={<Users size={18} />} title={show === 'active' ? 'No active users' : 'No deactivated users'}>
          Nothing matches this filter.
        </EmptyState>
      )}
      {loaded && shown.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Status</th><th>Connected</th><th>Roles</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {shown.map((u) => {
                const assigned = rolesOf(u.id);
                const userIsSuperAdmin = assigned.some((a) => a.role.is_admin);
                const canChange = (roleIsAdmin: boolean) => canAssign && (me.is_admin || (!roleIsAdmin && !userIsSuperAdmin));
                const available = roles.filter((r) => canChange(r.is_admin) && !assigned.some((a) => a.role.id === r.id));
                const isMe = me.user?.id === u.id;
                const canSignInAs = me.is_admin && !me.signed_in_as_by && !isMe && !u.deactivated && !userIsSuperAdmin;
                const canSetStatus = canManage && !isMe && (me.is_admin || !userIsSuperAdmin);
                const canInvite = canManage && !u.deactivated && !!u.email;
                const conn = connections?.get(u.id);
                const linkable = canConnect && !u.deactivated ? conn?.linkable ?? [] : [];
                const linked = canConnect ? (conn?.mailboxes ?? []).filter((m) => m.linked_id) : [];
                const ownCalendars = canConnect ? (conn?.calendars ?? []).filter((c) => !c.via_service) : [];
                const calendarProviders = canConnect && !isMe && !u.deactivated ? (['google', 'microsoft'] as const).filter((p) => calendarConfig[p]) : [];
                const connectItems = linkable.length + linked.length + ownCalendars.length + calendarProviders.length > 0;
                return (
                  <tr key={u.id}>
                    <td className="primary-cell">
                      <span className="person">
                        <UserAvatar userId={u.id} name={u.name} className="person-avatar" />
                        <Link to={`/objects/users/${u.id}`}>{u.name}</Link>
                        {isMe && <span className="muted small">You</span>}
                      </span>
                    </td>
                    <td>{u.email ?? <span className="muted">No email</span>}</td>
                    <td>{u.deactivated ? <StatusPill tone="off">Deactivated</StatusPill> : <StatusPill tone="on">Active</StatusPill>}</td>
                    <td>
                      {conn && !u.deactivated && (
                        <span className="connection-pills">
                          <span title={conn.mailboxes?.length ? conn.mailboxes.map((m) => `${m.address}${m.provider ? '' : ' (no mailbox service account for this domain)'}${m.linked_id ? ', connected by an admin' : ''}`).join('\n') : conn.email ? undefined : 'Not connected: they have not signed in with Google or Microsoft in a domain set up in Settings > Mailboxes'}>
                            <StatusPill tone={conn.email ? 'on' : 'off'}>{conn.email ? 'Email' : 'No email'}</StatusPill>
                          </span>
                          <span title={conn.calendars?.length ? conn.calendars.map((c) => `${c.email ?? CALENDAR_PROVIDER[c.provider]}${c.via_service ? ' (through the organization)' : ''}${c.status !== 'active' ? `, ${c.status.replace(/_/g, ' ')}` : ''}`).join('\n') : conn.calendar ? undefined : 'No connected calendar'}>
                            <StatusPill tone={conn.calendar ? 'on' : conn.calendars?.length ? 'warn' : 'off'}>{conn.calendar ? 'Calendar' : 'No calendar'}</StatusPill>
                          </span>
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="role-chips">
                        {assigned.length === 0 && <span className="muted small">No role</span>}
                        {assigned.map(({ role, assignmentId }) => (
                          <span key={assignmentId} className={`role-chip${role.is_admin ? ' admin' : ''}`}>
                            {role.name}
                            {canChange(role.is_admin) && (
                              <button
                                className="icon-btn"
                                aria-label={`Remove ${role.name}`}
                                onClick={() => run(() => api('DELETE', `/v1/roles/${role.id}/assignments/${assignmentId}`))}
                              >
                                <X size={12} />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="row-actions">
                      {(available.length > 0 || canSignInAs || canInvite || canSetStatus || connectItems) && (
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
                              {available.length > 0 && (
                                <>
                                  <div className="menu-label">Add role</div>
                                  {available.map((r) => (
                                    <button key={r.id} onClick={() => { close(); run(() => api('POST', `/v1/roles/${r.id}/assignments`, { user_id: u.id })); }}>
                                      <Plus size={14} /> {r.name}
                                    </button>
                                  ))}
                                  {(canSignInAs || canInvite || canSetStatus || connectItems) && <div className="menu-sep" />}
                                </>
                              )}
                              {connectItems && (
                                <>
                                  <div className="menu-label">Email and calendar</div>
                                  {linkable.map((a) => (
                                    <button key={a} onClick={() => { close(); linkMailbox(u, a); }}><Plus size={14} /> Connect {a} through the organization</button>
                                  ))}
                                  {calendarProviders.map((p) => (
                                    <button key={p} onClick={() => { close(); connectCalendar(u, p); }}><Plus size={14} /> Connect a {CALENDAR_PROVIDER[p]} for them</button>
                                  ))}
                                  {linked.map((m) => (
                                    <button key={m.address} className="danger" onClick={() => { close(); removeConnection(u, m.address, `/v1/users/${u.id}/linked-mailboxes/${m.linked_id}`); }}>Remove {m.address}</button>
                                  ))}
                                  {ownCalendars.map((c) => (
                                    <button key={c.id} className="danger" onClick={() => { close(); removeConnection(u, `the calendar ${c.email ?? CALENDAR_PROVIDER[c.provider]}`, `/v1/users/${u.id}/calendar-connections/${c.id}`); }}>Remove calendar {c.email ?? CALENDAR_PROVIDER[c.provider]}</button>
                                  ))}
                                  {(canSignInAs || canInvite || canSetStatus) && <div className="menu-sep" />}
                                </>
                              )}
                              {canSignInAs &&<button onClick={() => { close(); signInAs(u); }}>Sign in as {u.name}</button>}
                              {canInvite && <button onClick={() => { close(); sendInvite(u); }}>Send invite</button>}
                              {canSetStatus && (u.deactivated
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
      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            toast('User created');
            await Promise.all([reloadUsers(), reloadRoles()]).catch((err) => setError((err as Error).message));
          }}
        />
      )}
    </SettingsPage>
  );
}

type RoleDraft = Pick<Role, 'name' | 'is_admin' | 'record_access' | 'knowledge_access' | 'permissions'> & { description: string };
const EMPTY_DRAFT: RoleDraft = { name: '', description: '', is_admin: false, record_access: 'own', knowledge_access: 'read', permissions: [] };
const draftOf = (r: Role): RoleDraft => ({
  name: r.name, description: r.description ?? '', is_admin: r.is_admin, record_access: r.record_access, knowledge_access: r.knowledge_access, permissions: r.permissions ?? []
});
const samePermissions = (a: RolePermission[], b: RolePermission[]) => a.length === b.length && a.every((x) => b.includes(x));

export function RoleSettings() {
  const { me, objects } = useApp();
  const { roles, users, loaded, error, setError, reloadRoles } = useAccessData();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoleDraft>(EMPTY_DRAFT);
  const [message, setMessage] = useState<string | null>(null);

  const role = selected && selected !== 'new' ? roles.find((r) => r.id === selected) ?? null : null;
  // Super Admin roles are changed by Super Admins only (the API refuses others)
  const locked = !!role?.is_admin && !me.is_admin;

  // unsaved changes to the role's details (object access and sharing rules save as they change)
  const dirty = selected === 'new'
    ? draft.name.trim() !== '' || draft.description.trim() !== '' || draft.is_admin || draft.permissions.length > 0
    : !!role && (draft.name !== role.name || draft.description !== (role.description ?? '') || draft.is_admin !== role.is_admin || draft.record_access !== role.record_access
      || draft.knowledge_access !== role.knowledge_access || !samePermissions(draft.permissions, role.permissions ?? []));

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
    setDraft(r ? draftOf(r) : EMPTY_DRAFT);
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
    const body = {
      name: draft.name.trim(), description: draft.description.trim() || null, is_admin: draft.is_admin, record_access: draft.record_access,
      knowledge_access: draft.knowledge_access, permissions: draft.permissions
    };
    if (!body.name) return setError('A role needs a name.');
    if (selected === 'new') {
      const created = (await run(() => api<Role>('POST', '/v1/roles', body), 'Role created.')) as Role | undefined;
      if (created) {
        setSelected(created.id);
        setDraft(draftOf(created));
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
      ?? { object_type_id: objectTypeId, ...NO_ACCESS };

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
  const accessLabel = (r: Role) => (r.is_admin ? 'Super Admin' : r.description || `${r.object_permissions.filter((x) => x.can_read).length} objects`);
  // a column's header switch: turns the column on or off for every object
  function columnHead(column: { key: PermissionKey; label: string; group: string }, rowSpan?: number) {
    const ticked = objects.filter((o) => permissionOf(o.object_type_id)[column.key]).length;
    return (
      <th key={column.key} className="cell-check" rowSpan={rowSpan}>
        <ColumnCheck
          label={column.label || column.group}
          name={columnName(column)}
          checked={objects.length > 0 && ticked === objects.length}
          partial={ticked > 0 && ticked < objects.length}
          onChange={(v) => setColumn(column.key, v)}
        />
      </th>
    );
  }
  const togglePermission = (key: RolePermission, on: boolean) =>
    setDraft({ ...draft, permissions: on ? [...draft.permissions.filter((x) => x !== key), key] : draft.permissions.filter((x) => x !== key) });

  return (
    <SettingsPage
      className="wide"
      title="Roles"
      description={<>
        A role decides which objects its users can read, create, edit and delete (on the records they own, or on all records), and
        which settings they can manage. Someone with several roles gets the most permissive combination. Assign roles on
        the <Link to="/settings/users">Users</Link> page.
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
                {locked && <div className="callout">Only Super Admins can change Super Admin roles.</div>}
                <form className="role-form" onSubmit={save}>
                  <fieldset disabled={locked} className="plain-fieldset">
                    <label className="field">
                      <span>Name</span>
                      <input value={draft.name} maxLength={63} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Description</span>
                      <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                    </label>
                    {me.is_admin && (
                      <label className="check">
                        <input type="checkbox" checked={draft.is_admin} onChange={(e) => setDraft({ ...draft, is_admin: e.target.checked })} />
                        Super Admin: full access to every object, record and setting
                      </label>
                    )}
                    {!draft.is_admin && (
                      <label className="field">
                        <span>Records they own means</span>
                        <Select value={draft.record_access} onChange={(v) => setDraft({ ...draft, record_access: v as Role['record_access'] })}>
                          {RECORD_ACCESS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </Select>
                        <span className="muted small">
                          Used by the Own columns under Object access (owner, or creator when an object has no owner), plus anything a sharing rule below opens up.
                        </span>
                      </label>
                    )}
                    {!draft.is_admin && (
                      <label className="field">
                        <span>Knowledge base</span>
                        <Select value={draft.knowledge_access} onChange={(v) => setDraft({ ...draft, knowledge_access: v as Role['knowledge_access'] })}>
                          {KNOWLEDGE_ACCESS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </Select>
                        <span className="muted small">
                          Also what their AI agents can do with it over MCP. Articles marked admins only stay with Super Admins.
                        </span>
                      </label>
                    )}
                  </fieldset>
                  {role && !locked && (
                    <div className="actions">
                      <button type="button" className="btn ghost danger-text" onClick={remove}><Trash2 size={14} /> Delete role</button>
                    </div>
                  )}
                </form>
              </SettingsSection>
            )}

            {(role || selected === 'new') && !draft.is_admin && (
              <SettingsSection title="Permissions" description="Settings and tools besides objects. Saved with the role's details.">
                <div className="permission-list">
                  {ROLE_PERMISSIONS.map((x) => (
                    <label key={x.key} className="check permission-row">
                      <input type="checkbox" checked={draft.permissions.includes(x.key)} disabled={locked} onChange={(e) => togglePermission(x.key, e.target.checked)} />
                      <span>
                        {x.label}
                        <span className="muted small">{x.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </SettingsSection>
            )}

            {role && (
              <>
                <SettingsSection title="Members" description={members.length ? undefined : 'Nobody has this role yet. Assign it on the Users page.'}>
                  {members.length > 0 && (
                    <div className="member-list">
                      {members.map((m) => (
                        <span key={m.id} className="person"><UserAvatar userId={m.id} name={m.name} className="person-avatar" />{m.name}</span>
                      ))}
                    </div>
                  )}
                </SettingsSection>

                <SettingsSection
                  title="Object access"
                  description={role.is_admin
                    ? 'Super Admin roles can use every object.'
                    : 'Own reaches the records they own (see Details); All reaches every record and includes Own. Create, edit and delete each include read.'}
                >
                  {!role.is_admin && !role.object_permissions.some((p) => p.can_read) && (
                    <div className="callout warn">This role cannot read any object yet, so its users see nothing. Turn on Read for the objects they should use.</div>
                  )}
                  {!role.is_admin && (
                    <div className="access-table">
                      <table className="grid object-access">
                        <thead>
                          <tr>
                            <th rowSpan={2}>Object</th>
                            {PERMISSION_GROUPS.map((g) => (g.columns.length > 1
                              ? <th key={g.label} colSpan={g.columns.length} className="cell-group">{g.label}</th>
                              : columnHead({ ...g.columns[0], group: g.label }, 2)))}
                          </tr>
                          <tr>
                            {PERMISSION_COLUMNS.filter((c) => c.label).map((c) => columnHead(c))}
                          </tr>
                        </thead>
                        <tbody>
                          {objects.map((o) => {
                            const p = permissionOf(o.object_type_id);
                            return (
                              <tr key={o.object_type_id}>
                                <td>{o.label_plural}</td>
                                {PERMISSION_COLUMNS.map((c) => (
                                  <td key={c.key} className="cell-check">
                                    <input
                                      type="checkbox"
                                      aria-label={`${o.label_plural}: ${columnName(c)}`}
                                      checked={p[c.key]}
                                      onChange={(e) => setPermission(o.object_type_id, o.api_name, c.key, e.target.checked)}
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

                {!role.is_admin && <SharingRules roleId={role.id} />}
              </>
            )}
          </div>
        </div>
      )}
      {loaded && (role || selected === 'new') && !locked && (
        <SaveBar dirty={dirty} message={message}>
          <button className="btn" disabled={!dirty} onClick={() => {
            if (selected === 'new') { setSelected(null); if (roles.length) load(roles[0].id); return; }
            if (role) setDraft(draftOf(role));
          }}>{selected === 'new' ? 'Cancel' : 'Discard'}</button>
          {selected === 'new' && dirty && <SaveHint missing={[!draft.name.trim() && 'a name']} />}
          <button className="btn primary" disabled={!dirty || (selected === 'new' && !draft.name.trim())} onClick={() => void save()}>{selected === 'new' ? 'Create role' : 'Save role'}</button>
        </SaveBar>
      )}
    </SettingsPage>
  );
}
