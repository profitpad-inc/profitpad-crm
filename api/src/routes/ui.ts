import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { requireScope, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { approveFields, approveUrl, canApprove, requestFields } from '../approval.js';
import { getObject, getProperty, getRegistry, type ObjectDef } from '../registry.js';
import { clearAllowedOriginsCache, normalizeOrigin } from './public.js';

// Admins: keys with the admin scope, or user keys whose roles include an admin role.
export function isAdmin(p: Principal): boolean {
  return p.scopes.has('admin') || (p.userId !== null && p.permissions === null);
}

function requireAdmin(p: Principal): void {
  if (!isAdmin(p)) throw forbidden('only admins can change this');
}

function canRead(p: Principal, obj: ObjectDef): boolean {
  return !p.permissions || p.permissions.objects.get(obj.object_type_id)?.read === true;
}

// ---- theme -----------------------------------------------------------------

export const THEME_KEYS = [
  'primary', 'sidebar_background', 'sidebar_text', 'sidebar_active', 'page_background', 'surface', 'text', 'muted_text', 'border'
] as const;

function validateTheme(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('theme must be an object of colors');
  for (const [k, v] of Object.entries(value)) {
    if (!(THEME_KEYS as readonly string[]).includes(k)) throw badRequest(`unknown theme color "${k}" (allowed: ${THEME_KEYS.join(', ')})`);
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw badRequest(`theme color "${k}" must look like #1a2b3c`);
  }
  return value as Record<string, string>;
}

// ---- dropdown colours --------------------------------------------------------

// The 16 colours offered when picking a dropdown choice's colour, in order.
function validateDropdownColors(value: unknown): { colors: string[] } {
  const raw = (value as { colors?: unknown } | null)?.colors;
  if (!Array.isArray(raw) || raw.length !== 16) throw badRequest('colors must be a list of exactly 16 colors');
  for (const c of raw) if (typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c)) throw badRequest(`dropdown color "${String(c)}" must look like #1a2b3c`);
  return { colors: raw.map((c: string) => c.toLowerCase()) };
}

// ---- logo --------------------------------------------------------------------

// The portal's logo (Settings, Theme), shown in the sidebar, the phone header
// and the login page. Stored inline as a data URL: the page shrinks raster
// images to 256px before sending, so they stay small. image null = the CRM mark.
const LOGO_MAX = 300 * 1024;

function validateLogo(value: unknown): { image: string | null } {
  const raw = (value as { image?: unknown } | null)?.image;
  if (raw === null || raw === undefined || raw === '') return { image: null };
  if (typeof raw !== 'string' || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(raw)) {
    throw badRequest('image must be a base64 data URL of a PNG, JPEG, WebP, GIF or SVG image');
  }
  if (raw.length > LOGO_MAX) throw badRequest('the logo is too large (300 KB at most)');
  return { image: raw };
}

// ---- forms -------------------------------------------------------------------

// Websites allowed to embed forms and booking pages (Settings, Embed
// domains). Stored as origins; full URLs are cut down to scheme://host[:port].
// Websites added from outside the CRM (an AI over MCP, an API key) wait in
// pending_origins until an admin signed in to the CRM allows them (approval.ts).
interface PendingOrigin {
  origin: string;
  requested_by: string;
  requested_via: string | null;
  requested_at: string;
}

export interface FormsSettings {
  allowed_origins: string[];
  pending_origins: PendingOrigin[];
}

export const EMBED_DOMAINS_URL = approveUrl('embed-domains', 'pending');

function readOrigins(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length > 100) throw badRequest(`${field} must be a list of at most 100 websites`);
  const origins = new Set<string>();
  for (const r of raw) {
    const o = typeof r === 'string' ? normalizeOrigin(r) : null;
    if (!o) throw badRequest(`"${String(r)}" is not a website address like https://www.example.com`);
    origins.add(o);
  }
  return [...origins];
}

