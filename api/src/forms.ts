import type pg from 'pg';
import { ApiError, badRequest } from './errors.js';
import type { Principal } from './auth.js';
import { getObject, type ObjectDef, type PropertyDef } from './registry.js';
import { createRecord, findIdByUnique, updateRecord } from './records.js';

// Forms (crm.pc_0052): the `definition` property holds the form as JSON.
//
//   {"fields": [Field, ...], "submit_label": "Send", "success_message": "Thanks!"}
//
// A field is either a question of its own, or a contact or ticket property
// (`property`). On submit, contact properties upsert a contact by email and
// ticket properties always create a new ticket. Fields can be shown only when
// earlier answers match (`conditions`), and property fields can be hidden with
// a fixed value (`hidden` + `value`), e.g. a ticket's pipeline.

export type FieldType = 'text' | 'email' | 'phone' | 'textarea' | 'number' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'datetime';
export type FormObject = 'contacts' | 'tickets';
export type ConditionOperator =
  | 'is_any_of' | 'is_none_of' | 'is_checked' | 'is_not_checked' | 'is_before' | 'is_after' | 'is_on' | 'is_empty' | 'is_not_empty';

export interface Condition {
  field: string;
  operator: ConditionOperator;
  value?: string | string[];
}

export interface FormField {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  property?: { object: FormObject; name: string };
  hidden?: boolean;
  value?: unknown;
  conditions?: Condition[];
}

export interface FormDefinition {
  fields: FormField[];
  submit_label: string;
  success_message: string;
}

