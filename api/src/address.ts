import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';
import { ApiError, badRequest, forbidden } from './errors.js';
import { requireRecentSignIn, requireScope } from './auth.js';
import { getObject, getProperty, type ObjectDef } from './registry.js';
import { open, seal, secretBoxReady } from './secret-box.js';
import { logEvent } from './audit.js';
import { isAdmin } from './routes/ui.js';

// Address autocomplete (migration 0069, Settings → Address autocomplete,
// web/src/components/AddressInput.tsx). Once an admin adds a Google Maps API
// key, the street box of each address group suggests addresses as people
// type; picking one fills the group's other boxes (street 2, city,
// province, postal code, country). The key stays on this server: the browser
// asks this API, which asks Google Places (New), the same two calls as the
// n8n flow "Test CRM: address autocomplete" (autocomplete, then place
// details for the picked suggestion, with one session token so Google bills
// the pair as one session).

const PLACES = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 10_000;

export interface AddressGroup {
  object: string;
  street_1: string;
  street_2?: string;
  city?: string;
  province?: string;
  postal_code?: string;
  country?: string;
}

const PARTS = ['street_1', 'street_2', 'city', 'province', 'postal_code', 'country'] as const;

// Street 1 on contacts and companies with their built-in address properties
// (migrations 0058 and 0059).
export const DEFAULT_GROUPS: AddressGroup[] = ['contacts', 'companies'].map((object) => ({
  object,
  street_1: 'address_street_1',
  street_2: 'address_street_2',
  city: 'address_city',
  province: 'address_province',
  postal_code: 'address_postalcode',
  country: 'address_country'
}));

interface Settings {
  enabled: boolean;
  key: string | null;
  key_hint: string | null;
  countries: string[];
  groups: AddressGroup[] | null; // null: DEFAULT_GROUPS
}

let cached: { at: number; value: Settings } | null = null;

async function loadSettings(): Promise<Settings> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const { rows } = await pool.query('select enabled, google_key, key_hint, countries, groups from auth.address_settings');
  const r = rows[0];
  let key: string | null = null;
  if (r?.google_key && secretBoxReady()) {
    try {
      key = open(r.google_key);
    } catch {
      key = null; // sealed with another MASTER_ENCRYPTION_KEY
    }
  }
  const value: Settings = r
    ? { enabled: r.enabled, key, key_hint: r.key_hint, countries: r.countries ?? [], groups: r.groups ?? null }
    : { enabled: true, key: null, key_hint: null, countries: ['CA', 'US'], groups: null };
  cached = { at: Date.now(), value };
  return value;
}

// Groups whose object and street property still exist and are active (a
// property archived since it was picked drops out instead of failing);
// optional parts that no longer exist are left out.
async function liveGroups(groups: AddressGroup[]): Promise<AddressGroup[]> {
  const out: AddressGroup[] = [];
  for (const g of groups) {
    let obj: ObjectDef;
    try {
      obj = await getObject(g.object);
    } catch {
      continue;
    }
    const ok = (name: string | undefined) => {
      if (!name) return false;
      const p = getProperty(obj, name);
      return !!p && p.record_status === 'active';
    };
    if (!ok(g.street_1)) continue;
    const live: AddressGroup = { object: obj.api_name, street_1: g.street_1 };
    for (const part of PARTS) if (part !== 'street_1' && ok(g[part])) live[part] = g[part];
    out.push(live);
  }
  return out;
}

// Checks groups an admin saves: known objects, properties on them that can
// hold the part, and each property used once per object.
export async function checkGroups(raw: unknown): Promise<AddressGroup[]> {
  if (!Array.isArray(raw)) throw badRequest('groups must be a list');
  if (raw.length > 50) throw badRequest('at most 50 address groups');
  const out: AddressGroup[] = [];
  const used = new Set<string>();
  for (const [i, g] of raw.entries()) {
    const at = `Address group ${i + 1}`;
    if (!g || typeof g !== 'object') throw badRequest(`${at} must be an object`);
    const b = g as Record<string, unknown>;
    if (typeof b.object !== 'string' || !b.object) throw badRequest(`${at}: pick an object`);
    let obj: ObjectDef;
    try {
      obj = await getObject(b.object);
    } catch {
      throw badRequest(`${at}: there is no object "${b.object}"`);
    }
    const group: AddressGroup = { object: obj.api_name, street_1: '' };
    for (const part of PARTS) {
      const name = b[part];
      if (name === undefined || name === null || name === '') {
        if (part === 'street_1') throw badRequest(`${at}: pick the street property suggestions show on`);
        continue;
      }
      if (typeof name !== 'string') throw badRequest(`${at}: ${part} must be a property api_name`);
      const p = getProperty(obj, name);
      if (!p || p.record_status !== 'active') throw badRequest(`${at}: ${obj.label_plural} has no property "${name}"`);
      const dropdown = p.type === 'dropdown' && p.options.single_value === true;
      const text = p.type === 'text' && !p.is_base && !p.read_only && p.options.display !== 'phone' && p.options.display !== 'html';
      if (part === 'street_1' ? !text : !(text || ((part === 'province' || part === 'country') && dropdown))) {
        throw badRequest(`${at}: ${p.label} can't hold the ${part.replace('_', ' ')}${part === 'province' || part === 'country' ? ' (use a text property or a single-value dropdown)' : ' (use a text property)'}`);
      }
      const k = `${obj.api_name}.${name}`;
      if (used.has(k)) throw badRequest(`${at}: ${p.label} is already used in another address group or part`);
      used.add(k);
      group[part] = name;
    }
    out.push(group);
  }
  return out;
}