export async function loadFormsSettings(): Promise<FormsSettings> {
  const { rows } = await pool.query("select value from ui.settings where key = 'forms'");
  const v = rows[0]?.value ?? {};
  return { allowed_origins: v.allowed_origins ?? [], pending_origins: v.pending_origins ?? [] };
}

// Saves the embed domains: allowed_origins is the whole list wanted, and
// pending_origins (optional) the waiting websites to keep. From an admin
// signed in to the CRM the list is saved as given; from anywhere else
// removals apply and new websites are added to pending_origins instead.
export async function saveEmbedDomains(p: Principal, body: unknown, req?: FastifyRequest): Promise<FormsSettings & { requested: string[]; approve_url?: string }> {
  requireAdmin(p);
  const b = (body ?? {}) as { allowed_origins?: unknown; pending_origins?: unknown };
  const wanted = readOrigins(b.allowed_origins, 'allowed_origins');
  const keep = b.pending_origins === undefined ? null : new Set(readOrigins(b.pending_origins, 'pending_origins'));
  const current = await loadFormsSettings();
  const approver = canApprove(p);
  const allowed = approver ? wanted : current.allowed_origins.filter((o) => wanted.includes(o));
  const added = wanted.filter((o) => !current.allowed_origins.includes(o));
  if (approver && added.length) approveFields(p);
  const requested = approver ? [] : added.filter((o) => !current.pending_origins.some((x) => x.origin === o));
  const ask = requestFields(p);
  const pending = [
    ...current.pending_origins.filter((x) => !allowed.includes(x.origin) && (!keep || keep.has(x.origin))),
    ...requested.map((origin) => ({ origin, requested_by: ask.requested_by, requested_via: ask.requested_via, requested_at: ask.requested_at.toISOString() }))
  ];
  if (pending.length > 100) throw badRequest('at most 100 websites can wait for approval');
  const value: FormsSettings = { allowed_origins: allowed, pending_origins: pending };
  await pool.query(
    `insert into ui.settings (key, value, updated_by) values ('forms', $1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [JSON.stringify(value), p.actor]
  );
  clearAllowedOriginsCache();
  const log = (event: 'settings.updated' | 'embed_domain.requested' | 'embed_domain.approved', details: Record<string, unknown>) => req
    ? logEvent(req, event, { target: { type: 'setting', id: 'forms' }, details })
    : pool.query(
      `insert into auth.security_events (event, actor, user_agent, target_type, target_id, details) values ($1, $2, $3, 'setting', 'forms', $4)`,
      [event, p.actor, p.oauth?.clientName ?? null, JSON.stringify({ ...details, ...(p.oauth ? { via: p.oauth.clientName } : {}) })]
    );
  await log('settings.updated', { value });
  if (requested.length) await log('embed_domain.requested', { origins: requested });
  if (approver && added.length) await log('embed_domain.approved', { origins: added });
  return { ...value, requested, ...(pending.length ? { approve_url: EMBED_DOMAINS_URL } : {}) };
}

// ---- sidebar menus -----------------------------------------------------------

type NavItem =
  | { type: 'home' | 'divider' }
  | { type: 'object'; object: string; label?: string }
  | { type: 'view'; object: string; view_id: number; label?: string }
  | { type: 'custom_view'; slug: string; label?: string }
  // the business card scanner page (/scan)
  | { type: 'card_scanner'; label?: string }
  | { type: 'section'; label: string; items: NavItem[] };

async function validateNav(items: unknown, depth = 0): Promise<NavItem[]> {
  if (!Array.isArray(items) || items.length > 100) throw badRequest('items must be an array of at most 100 menu items');
  const out: NavItem[] = [];
  for (const raw of items) {
    const it = raw as Record<string, unknown>;
    const label = it.label === undefined ? undefined : String(it.label);
    if (label !== undefined && (label.length < 1 || label.length > 63)) throw badRequest('menu labels must be 1 to 63 characters');
    switch (it.type) {
      case 'home':
      case 'divider':
        out.push({ type: it.type });
        break;
      case 'object': {
        const obj = await getObject(String(it.object));
        out.push({ type: 'object', object: obj.api_name, ...(label ? { label } : {}) });
        break;
      }
      case 'view': {
        const obj = await getObject(String(it.object));
        const { rows } = await pool.query('select 1 from ui.views where id = $1 and object_type_id = $2', [it.view_id, obj.object_type_id]);
        if (rows.length === 0) throw badRequest(`view ${it.view_id} does not exist on ${obj.api_name}`);
        out.push({ type: 'view', object: obj.api_name, view_id: Number(it.view_id), ...(label ? { label } : {}) });
        break;
      }
      // a custom view (crm.pc_0055, /view/#slug); hidden for users who cannot open it
      case 'custom_view': {
        const { rows } = await pool.query("select slug from crm.pc_0055 where lower(slug) = lower($1) and record_status = 'active'", [String(it.slug ?? '')]);
        if (rows.length === 0) throw badRequest(`custom view "${String(it.slug)}" does not exist`);
        out.push({ type: 'custom_view', slug: rows[0].slug, ...(label ? { label } : {}) });
        break;
      }
      case 'card_scanner':
        out.push({ type: 'card_scanner', ...(label ? { label } : {}) });
        break;
      case 'section':
        if (depth > 0) throw badRequest('sections cannot be nested');
        if (!label) throw badRequest('sections need a label');
        out.push({ type: 'section', label, items: await validateNav(it.items ?? [], depth + 1) });
        break;
      default:
        throw badRequest(`unknown menu item type "${String(it.type)}"`);
    }
  }
  return out;
}

// the mobile bottom bar: the left button, then up to 3 links (Search is always added after them)
function validateBottomLeft(left: unknown): 'menu' | 'home' {
  if (left !== 'menu' && left !== 'home') throw badRequest('bottom_left must be "menu" or "home"');
  return left;
}

async function validateBottom(items: unknown): Promise<NavItem[]> {
  if (!Array.isArray(items) || items.length > 3) throw badRequest('bottom must be an array of at most 3 items');
  const out = await validateNav(items);
  if (out.some((it) => it.type === 'divider' || it.type === 'section')) throw badRequest('the bottom bar takes object, view, custom_view and card_scanner items only');
  // Home belongs on the left button (bottom_left: "home"), not among the links
  if (out.some((it) => it.type === 'home')) throw badRequest('the bottom bar takes object, view and custom_view items only; for Home set bottom_left to "home"');
  return out;
}

// ---- views -------------------------------------------------------------------

// width: optional column width in pixels, set by resizing the column in the UI
type Column = ({ type: 'property'; property: string } | { type: 'association'; object: string; label_id: string | null }) & { width?: number };

async function validateColumns(obj: ObjectDef, columns: unknown): Promise<Column[]> {
  if (!Array.isArray(columns) || columns.length > 50) throw badRequest('columns must be an array of at most 50 columns');
  const out: Column[] = [];
  for (const raw of columns) {
    const c = raw as Record<string, unknown>;
    if (c.width !== undefined && c.width !== null && !(Number.isInteger(c.width) && (c.width as number) >= 40 && (c.width as number) <= 1000)) {
      throw badRequest('column width must be a whole number of pixels between 40 and 1000');
    }
    const width = typeof c.width === 'number' ? { width: c.width } : {};
    if (c.type === 'property') {
      const prop = getProperty(obj, String(c.property));
      if (!prop) throw badRequest(`unknown property "${String(c.property)}" on ${obj.api_name}`);
      out.push({ type: 'property', property: prop.api_name, ...width });
    } else if (c.type === 'association') {
      const other = await getObject(String(c.object));
      const labelId = c.label_id === undefined || c.label_id === null ? null : String(c.label_id);
      if (labelId) {
        const { rows } = await pool.query(
          `select 1 from meta.pc_0004 where pc_0004_id = $1
           and ((from_object_type = $2 and to_object_type = $3) or (from_object_type = $3 and to_object_type = $2))`,
          [labelId, obj.object_type_id, other.object_type_id]
        );
        if (rows.length === 0) throw badRequest(`label ${labelId} does not connect ${obj.api_name} and ${other.api_name}`);
      }
      out.push({ type: 'association', object: other.api_name, label_id: labelId, ...width });
    } else {
      throw badRequest('column type must be property or association');
    }
  }
  return out;
}

function validateSorts(obj: ObjectDef, sorts: unknown): { property: string; direction: 'asc' | 'desc' }[] {
  if (!Array.isArray(sorts) || sorts.length > 3) throw badRequest('sorts must be an array of at most 3');
  return sorts.map((s) => {
    const prop = getProperty(obj, String(s?.property));
    if (!prop) throw badRequest(`unknown sort property "${String(s?.property)}"`);
    return { property: prop.api_name, direction: s.direction === 'asc' ? 'asc' : 'desc' };
  });
}

// Long values that make poor table columns: a custom view's code and queries
// (its record page shows them in the Code card).
const NOT_DEFAULT_COLUMNS: Record<string, string[]> = { pc_0055: ['draft_source', 'draft_queries', 'source', 'queries'] };

// Default view: name plus the first few native properties, newest first.
function defaultColumns(obj: ObjectDef): Column[] {
  const skip = NOT_DEFAULT_COLUMNS[obj.object_type_id] ?? [];
  const native = obj.properties
    .filter((p) => !p.is_base && p.record_status === 'active' && p.type !== 'file' && !/body|description|definition|values/.test(p.api_name) && !skip.includes(p.api_name))
    .slice(0, 5);
  return [
    { type: 'property', property: 'name' },
    ...native.map((p) => ({ type: 'property' as const, property: p.api_name })),
    { type: 'property', property: 'created_at' }
  ];
}

async function loadView(id: string) {
  const { rows } = await pool.query('select * from ui.views where id = $1', [id]);
  if (rows.length === 0) throw notFound('view not found');
  return rows[0];
}

function canEditView(p: Principal, view: { owner: string | null }): boolean {
  return view.owner === null ? isAdmin(p) : view.owner === p.actor || isAdmin(p);
}

const viewOut = (v: Record<string, unknown>, p: Principal) => ({ ...v, shared: v.owner === null, editable: canEditView(p, v as { owner: string | null }) });

// An object's table views: shared ones plus the caller's own, in tab order (the
// first is the one the table opens on). A default shared view is created on
// first use. Also read by the MCP's get_object_list_config.
export async function tableViews(p: Principal, obj: ObjectDef) {
  const list = () =>
    pool.query('select * from ui.views where object_type_id = $1 and (owner is null or owner = $2) order by position, id', [obj.object_type_id, p.actor]);
  let { rows } = await list();
  if (!rows.some((v) => v.owner === null)) {
    await pool.query(
      `insert into ui.views (object_type_id, name, owner, columns, sorts, created_by)
       select $1, $2, null, $3, $4, 'system' where not exists (select 1 from ui.views where object_type_id = $1 and owner is null)`,
      [obj.object_type_id, `All ${obj.label_plural.toLowerCase()}`, JSON.stringify(defaultColumns(obj)), JSON.stringify([{ property: 'created_at', direction: 'desc' }])]
    );
    ({ rows } = await list());
  }
  return rows.map((v) => viewOut(v, p));
}

export async function uiRoutes(app: FastifyInstance) {
  app.get('/v1/me', async (req) => {
    const p = req.principal!;
    const reg = await getRegistry();
    let user = null;
    if (p.userId) {
      const { rows } = await pool.query(
        'select pc_0000_id as id, name, first_name, last_name, email from crm.pc_0000 where pc_0000_id = $1',
        [p.userId]
      );
      user = rows[0] ?? null;
    }
    return {
      actor: p.actor,
      key_name: p.name,
      scopes: [...p.scopes],
      is_admin: isAdmin(p),
      user,
      readable_objects: reg.objects.filter((o) => o.record_status === 'active' && canRead(p, o)).map((o) => o.api_name)
    };
  });

  // theme and other portal settings
  app.get('/v1/ui/settings', async (req) => {
    requireScope(req.principal!, 'read');
    const { rows } = await pool.query('select key, value from ui.settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.put<{ Params: { key: string }; Body: unknown }>('/v1/ui/settings/:key', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    if (req.params.key === 'forms') return saveEmbedDomains(p, req.body, req);
    const validators: Record<string, (v: unknown) => unknown> = { theme: validateTheme, dropdown_colors: validateDropdownColors, logo: validateLogo };
    const validate = validators[req.params.key];
    if (!validate) throw badRequest('unknown setting (supported: theme, dropdown_colors, logo, forms)');
    const value = validate(req.body);
    await pool.query(
      `insert into ui.settings (key, value, updated_by) values ($1, $2, $3)
       on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
      [req.params.key, JSON.stringify(value), p.actor]
    );
    await logEvent(req, 'settings.updated', { target: { type: 'setting', id: req.params.key } });
    return value;
  });

  // the caller's sidebar: their own menu if an admin set one, else the default
  app.get('/v1/ui/nav', async (req) => {
    const p = req.principal!;
    const { rows } = await pool.query(
      `select scope, items, bottom_left, bottom_items from ui.nav_menus where (scope = 'user' and user_id = $1) or scope = 'default'
       order by (scope = 'user') desc limit 1`,
      [p.userId]
    );
    return { source: rows[0]?.scope ?? 'default', items: rows[0]?.items ?? [], bottom_left: rows[0]?.bottom_left ?? 'menu', bottom: rows[0]?.bottom_items ?? [] };
  });

  app.get('/v1/ui/nav/menus', async (req) => {
    requireAdmin(req.principal!);
    const { rows } = await pool.query(
      `select m.scope, m.user_id, u.name as user_name, m.items, m.bottom_left, m.bottom_items as bottom, m.updated_at, m.updated_by
       from ui.nav_menus m left join crm.pc_0000 u on u.pc_0000_id = m.user_id order by m.scope, u.name`
    );
    return { results: rows };
  });

  // bottom_left and bottom are optional; left out, the bottom bar stays as it is
  app.put<{ Body: { items: unknown; bottom_left?: unknown; bottom?: unknown } }>('/v1/ui/nav/default', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    const items = await validateNav(req.body?.items);
    const left = req.body?.bottom_left === undefined ? null : validateBottomLeft(req.body.bottom_left);
    const bottom = req.body?.bottom === undefined ? null : await validateBottom(req.body.bottom);
    const { rows } = await pool.query(
      `update ui.nav_menus set items = $1, bottom_left = coalesce($2, bottom_left), bottom_items = coalesce($3, bottom_items),
         updated_at = now(), updated_by = $4
       where scope = 'default' returning bottom_left, bottom_items`,
      [JSON.stringify(items), left, bottom && JSON.stringify(bottom), p.actor]
    );
    return { source: 'default', items, bottom_left: rows[0]?.bottom_left ?? 'menu', bottom: rows[0]?.bottom_items ?? [] };
  });

  // bottom_left and bottom are optional; left out, a new menu copies the default's bottom bar and an existing one keeps its own
  app.put<{ Params: { userId: string }; Body: { items: unknown; bottom_left?: unknown; bottom?: unknown } }>('/v1/ui/nav/users/:userId', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    const { rows: users } = await pool.query("select 1 from crm.pc_0000 where pc_0000_id = $1 and record_status = 'active'", [req.params.userId]);
    if (users.length === 0) throw notFound('user not found');
    const items = await validateNav(req.body?.items);
    const left = req.body?.bottom_left === undefined ? null : validateBottomLeft(req.body.bottom_left);
    const bottom = req.body?.bottom === undefined ? null : await validateBottom(req.body.bottom);
    const { rows } = await pool.query(
      `insert into ui.nav_menus (scope, user_id, items, bottom_left, bottom_items, updated_by)
       values ('user', $1, $2,
         coalesce($3, (select bottom_left from ui.nav_menus where scope = 'default'), 'menu'),
         coalesce($4, (select bottom_items from ui.nav_menus where scope = 'default'), '[]'), $5)
       on conflict (user_id) where scope = 'user' do update
         set items = excluded.items, bottom_left = coalesce($3, ui.nav_menus.bottom_left), bottom_items = coalesce($4, ui.nav_menus.bottom_items),
           updated_at = now(), updated_by = excluded.updated_by
       returning bottom_left, bottom_items`,
      [req.params.userId, JSON.stringify(items), left, bottom && JSON.stringify(bottom), p.actor]
    );
    return { source: 'user', items, bottom_left: rows[0].bottom_left, bottom: rows[0].bottom_items };
  });

  // back to the default menu
  app.delete<{ Params: { userId: string } }>('/v1/ui/nav/users/:userId', async (req, reply) => {
    requireAdmin(req.principal!);
    await pool.query("delete from ui.nav_menus where scope = 'user' and user_id = $1", [req.params.userId]);
    reply.code(204);
  });

  // views: shared ones plus the caller's own; a default shared view is created on first use
  app.get<{ Querystring: { object?: string } }>('/v1/ui/views', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    if (!req.query.object) throw badRequest('object is required');
    return { results: await tableViews(p, await getObject(req.query.object)) };
  });

  app.post<{ Body: { object: string; name: string; columns?: unknown; sorts?: unknown; shared?: boolean } }>('/v1/ui/views', async (req, reply) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const b = req.body ?? ({} as never);
    const obj = await getObject(b.object);
    if (b.shared) requireAdmin(p);
    if (!b.name || b.name.length > 63) throw badRequest('name must be 1 to 63 characters');
    const columns = b.columns === undefined ? defaultColumns(obj) : await validateColumns(obj, b.columns);
    const sorts = b.sorts === undefined ? [{ property: 'created_at', direction: 'desc' }] : validateSorts(obj, b.sorts);
    const { rows } = await pool.query(
      `insert into ui.views (object_type_id, name, owner, columns, sorts, position, created_by)
       values ($1, $2, $3, $4, $5, (select coalesce(max(position), 0) + 1 from ui.views where object_type_id = $1), $6) returning *`,
      [obj.object_type_id, b.name, b.shared ? null : p.actor, JSON.stringify(columns), JSON.stringify(sorts), p.actor]
    );
    reply.code(201);
    return viewOut(rows[0], p);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; columns?: unknown; sorts?: unknown; position?: number } }>('/v1/ui/views/:id', async (req) => {
    const p = req.principal!;
    const view = await loadView(req.params.id);
    if (!canEditView(p, view)) throw forbidden('you cannot change this view');
    const obj = await getObject(view.object_type_id);
    const b = req.body ?? {};
    if (b.name !== undefined && (!b.name || b.name.length > 63)) throw badRequest('name must be 1 to 63 characters');
    const columns = b.columns === undefined ? null : JSON.stringify(await validateColumns(obj, b.columns));
    const sorts = b.sorts === undefined ? null : JSON.stringify(validateSorts(obj, b.sorts));
    const { rows } = await pool.query(
      `update ui.views set name = coalesce($2, name), columns = coalesce($3, columns), sorts = coalesce($4, sorts),
         position = coalesce($5, position), updated_at = now() where id = $1 returning *`,
      [req.params.id, b.name ?? null, columns, sorts, b.position ?? null]
    );
    return viewOut(rows[0], p);
  });

  app.delete<{ Params: { id: string } }>('/v1/ui/views/:id', async (req, reply) => {
    const p = req.principal!;
    const view = await loadView(req.params.id);
    if (!canEditView(p, view)) throw forbidden('you cannot delete this view');
    await pool.query('delete from ui.views where id = $1', [req.params.id]);
    reply.code(204);
  });
}