export const FORM_OBJECTS: FormObject[] = ['contacts', 'tickets'];
const FIELD_TYPES: FieldType[] = ['text', 'email', 'phone', 'textarea', 'number', 'select', 'multiselect', 'checkbox', 'date', 'datetime'];
const TEXT_TYPES: FieldType[] = ['text', 'email', 'phone', 'textarea'];
const FIELD_MAX: Partial<Record<FieldType, number>> = { text: 500, email: 254, phone: 50, textarea: 5000 };
const OPERATORS: Record<string, ConditionOperator[]> = {
  select: ['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  multiselect: ['is_any_of', 'is_none_of', 'is_empty', 'is_not_empty'],
  checkbox: ['is_checked', 'is_not_checked'],
  date: ['is_before', 'is_after', 'is_on', 'is_empty', 'is_not_empty'],
  datetime: ['is_before', 'is_after', 'is_on', 'is_empty', 'is_not_empty']
};
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Properties a form may fill: plain typed values the visitor can give.
export function formProperty(obj: ObjectDef, name: string): PropertyDef | null {
  const p = obj.byName.get(name);
  if (!p || p.row_status !== 'active' || p.read_only) return null;
  if (p.is_base && p.api_name !== 'name') return null;
  if (!['text', 'number', 'dropdown', 'date', 'datetime'].includes(p.type)) return null;
  if (p.options.auto_append_users === true) return null; // user pickers (owner) are not for visitors
  return p;
}

// The field type a property is asked with. Text properties may pick a text
// type; single-line text cannot be a textarea.
function typeFor(p: PropertyDef, wanted?: FieldType): FieldType {
  switch (p.type) {
    case 'number': return 'number';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'dropdown': return p.options.single_value === true ? 'select' : 'multiselect';
    default: {
      const single = p.options.single_line === true;
      if (wanted && TEXT_TYPES.includes(wanted) && !(single && wanted === 'textarea')) return wanted;
      if (/email/.test(p.api_name)) return 'email';
      if (/phone/.test(p.api_name)) return 'phone';
      return single ? 'text' : 'textarea';
    }
  }
}

const activeOptions = (p: PropertyDef) =>
  p.dropdown_options.filter((o) => o.row_status === 'active').sort((a, b) => a.display_order - b.display_order).map((o) => ({ value: o.api_value, label: o.label }));

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

// Reads a definition. strict (saving): every problem is an error. Not strict
// (serving and submitting): fields whose property was archived or changed are
// dropped, with the conditions that point at them, so a live form keeps working.
export async function readDefinition(raw: unknown, strict: boolean): Promise<FormDefinition> {
  const fail = (why: string) => (strict ? badRequest(why) : new ApiError(409, `this form is not set up correctly: ${why}`, 'form_misconfigured'));
  let def: Record<string, unknown>;
  try {
    def = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    throw fail('definition is not JSON');
  }
  if (!def || typeof def !== 'object' || !Array.isArray(def.fields)) throw fail('definition needs a fields list');
  if (def.fields.length > 100) throw fail('a form can have at most 100 fields');
  const objects = new Map<FormObject, ObjectDef>();
  for (const o of FORM_OBJECTS) objects.set(o, await getObject(o));

  const fields: FormField[] = [];
  const names = new Set<string>();
  const properties = new Set<string>();
  for (const [i, f] of (def.fields as Record<string, unknown>[]).entries()) {
    const where = `field ${i + 1}${typeof f?.label === 'string' && f.label ? ` ("${f.label}")` : ''}`;
    if (!f || typeof f !== 'object') throw fail(`${where} is not an object`);
    let prop: PropertyDef | null = null;
    let property: FormField['property'];
    if (f.property !== undefined && f.property !== null) {
      const ref = f.property as { object?: unknown; name?: unknown };
      if (!FORM_OBJECTS.includes(ref.object as FormObject)) throw fail(`${where}: forms can only fill contact and ticket properties`);
      prop = formProperty(objects.get(ref.object as FormObject)!, String(ref.name));
      if (!prop) {
        if (strict) throw fail(`${where}: ${String(ref.object)} property "${String(ref.name)}" cannot be filled by a form`);
        continue;
      }
      property = { object: ref.object as FormObject, name: prop.api_name };
      const key = `${property.object}.${property.name}`;
      if (properties.has(key)) throw fail(`${where}: ${key} is on the form twice`);
      properties.add(key);
    }
    const name = property ? `${property.object === 'contacts' ? 'contact' : 'ticket'}_${property.name}` : String(f.name ?? '');
    if (!NAME_RE.test(name)) throw fail(`${where} needs a key like "favorite_color" (lowercase letters, digits, underscores)`);
    if (names.has(name)) throw fail(`${where}: key "${name}" is used twice`);
    if (!prop && /^(contact|ticket)_/.test(name) && strict) throw fail(`${where}: keys starting with contact_ or ticket_ are kept for property fields`);

    const type = prop ? typeFor(prop, f.type as FieldType) : ((f.type ?? 'text') as FieldType);
    if (!FIELD_TYPES.includes(type)) throw fail(`${where} has unknown type "${String(f.type)}"`);

    let options: FormField['options'];
    if (prop?.type === 'dropdown') {
      options = activeOptions(prop);
      if (options.length === 0) {
        if (strict) throw fail(`${where}: ${prop.label} has no options to choose from`);
        continue;
      }
    } else if (type === 'select' || type === 'multiselect') {
      const raw = Array.isArray(f.options) ? f.options : [];
      options = raw.map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: String((o as { value?: unknown })?.value ?? ''), label: String((o as { label?: unknown })?.label ?? (o as { value?: unknown })?.value ?? '') }));
      options = options.filter((o) => o.value.trim()).map((o) => ({ value: o.value.trim().slice(0, 200), label: (o.label.trim() || o.value.trim()).slice(0, 200) }));
      if (options.length === 0 || options.length > 200) throw fail(`${where} needs 1 to 200 options`);
      if (new Set(options.map((o) => o.value)).size !== options.length) throw fail(`${where} lists an option twice`);
    }

    const field: FormField = {
      name,
      label: str(f.label, 300) ?? prop?.label ?? name,
      type,
      required: f.required === true,
      ...(str(f.placeholder, 200) ? { placeholder: str(f.placeholder, 200) } : {}),
      ...(str(f.help, 1000) ? { help: str(f.help, 1000) } : {}),
      ...(options ? { options } : {}),
      ...(property ? { property } : {})
    };

    if (f.hidden === true) {
      if (!property) throw fail(`${where}: only contact and ticket property fields can be hidden`);
      field.hidden = true;
      field.required = false;
      try {
        field.value = cleanValue(field, f.value);
      } catch (err) {
        throw fail(`${where}: the hidden value ${(err as Error).message}`);
      }
      if (field.value === undefined) throw fail(`${where}: a hidden field needs a value`);
    }

    if (Array.isArray(f.conditions) && f.conditions.length) {
      if (field.hidden) throw fail(`${where}: hidden fields cannot have conditions`);
      const conditions: Condition[] = [];
      for (const c of f.conditions as Record<string, unknown>[]) {
        const source = fields.find((x) => x.name === c?.field);
        if (!source) {
          if (strict) throw fail(`${where}: a condition must point at a question earlier on the form`);
          continue;
        }
        const ops = OPERATORS[source.type];
        if (!ops || source.hidden) throw fail(`${where}: conditions can only use dropdown, checkbox and date questions ("${source.label}" is ${source.type})`);
        const operator = c.operator as ConditionOperator;
        if (!ops.includes(operator)) throw fail(`${where}: "${String(c.operator)}" does not work with "${source.label}"`);
        const cond: Condition = { field: source.name, operator };
        if (operator === 'is_any_of' || operator === 'is_none_of') {
          const values = (Array.isArray(c.value) ? c.value : [c.value]).map(String);
          const known = new Set(source.options!.map((o) => o.value));
          const kept = values.filter((v) => known.has(v));
          if (kept.length === 0 || (strict && kept.length !== values.length)) {
            if (strict) throw fail(`${where}: pick one or more options of "${source.label}" for the condition`);
            continue;
          }
          cond.value = kept;
        } else if (operator === 'is_before' || operator === 'is_after' || operator === 'is_on') {
          if (typeof c.value !== 'string' || !DATE_RE.test(c.value)) throw fail(`${where}: the condition needs a date like 2026-12-31`);
          cond.value = c.value;
        }
        conditions.push(cond);
      }
      if (conditions.length) field.conditions = conditions;
    }

    names.add(name);
    fields.push(field);
  }

  if (strict && fields.length === 0) throw fail('add at least one field');
  const contactFields = fields.filter((f) => f.property?.object === 'contacts');
  if (contactFields.length) {
    const email = contactFields.find((f) => f.property!.name === 'email');
    if (!email || email.hidden || email.conditions || !email.required) {
      throw fail('a form with contact properties needs the contact Email field, required and always shown (contacts are matched by email)');
    }
  }
  if (strict && !fields.some((f) => !f.hidden)) throw fail('the form needs at least one visible field');
  return {
    fields,
    submit_label: str(def.submit_label, 100) ?? 'Submit',
    success_message: str(def.success_message, 1000) ?? 'Thanks, your answers were sent.'
  };
}

