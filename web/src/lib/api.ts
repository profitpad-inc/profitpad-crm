import { requestReauth } from './reauth';

// Thin client for the CRM API. The UI authenticates via the HttpOnly session
// cookie set after Google sign-in (sent with credentials: 'include').

export class ApiError extends Error {
  // details.property: the property a write failed on (shown under that field)
  constructor(public status: number, message: string, public code?: string, public details?: { property?: string; field?: string } & Record<string, unknown>) {
    super(message);
  }
}

// Where the API lives. Empty in dev (Vite proxies /v1); in production the
// static site (GitHub Pages) is built with VITE_API_URL=https://<api host>.
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export async function api<T = unknown>(method: string, path: string, body?: unknown, _unused?: unknown): Promise<T> {
  return send<T>(method, path, body, false);
}

async function send<T>(method: string, path: string, body: unknown, retried: boolean): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!res.ok) {
    // admin changes need a recent sign-in: the app asks for one over the page
    // (the check runs before anything is written), then sends this again
    if (data?.error === 'reauth_required' && !retried && (await requestReauth())) return send<T>(method, path, body, true);
    throw new ApiError(res.status, data?.message ?? res.statusText, data?.error, data?.details);
  }
  return data as T;
}

// ---- types ----------------------------------------------------------------

export interface Me {
  actor: string;
  key_name: string;
  scopes: string[];
  is_admin: boolean;
  user: { id: string; name: string | null; first_name: string | null; last_name: string | null; email: string | null } | null;
  readable_objects: string[];
}

export interface ObjectSummary {
  object_type_id: string;
  api_name: string;
  label_singular: string;
  label_plural: string;
  kind: 'system' | 'native' | 'custom';
  description: string | null;
  search_properties: string[];
  id_property: string;
  // objects this one may be linked to; system_links are linked only by the system
  links_to: string[];
  system_links: string[];
}

export interface DropdownOption {
  api_value: string;
  label: string;
  display_order: number;
  record_status: string;
  // stage details (migration 0035)
  parent_values?: string[];
  is_closed?: boolean;
  is_won?: boolean;
  probability?: number | null;
  // #rrggbb or null (migration 0039)
  color?: string | null;
}

export interface Property {
  id: string;
  api_name: string;
  label: string;
  description: string | null;
  type: 'text' | 'number' | 'dropdown' | 'date' | 'datetime' | 'calculation' | 'file' | 'id' | 'id_list';
  options: Record<string, unknown>;
  dropdown_options?: DropdownOption[];
  calc_output_type?: 'text' | 'number' | 'date' | 'datetime';
  calc_sql?: string;
  calc_last_error?: string;
  is_base: boolean;
  is_native?: boolean;
  read_only: boolean;
  record_status: string;
}

export interface ObjectDef extends ObjectSummary {
  // what the signed-in user may do with this object's records
  permissions: { create: boolean; edit: boolean; delete: boolean };
  properties: Property[];
}

export interface AssociatedRecord {
  id: string;
  labels: { label_id: string; label: string | null }[];
  properties?: Record<string, unknown>;
}

export interface CrmRecord {
  id: string;
  object_type_id: string;
  record_status: string;
  // batch read: the merged id that was asked for
  requested_id?: string;
  // single reads: false when the user can see but not edit this record
  can_edit?: boolean;
  properties: Record<string, unknown>;
  associations?: Record<string, AssociatedRecord[]>;
}

// search filters: groups are OR'ed, filters inside a group AND'ed
export interface Filter {
  property: string;
  operator: string;
  value?: unknown;
  values?: unknown[];
}

export interface FilterGroup {
  filters: Filter[];
}

export interface SearchResult {
  total: number;
  results: CrmRecord[];
  next: string | null;
}

export interface AssociationLabel {
  id: string;
  from_object_type: string;
  to_object_type: string;
  label: string | null;
  inverse_label: string | null;
  is_default: boolean;
  is_symmetric: boolean;
}

export type Column = (
  | { type: 'property'; property: string }
  | { type: 'association'; object: string; label_id: string | null }
) & { width?: number };

export interface Sort {
  property: string;
  direction: 'asc' | 'desc';
}

export interface View {
  id: number;
  object_type_id: string;
  name: string;
  owner: string | null;
  shared: boolean;
  editable: boolean;
  columns: Column[];
  sorts: Sort[];
  position: number;
}

export type NavItem =
  | { type: 'home' | 'divider' }
  | { type: 'object'; object: string; label?: string }
  | { type: 'view'; object: string; view_id: number; label?: string }
  | { type: 'custom_view'; slug: string; label?: string }
  | { type: 'section'; label: string; items: NavItem[] };

// A custom view the user can open (GET /v1/views), for menus
export interface CustomViewSummary {
  id: string;
  name: string | null;
  slug: string;
  icon: string | null;
  description: string | null;
  status: 'draft' | 'published';
  audience: 'admins' | 'everyone';
  unpublished_changes: boolean;
}

// ---- schema cache -----------------------------------------------------------

const schemaCache = new Map<string, Promise<ObjectDef>>();

export function getSchema(object: string): Promise<ObjectDef> {
  let p = schemaCache.get(object);
  if (!p) {
    p = api<ObjectDef>('GET', `/v1/schema/${object}`);
    p.catch(() => schemaCache.delete(object));
    schemaCache.set(object, p);
  }
  return p;
}

export function clearSchemaCache(): void {
  schemaCache.clear();
}
