import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinePropertyAccess, hasPermission, optionChangeByEditor, recordFilter, type ObjectPermission, type Permissions, type Principal, type PropertyAccessLevel } from './auth.js';
import { normalizeObjectSwitches } from './routes/admin.js';
import type { ObjectDef } from './registry.js';

const NONE: ObjectPermission = { read: false, create: false, edit: false, delete: false, readAll: false, editAll: false, deleteAll: false };

const perms = (over: Partial<Permissions> = {}): Permissions => ({
  objects: new Map(), propertyAccess: new Map(), ownScope: 'own', teamUserIds: ['u1', 'u2'], granted: new Set(),
  sharingRules: [], knowledgeAccess: 'read', ...over
});

const user = (p: Permissions, extra: Partial<Principal> = {}): Principal => ({
  keyId: null, name: 'session', scopes: new Set(['read', 'write']), userId: 'u1', actor: 'user:u1', permissions: p,
  session: { id: '1', signedInAt: new Date() }, ...extra
});

const superAdmin: Principal = { keyId: null, name: 'session', scopes: new Set(['admin']), userId: 'a1', actor: 'user:a1', permissions: null };
const app = (p: Permissions | null): Principal => ({
  keyId: null, name: 'oauth:x', scopes: new Set(['read', 'write', 'schema']), userId: 'u1', actor: 'user:u1', permissions: p,
  oauth: { clientId: 'c', clientName: 'Claude', grantId: 1, expiresAt: new Date(Date.now() + 3600_000) }
});

// an object with an owner dropdown
const contacts = {
  object_type_id: 'pc_0010', id_column: 'pc_0010_id', api_name: 'contacts',
  byName: new Map([['owner', { type: 'dropdown' }]])
} as unknown as ObjectDef;

test('Super Admins have every permission; others only what a role gives', () => {
  assert.equal(hasPermission(superAdmin, 'roles'), true);
  assert.equal(hasPermission(superAdmin, 'security_log', { write: false }), true);
  const p = user(perms({ granted: new Set(['import', 'integrations']) }));
  assert.equal(hasPermission(p, 'import'), true);
  assert.equal(hasPermission(p, 'integrations'), true);
  assert.equal(hasPermission(p, 'export'), false);
  assert.equal(hasPermission(p, 'roles'), false);
});

test('changes need the write scope; looking needs read', () => {
  const readOnlyKey = user(perms({ granted: new Set(['api_keys']) }), { keyId: 3, session: undefined, scopes: new Set(['read']) });
  assert.equal(hasPermission(readOnlyKey, 'api_keys', { write: false }), true);
  assert.equal(hasPermission(readOnlyKey, 'api_keys'), false);
});

test('connected apps never get access-handing permissions, and only admins\' apps get integrations', () => {
  assert.equal(hasPermission(app(null), 'roles'), false);
  assert.equal(hasPermission(app(null), 'api_keys'), false);
  assert.equal(hasPermission(app(null), 'integrations'), true);
  const granted = perms({ granted: new Set(['integrations', 'properties', 'roles', 'import']) });
  assert.equal(hasPermission(app(granted), 'integrations'), false);
  assert.equal(hasPermission(app(granted), 'properties'), false);
  assert.equal(hasPermission(app(granted), 'roles'), false);
  assert.equal(hasPermission(app(granted), 'import'), true);
});

test('record filter: "all records" per mode, otherwise own records', () => {
  const p = user(perms({ objects: new Map([['pc_0010', { ...NONE, read: true, edit: true, delete: true, readAll: true }]]) }));
  assert.equal(recordFilter(p, contacts, [], 't', 'read'), 'true');
  const params: unknown[] = [];
  assert.equal(recordFilter(p, contacts, params, 't', 'edit'), 't."owner" && $1::text[]');
  assert.deepEqual(params, [['u1']]);
  assert.notEqual(recordFilter(p, contacts, [], 't', 'delete'), 'true');

  const all = user(perms({ objects: new Map([['pc_0010', { ...NONE, read: true, edit: true, delete: true, readAll: true, editAll: true, deleteAll: true }]]) }));
  for (const mode of ['read', 'edit', 'delete'] as const) assert.equal(recordFilter(all, contacts, [], 't', mode), 'true');
});