// What the browser gets: no hidden fields (their values may be internal, like
// an owner) and no property names.
export function publicDefinition(def: FormDefinition) {
  return {
    ...def,
    fields: def.fields.filter((f) => !f.hidden).map(({ property: _p, hidden: _h, value: _v, ...f }) => f)
  };
}

// ---- conditions ----------------------------------------------------------------

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)]);

export function conditionMet(c: Condition, v: unknown): boolean {
  const empty = v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
  switch (c.operator) {
    case 'is_empty': return empty;
    case 'is_not_empty': return !empty;
    case 'is_checked': return v === true;
    case 'is_not_checked': return v !== true;
    case 'is_any_of': return asList(v).some((x) => (c.value as string[]).includes(x));
    case 'is_none_of': return !asList(v).some((x) => (c.value as string[]).includes(x));
    default: {
      if (empty) return false;
      const day = String(v).slice(0, 10);
      const ref = String(c.value);
      return c.operator === 'is_before' ? day < ref : c.operator === 'is_after' ? day > ref : day === ref;
    }
  }
}

// Fields are shown in order; a field is shown when all its conditions hold,
// judged on the answers to fields that are themselves shown.
export function visibleFields(def: FormDefinition, values: Record<string, unknown>): Set<string> {
  const shown = new Set<string>();
  for (const f of def.fields) {
    if (f.hidden) continue;
    if ((f.conditions ?? []).every((c) => conditionMet(c, shown.has(c.field) ? values[c.field] : undefined))) shown.add(f.name);
  }
  return shown;
}

// ---- values --------------------------------------------------------------------

// One answer, checked and normalized; undefined means no answer. Throws a
// plain Error whose message completes "<label> ...".
function cleanValue(f: FormField, v: unknown): unknown {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) return undefined;
  switch (f.type) {
    case 'checkbox':
      if (v === true || v === 'true') return true;
      if (v === false || v === 'false') return undefined;
      throw new Error('must be checked or not');
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw new Error('must be a number');
      return n;
    }
    case 'select': {
      if (typeof v !== 'string' || !f.options!.some((o) => o.value === v)) throw new Error('must be one of the listed options');
      return v;
    }
    case 'multiselect': {
      const list = Array.isArray(v) ? v : [v];
      if (!list.every((x) => typeof x === 'string' && f.options!.some((o) => o.value === x))) throw new Error('must be among the listed options');
      return [...new Set(list as string[])];
    }
    case 'date': {
      if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error('must be a date');
      return v;
    }
    case 'datetime': {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      if (Number.isNaN(t)) throw new Error('must be a date and time');
      return new Date(t).toISOString();
    }
    default: {
      if (typeof v !== 'string') throw new Error('must be text');
      const s = v.trim();
      if (!s) return undefined;
      const max = FIELD_MAX[f.type] ?? 500;
      if (s.length > max) throw new Error(`must be at most ${max} characters`);
      if (f.type !== 'textarea' && /[\r\n]/.test(s)) throw new Error('must be a single line');
      if (f.type === 'email' && !EMAIL_RE.test(s)) throw new Error('must be an email address');
      return s;
    }
  }
}

