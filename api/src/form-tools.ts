import { randomBytes } from 'node:crypto';
import { pool, withTx } from './db.js';
import { badRequest, notFound } from './errors.js';
import { requireObjectPermission, requireScope, type Principal } from './auth.js';
import { getObject } from './registry.js';
import { createRecord, updateRecord } from './records.js';
import { readDefinition, type FormDefinition } from './forms.js';

// Forms and booking pages for the MCP (list_forms, list_booking_pages,
// create_form, publish_form): what a landing page needs to embed them with
// <div data-pcrm-form="KEY"> / <div data-pcrm-booking="KEY">.

const uiBase = (process.env.UI_URL ?? '').replace(/\/$/, '');

// the address the embed and the hosted page use: the slug if set, else the random key
const embedKey = (r: { slug: string | null; public_key: string | null }) => r.slug || r.public_key || null;

function fieldsOf(raw: string | null) {
  if (!raw) return [];
  try {
    const def = JSON.parse(raw) as Partial<FormDefinition>;
    return (def.fields ?? []).map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: !!f.required,
      ...(f.property ? { property: `${f.property.object}.${f.property.name}` } : {}),
      ...(f.hidden ? { hidden: true } : {}),
      ...(f.from_url ? { from_url: true } : {})
    }));
  } catch {
    return [];
  }
}

export async function listForms(p: Principal) {
  requireObjectPermission(p, await getObject('forms'), 'read');
  const { rows } = await pool.query(
    `select pc_0052_id as id, name, public_name, description, slug, public_key, status[1] as status, definition, html is not null and html <> '' as custom_html, updated_at
     from crm.pc_0052 where record_status = 'active' order by lower(name), pc_0052_id`
  );
  return rows.map((r) => formOut(r));
}

function formOut(r: { id: string; name: string | null; public_name?: string | null; description: string | null; slug: string | null; public_key: string | null; status: string | null; definition: string | null; custom_html?: boolean; updated_at?: Date }) {
  const key = embedKey(r);
  return {
    id: r.id,
    name: r.name,
    public_name: r.public_name ?? null,
    description: r.description,
    status: r.status,
    published: r.status === 'published',
    key,
    embed: key ? `<div data-pcrm-form="${key}"></div>` : null,
    hosted_url: key ? `${uiBase}/p/form/#${key}` : null,
    fields: fieldsOf(r.definition),
    ...(r.custom_html !== undefined ? { custom_html: r.custom_html } : {}),
    ...(r.updated_at ? { updated_at: r.updated_at } : {}),
    ...(key ? {} : { note: 'No key yet: give it a slug (update_record) before embedding it.' })
  };
}

export async function listBookingPages(p: Principal) {
  requireObjectPermission(p, await getObject('booking_pages'), 'read');
  const { rows } = await pool.query(
    `select pc_0054_id as id, name, public_name, description, slug, public_key, status[1] as status, duration_minutes, location_type[1] as location_type,
       host is not null as has_host, form_before_id, form_after_id, updated_at
     from crm.pc_0054 where record_status = 'active' order by lower(name), pc_0054_id`
  );
  return rows.map((r) => {
    const key = embedKey(r);
    return {
      id: r.id,
      name: r.name,
      public_name: r.public_name,
      description: r.description,
      status: r.status,
      published: r.status === 'published',
      key,
      embed: key ? `<div data-pcrm-booking="${key}"></div>` : null,
      hosted_url: key ? `${uiBase}/p/book/#${key}` : null,
      duration_minutes: r.duration_minutes === null ? null : Number(r.duration_minutes),
      location_type: r.location_type,
      form_before_id: r.form_before_id,
      form_after_id: r.form_after_id,
      updated_at: r.updated_at,
      ...(r.has_host ? {} : { note: 'No host set: it cannot take bookings until a host is picked in the CRM.' })
    };
  });
}

async function loadForm(idOrKey: string) {
  const { rows } = await pool.query(
    `select pc_0052_id as id, name, public_name, description, slug, public_key, status[1] as status, definition from crm.pc_0052
     where record_status = 'active' and (pc_0052_id = $1 or lower(slug) = lower($1) or public_key = $1) limit 1`,
    [idOrKey]
  );
  if (!rows[0]) throw notFound(`no form "${idOrKey}"`);
  return rows[0];
}

export interface CreateFormInput {
  name?: string;
  public_name?: string;
  slug?: string;
  description?: string;
  definition?: unknown;
}

// A new form as a draft. definition is checked like the form builder's save.
export async function createForm(p: Principal, input: CreateFormInput) {
  requireScope(p, 'write');
  if (typeof input.name !== 'string' || !input.name.trim()) throw badRequest('a form needs a name');
  if (input.definition === undefined) throw badRequest('definition is required: {"fields": [...], "submit_label": "...", "success_message": "..."}');
  const definition = await readDefinition(input.definition, true);
  const obj = await getObject('forms');
  const id = await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, (c) =>
    createRecord(c, obj, p, {
      name: input.name!.trim(),
      public_name: input.public_name?.trim() || null,
      description: input.description ?? null,
      ...(input.slug ? { slug: input.slug } : { public_key: randomBytes(16).toString('base64url') }),
      definition: JSON.stringify(definition),
      status: 'draft'
    })
  );
  return formOut(await loadForm(id));
}

// Publishing makes the form answerable by anyone who has its page or embed.
export async function setFormPublished(p: Principal, idOrKey: string, published: boolean) {
  requireScope(p, 'write');
  const form = await loadForm(idOrKey);
  if (published) await readDefinition(form.definition ?? '', true);
  const obj = await getObject('forms');
  await withTx({ principal: p, source: p.oauth ? 'mcp' : 'api' }, (c) => updateRecord(c, obj, p, form.id, { status: published ? 'published' : 'draft' }));
  return formOut(await loadForm(form.id));
}