test('record filter: team scope uses teammates', () => {
  const p = user(perms({ ownScope: 'team', objects: new Map([['pc_0010', { ...NONE, read: true }]]) }));
  const params: unknown[] = [];
  recordFilter(p, contacts, params, 't', 'read');
  assert.deepEqual(params, [['u1', 'u2']]);
});

test('object switches: all includes own, changes include read', () => {
  const off = { can_read: false, can_create: false, can_edit: false, can_delete: false, can_read_all: false, can_edit_all: false, can_delete_all: false };
  assert.deepEqual(normalizeObjectSwitches({ ...off, can_edit_all: true }), { ...off, can_read: true, can_edit: true, can_read_all: true, can_edit_all: true });
  assert.deepEqual(normalizeObjectSwitches({ ...off, can_delete_all: true }), { ...off, can_read: true, can_delete: true, can_read_all: true, can_delete_all: true });
  assert.deepEqual(normalizeObjectSwitches({ ...off, can_create: true }), { ...off, can_read: true, can_create: true });
  assert.deepEqual(normalizeObjectSwitches({ ...off, can_read_all: true }), { ...off, can_read: true, can_read_all: true });
});

test('optionChangeByEditor: editors manage choices only on user-add dropdowns, label and archiving only', () => {
  const folder = { type: 'dropdown', options: { single_value: true, allow_user_add: true }, option_list: null } as const;
  assert.equal(optionChangeByEditor(folder, ['api_value', 'label']), null);
  assert.equal(optionChangeByEditor(folder, ['label']), null);
  assert.equal(optionChangeByEditor(folder, ['record_status']), null);
  assert.match(optionChangeByEditor(folder, ['label', 'color'])!, /not color/);
  assert.match(optionChangeByEditor(folder, ['display_order'])!, /not display_order/);
  assert.match(optionChangeByEditor({ ...folder, options: { single_value: true } }, ['label'])!, /may not add/);
  assert.match(optionChangeByEditor({ ...folder, options: { allow_user_add: true, auto_append_users: true } }, ['label'])!, /lists users/);
  assert.match(optionChangeByEditor({ ...folder, option_list: { id: '1', api_name: 'x', label: 'X' } }, ['label'])!, /option list/);
  assert.match(optionChangeByEditor({ ...folder, type: 'text' }, ['label'])!, /not a dropdown/);
});

test('owner rotations: a permission apps can be given, unlike Users', () => {
  const app = { keyId: null, name: 'Claude', scopes: new Set(['read', 'write']), userId: '0000000001', actor: 'user:0000000001',
    oauth: { clientId: 'c', clientName: 'Claude', grantId: 1, expiresAt: new Date() },
    permissions: { objects: new Map(), propertyAccess: new Map(), ownScope: 'own', granted: new Set(['owner_rotations', 'users']), teamUserIds: [], sharingRules: [], knowledgeAccess: 'none' }
  } as unknown as Principal;
  assert.equal(hasPermission(app, 'owner_rotations'), true);
  assert.equal(hasPermission(app, 'users'), false);
});

test('property access: role rows win over the default, most permissive role wins', () => {
  const defaults = new Map<string, PropertyAccessLevel>([['p_hidden', 'hidden'], ['p_view', 'read_only']]);
  const overrides = new Map<string, Map<string, PropertyAccessLevel>>([
    ['p_hidden', new Map([['r1', 'full']])],
    ['p_role_only', new Map([['r1', 'hidden']])]
  ]);
  // r1 is given p_hidden; p_view stays view-only; p_role_only is hidden for r1 alone
  assert.deepEqual([...combinePropertyAccess(['r1'], defaults, overrides)].sort(), [['p_role_only', 'hidden'], ['p_view', 'read_only']]);
  // r2 has no rows: the defaults
  assert.deepEqual([...combinePropertyAccess(['r2'], defaults, overrides)].sort(), [['p_hidden', 'hidden'], ['p_view', 'read_only']]);
  // both roles: the most permissive of each (a role without a row on p_role_only gets full)
  assert.deepEqual([...combinePropertyAccess(['r1', 'r2'], defaults, overrides)].sort(), [['p_view', 'read_only']]);
  // no roles: the defaults
  assert.deepEqual([...combinePropertyAccess([], defaults, overrides)].sort(), [['p_hidden', 'hidden'], ['p_view', 'read_only']]);
});