// Checks the visitor's answers: unknown keys are refused, answers to fields
// that are not shown are dropped, required shown fields must be answered.
// Hidden fields get their fixed values.
export function cleanAnswers(def: FormDefinition, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('values must be an object');
  const given = input as Record<string, unknown>;
  const known = new Set(def.fields.filter((f) => !f.hidden).map((f) => f.name));
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  if (unknown.length) throw badRequest(`unknown fields: ${unknown.join(', ')}`);

  // visibility depends on cleaned answers, so clean in order
  const out: Record<string, unknown> = {};
  const shown = new Set<string>();
  for (const f of def.fields) {
    if (f.hidden) {
      out[f.name] = f.value;
      continue;
    }
    if (!(f.conditions ?? []).every((c) => conditionMet(c, shown.has(c.field) ? out[c.field] : undefined))) continue;
    shown.add(f.name);
    let v: unknown;
    try {
      v = cleanValue(f, given[f.name]);
    } catch (err) {
      throw badRequest(`${f.label} ${(err as Error).message}`, { field: f.name });
    }
    if (v === undefined) {
      if (f.required) throw badRequest(`${f.label} is required`, { field: f.name });
      continue;
    }
    out[f.name] = v;
  }
  return out;
}

function display(f: FormField, v: unknown): string {
  if (f.type === 'checkbox') return v === true ? 'Yes' : 'No';
  if (f.options) return asList(v).map((x) => f.options!.find((o) => o.value === x)?.label ?? x).join(', ');
  return String(v);
}

export function summarize(def: FormDefinition, values: Record<string, unknown>) {
  return def.fields
    .filter((f) => values[f.name] !== undefined)
    .map((f) => ({
      name: f.name,
      label: f.label,
      value: display(f, values[f.name]),
      ...(f.property ? { property: `${f.property.object}.${f.property.name}` } : {}),
      ...(f.hidden ? { hidden: true } : {})
    }));
}

// ---- submit --------------------------------------------------------------------

export interface SubmissionMeta {
  form: { id: string; name: string | null };
  pageUrl: string | null;
  origin: string;
  ip: string;
  userAgent: string | null;
}

// Stores a submission and applies it: upserts the contact (by email), creates
// the ticket, and links submission, form, contact and ticket. One transaction.
export async function applySubmission(
  client: pg.PoolClient, principal: Principal, def: FormDefinition, values: Record<string, unknown>, meta: SubmissionMeta
): Promise<{ submission: string; contact: string | null; ticket: string | null }> {
  const props = (object: FormObject) => {
    const out: Record<string, unknown> = {};
    for (const f of def.fields) if (f.property?.object === object && values[f.name] !== undefined) out[f.property.name] = values[f.name];
    return out;
  };

  let contact: string | null = null;
  if (def.fields.some((f) => f.property?.object === 'contacts')) {
    const contacts = await getObject('contacts');
    const p = props('contacts');
    contact = await findIdByUnique(client, contacts, 'email', p.email);
    if (contact) {
      await updateRecord(client, contacts, principal, contact, p);
    } else {
      contact = await createRecord(client, contacts, principal, p);
    }
  }

  let ticket: string | null = null;
  if (def.fields.some((f) => f.property?.object === 'tickets')) {
    const tickets = await getObject('tickets');
    const p = props('tickets');
    const who = (props('contacts').email as string | undefined) ?? new Date().toISOString().slice(0, 10);
    if (p.name === undefined) p.name = `${meta.form.name ?? 'Form'}: ${who}`.slice(0, 200);
    ticket = await createRecord(client, tickets, principal, p, contact ? [{ object: 'contacts', id: contact }] : []);
  }

  const email = def.fields.find((f) => f.type === 'email' && typeof values[f.name] === 'string');
  const submissions = await getObject('form_submissions');
  const submission = await createRecord(client, submissions, principal, {
    name: `${meta.form.name ?? 'Form'}: ${email ? values[email.name] : new Date().toISOString().slice(0, 10)}`.slice(0, 200),
    form_id: meta.form.id,
    submitted_at: new Date().toISOString(),
    page_url: meta.pageUrl,
    submission_values: JSON.stringify(values),
    summary: JSON.stringify(summarize(def, values)),
    origin: meta.origin,
    ip_address: meta.ip,
    user_agent: meta.userAgent
  }, [
    { object: 'forms', id: meta.form.id },
    ...(contact ? [{ object: 'contacts', id: contact }] : []),
    ...(ticket ? [{ object: 'tickets', id: ticket }] : [])
  ]);
  return { submission, contact, ticket };
}
