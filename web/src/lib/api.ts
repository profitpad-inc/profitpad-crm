// Thin client for the CRM API. Until SSO exists the UI signs in with an API
// key, kept in localStorage.

const KEY_STORAGE = 'pcrm.apiKey';

export function getApiKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // storage unavailable: the key lives only for this page load
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

// Where the API lives. Empty in dev (Vite proxies /v1); in production the
// static site (GitHub Pages) is built with VITE_API_URL=https://<api host>.
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export async function api<T = unknown>(method: string, path: string, body?: unknown, key = getApiKey()): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!res.ok) throw new ApiError(res.status, data?.message ?? res.statusText, data?.error);
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
}

export interface DropdownOption {
  api_value: string;
  label: string;
  display_order: number;
  row_status: string;
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
  is_base: boolean;
  read_only: boolean;
  row_status: string;
}

export interface ObjectDef extends ObjectSummary {
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
  row_status: string;
  // batch read: the merged id that was asked for
  requested_id?: string;
  properties: Record<string, unknown>;
  associations?: Record<string, AssociatedRecord[]>;
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

export type Column =
  | { type: 'property'; property: string }
  | { type: 'association'; object: string; label_id: string | null };

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
  | { type: 'home' | 'reporting' | 'divider' }
  | { type: 'object'; object: string; label?: string }
  | { type: 'view'; object: string; view_id: number; label?: string }
  | { type: 'section'; label: string; items: NavItem[] };

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