// ---- Google Places (New) -----------------------------------------------------

export interface Suggestion { place_id: string; main: string; secondary: string; label: string }
export interface PlaceAddress {
  street_1: string;
  street_2: string;
  city: string;
  province_code: string;
  province_name: string;
  postal_code: string;
  country_code: string;
  country_name: string;
  formatted: string;
}

class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string | null) {
    super(message);
  }
}

async function google(apiKey: string, path: string, init: { method: 'GET' | 'POST'; body?: unknown; fieldMask?: string }): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${PLACES}${path}`, {
      method: init.method,
      headers: {
        'X-Goog-Api-Key': apiKey,
        ...(init.fieldMask ? { 'X-Goog-FieldMask': init.fieldMask } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    throw new GoogleError('Google Places did not answer. Try again.', 0, null);
  }
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || json?.error) {
    const err = json?.error ?? {};
    const reason = (err.details ?? []).find((d: any) => d?.reason)?.reason ?? err.status ?? null;
    throw new GoogleError(err.message || `Google Places answered ${res.status}`, res.status, reason);
  }
  return json;
}

export function suggestionsFrom(res: any): Suggestion[] {
  return (res?.suggestions ?? [])
    .map((s: any) => s?.placePrediction)
    .filter(Boolean)
    .slice(0, 6)
    .map((p: any) => ({
      place_id: String(p.placeId ?? ''),
      main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
      secondary: p.structuredFormat?.secondaryText?.text ?? '',
      label: p.text?.text ?? ''
    }))
    .filter((s: Suggestion) => s.place_id);
}

export function addressFrom(res: any): PlaceAddress {
  const comps: any[] = res?.addressComponents ?? [];
  const get = (type: string, short = false) => {
    const c = comps.find((x) => (x.types ?? []).includes(type));
    if (!c) return '';
    return short ? c.shortText || c.longText || '' : c.longText || c.shortText || '';
  };
  return {
    street_1: [get('street_number'), get('route')].filter(Boolean).join(' '),
    street_2: get('subpremise'),
    city: get('locality') || get('postal_town') || get('sublocality') || get('sublocality_level_1') || get('administrative_area_level_3'),
    province_code: get('administrative_area_level_1', true),
    province_name: get('administrative_area_level_1'),
    postal_code: get('postal_code'),
    country_code: get('country', true),
    country_name: get('country'),
    formatted: res?.formattedAddress ?? ''
  };
}

const autocompleteBody = (query: string, countries: string[], session?: string) => ({
  input: query,
  ...(countries.length ? { includedRegionCodes: countries.map((c) => c.toLowerCase()) } : {}),
  ...(session ? { sessionToken: session } : {})
});

// A cheap call that fails on a bad key, or on one without Places API (New).
async function checkKey(apiKey: string): Promise<void> {
  try {
    await google(apiKey, '/places:autocomplete', { method: 'POST', body: { input: '1 Main St' } });
  } catch (err) {
    if (err instanceof GoogleError && err.status >= 400 && err.status < 500) {
      throw badRequest(`Google did not accept this key: ${err.message}`);
    }
    throw new ApiError(502, err instanceof Error ? err.message : 'Could not check the key with Google. Try again.', 'key_check_failed');
  }
}

const cleanSession = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined);

function settingsOut(s: Settings, groups: AddressGroup[]) {
  return {
    enabled: s.enabled,
    has_key: s.key_hint !== null,
    key_unreadable: s.key_hint !== null && s.key === null,
    key_hint: s.key_hint,
    countries: s.countries,
    groups,
    using_defaults: s.groups === null,
    default_groups: DEFAULT_GROUPS,
    can_store_secrets: secretBoxReady()
  };
}

// ---- routes -------------------------------------------------------------------

export async function addressRoutes(app: FastifyInstance) {
  // For every signed-in page: whether street boxes suggest addresses, and
  // which properties make up each group.
  app.get('/v1/address/config', async (req) => {
    const p = req.principal!;
    requireScope(p, 'read');
    const s = await loadSettings();
    const on = s.enabled && !!s.key;
    return { enabled: on, groups: on ? await liveGroups(s.groups ?? DEFAULT_GROUPS) : [] };
  });

  app.post<{ Body: { query?: unknown; session?: unknown } }>('/v1/address/autocomplete', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const query = typeof req.body?.query === 'string' ? req.body.query.trim().slice(0, 200) : '';
    if (query.length < 3) return { suggestions: [] };
    const s = await loadSettings();
    if (!s.enabled || !s.key) throw new ApiError(503, 'Address autocomplete is not set up.', 'address_autocomplete_off');
    try {
      const res = await google(s.key, '/places:autocomplete', { method: 'POST', body: autocompleteBody(query, s.countries, cleanSession(req.body?.session)) });
      return { suggestions: suggestionsFrom(res) };
    } catch (err) {
      if (err instanceof GoogleError) throw new ApiError(502, `Google Places: ${err.message}`, 'google_places_error');
      throw err;
    }
  });

  app.post<{ Body: { place_id?: unknown; session?: unknown } }>('/v1/address/details', async (req) => {
    const p = req.principal!;
    requireScope(p, 'write');
    const placeId = typeof req.body?.place_id === 'string' ? req.body.place_id : '';
    if (!/^[A-Za-z0-9_-]{10,400}$/.test(placeId)) throw badRequest('place_id must be a suggestion\'s place_id');
    const s = await loadSettings();
    if (!s.enabled || !s.key) throw new ApiError(503, 'Address autocomplete is not set up.', 'address_autocomplete_off');
    const session = cleanSession(req.body?.session);
    try {
      const res = await google(s.key, `/places/${encodeURIComponent(placeId)}${session ? `?sessionToken=${session}` : ''}`, {
        method: 'GET', fieldMask: 'addressComponents,formattedAddress'
      });
      return { address: addressFrom(res) };
    } catch (err) {
      if (err instanceof GoogleError) throw new ApiError(502, `Google Places: ${err.message}`, 'google_places_error');
      throw err;
    }
  });

  // ---- admin: Settings → Address autocomplete ----

  app.get('/v1/address/settings', async (req) => {
    const p = req.principal!;
    if (!isAdmin(p)) throw forbidden('only admins can see address autocomplete settings');
    const s = await loadSettings();
    return settingsOut(s, s.groups ?? DEFAULT_GROUPS);
  });

  // google_key: a new key (checked with Google before it is stored), or null
  // to remove it. groups: a list, or null to go back to the defaults.
  app.put<{ Body: { enabled?: unknown; google_key?: unknown; countries?: unknown; groups?: unknown } }>('/v1/address/settings', async (req) => {
    const p = req.principal!;
    if (!isAdmin(p)) throw forbidden('only admins can change address autocomplete settings');
    requireRecentSignIn(p);
    const b = req.body ?? {};
    const cur = await loadSettings();
    const next = { enabled: cur.enabled, countries: cur.countries, groups: cur.groups };
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw badRequest('enabled must be true or false');
      next.enabled = b.enabled;
    }
    if (b.countries !== undefined) {
      if (!Array.isArray(b.countries) || b.countries.some((c) => typeof c !== 'string' || !/^[A-Za-z]{2}$/.test(c))) {
        throw badRequest('countries must be a list of 2-letter country codes');
      }
      const list = [...new Set((b.countries as string[]).map((c) => c.toUpperCase()))];
      if (list.length > 15) throw badRequest('Google allows at most 15 countries');
      next.countries = list;
    }
    if (b.groups !== undefined) next.groups = b.groups === null ? null : await checkGroups(b.groups);
    let keyChange: { sealed: Buffer | null; hint: string | null } | undefined;
    if (b.google_key === null || b.google_key === '') {
      keyChange = { sealed: null, hint: null };
    } else if (b.google_key !== undefined) {
      const key = typeof b.google_key === 'string' ? b.google_key.trim() : '';
      if (!/^AIza[0-9A-Za-z_-]{30,60}$/.test(key)) throw badRequest('That does not look like a Google Maps API key (they start with AIza).');
      if (!secretBoxReady()) throw new ApiError(503, 'The server cannot store secrets: MASTER_ENCRYPTION_KEY is not set.', 'not_configured');
      await checkKey(key);
      keyChange = { sealed: seal(key), hint: key.slice(-4) };
    }
    const params = [
      next.enabled, keyChange?.sealed ?? null, keyChange?.hint ?? null, next.countries,
      next.groups === null ? null : JSON.stringify(next.groups), p.actor, keyChange !== undefined
    ];
    const { rowCount } = await pool.query(
      `update auth.address_settings set enabled = $1,
         google_key = case when $7 then $2 else google_key end,
         key_hint = case when $7 then $3 else key_hint end,
         countries = $4, groups = $5::jsonb, updated_by = $6, updated_at = now()
       where id`,
      params
    );
    if (!rowCount) {
      await pool.query(
        `insert into auth.address_settings (id, enabled, google_key, key_hint, countries, groups, updated_by)
         values (true, $1, $2, $3, $4, $5::jsonb, $6)`,
        params.slice(0, 6)
      );
    }
    cached = null;
    await logEvent(req, 'settings.updated', {
      target: { type: 'setting', id: 'address_autocomplete' },
      details: {
        enabled: next.enabled, countries: next.countries, groups: next.groups === null ? 'default' : next.groups.length,
        ...(keyChange ? { google_key: keyChange.sealed ? 'replaced' : 'removed' } : {})
      }
    });
    const s = await loadSettings();
    return settingsOut(s, s.groups ?? DEFAULT_GROUPS);
  });
}
