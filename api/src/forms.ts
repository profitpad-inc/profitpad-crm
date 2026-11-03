import type pg from 'pg';
import { ApiError, badRequest } from './errors.js';
import type { Principal } from './auth.js';
import { getObject, type ObjectDef, type PropertyDef } from './registry.js';
import { cleanSlug, createRecord, findIdByUnique, onWrite, updateRecord } from './records.js';
import sanitizeHtml from 'sanitize-html';
import { checkPhone } from './phone.js';
import { DomUtils, parseDocument } from 'htmlparser2';

// Forms (crm.pc_0052): the `definition` property holds the form as JSON.
//
//   {"fields": [Field, ...], "submit_label": "Send", "success_message": "Thanks!"}
//
// A field is either a question of its own, or a contact or ticket property
// (`property`). On submit, contact properties upsert a contact by email and
// ticket properties always create a new ticket. Fields can be shown only when
// earlier answers match (`conditions`), and property fields can be hidden with
// a fixed value (`hidden` + `value`), e.g. a ticket's pipeline. A field with
// `from_url` is never shown: its value comes only from the page's query
// parameter of the same key (any field is also prefilled that way). Text
// fields can check a `format`: email, phone, url, or `regex` with `pattern`.

// 'email' and 'phone' are read as text with that format (older definitions)
export type FieldType = 'text' | 'email' | 'phone' | 'textarea' | 'number' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'datetime';
export type TextFormat = 'email' | 'phone' | 'url' | 'regex';
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
  format?: TextFormat;
  pattern?: string;
  pattern_message?: string;
  property?: { object: FormObject; name: string };
  hidden?: boolean;
  value?: unknown;
  from_url?: boolean;
  conditions?: Condition[];
}

export interface FormDefinition {
  fields: FormField[];
  submit_label: string;
  success_message: string;
}

export const FORM_OBJECTS: FormObject[] = ['contacts', 'tickets'];
const FIELD_TYPES: FieldType[] = ['text', 'email', 'phone', 'textarea', 'number', 'select', 'multiselect', 'checkbox', 'date', 'datetime'];
const TEXT_FORMATS: TextFormat[] = ['email', 'phone', 'url', 'regex'];
const FIELD_MAX: Partial<Record<FieldType, number>> = { text: 500, textarea: 5000 };
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

const URL_RE = /^https?:\/\/[^\s]+$/;
// custom patterns match the whole answer, like the HTML pattern attribute
export const patternRegExp = (pattern: string) => new RegExp(`^(?:${pattern})$`);

// Properties a form may fill: plain typed values the visitor can give.
export function formProperty(obj: ObjectDef, name: string): PropertyDef | null {
  const p = obj.byName.get(name);
  if (!p || p.record_status !== 'active' || p.read_only) return null;
  if (p.is_base && p.api_name !== 'name') return null;
  if (!['text', 'number', 'dropdown', 'date', 'datetime'].includes(p.type)) return null;
  if (p.options.auto_append_users === true) return null; // user pickers (owner) are not for visitors
  return p;
}

// The field type a property is asked with. Text properties are a single line
// or a multi-line box; single-line text cannot be multi-line.
function typeFor(p: PropertyDef, wanted?: FieldType): FieldType {
  switch (p.type) {
    case 'number': return 'number';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'dropdown': return p.options.single_value === true ? 'select' : 'multiselect';
    default:
      return wanted === 'textarea' && p.options.single_line !== true ? 'textarea' : 'text';
  }
}

const activeOptions = (p: PropertyDef) =>
  p.dropdown_options.filter((o) => o.record_status === 'active').sort((a, b) => a.display_order - b.display_order).map((o) => ({ value: o.api_value, label: o.label }));

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

    const given = (f.type ?? 'text') as FieldType;
    if (!FIELD_TYPES.includes(given)) throw fail(`${where} has unknown type "${String(f.type)}"`);
    const type = prop ? typeFor(prop, given) : given === 'email' || given === 'phone' ? 'text' : given;

    // format: what a text answer must look like
    let format: TextFormat | undefined;
    const rawFormat = f.format ?? (given === 'email' || given === 'phone' ? given : undefined);
    if (rawFormat !== undefined && rawFormat !== null && rawFormat !== '') {
      if (!TEXT_FORMATS.includes(rawFormat as TextFormat)) throw fail(`${where} has unknown format "${String(rawFormat)}"`);
      if (type !== 'text' && type !== 'textarea') throw fail(`${where}: only text fields can check a format`);
      format = rawFormat as TextFormat;
    }
    if (property?.object === 'contacts' && property.name === 'email') format = 'email';
    let pattern: string | undefined;
    if (format === 'regex') {
      pattern = typeof f.pattern === 'string' ? f.pattern : '';
      if (!pattern || pattern.length > 500) throw fail(`${where}: the custom format needs a regular expression (up to 500 characters)`);
      try {
        patternRegExp(pattern);
      } catch {
        throw fail(`${where}: "${pattern}" is not a valid regular expression`);
      }
    }

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
      ...(format ? { format } : {}),
      ...(pattern ? { pattern } : {}),
      ...(pattern && str(f.pattern_message, 200) ? { pattern_message: str(f.pattern_message, 200) } : {}),
      ...(property ? { property } : {})
    };

    if (f.from_url === true) {
      if (f.hidden === true) throw fail(`${where}: a field is either filled from the URL or set to a fixed value, not both`);
      if (property?.object === 'contacts' && property.name === 'email') throw fail(`${where}: the contact email must be asked on the form`);
      field.from_url = true;
      field.required = false;
      delete field.placeholder;
      delete field.help;
    }

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
      if (field.hidden || field.from_url) throw fail(`${where}: hidden fields cannot have conditions`);
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
    if (!email || email.hidden || email.from_url || email.conditions || !email.required) {
      throw fail('a form with contact properties needs the contact Email field, required and always shown (contacts are matched by email)');
    }
  }
  if (strict && !fields.some((f) => !f.hidden && !f.from_url)) throw fail('the form needs at least one field it asks');
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
      if (f.format === 'email' && !EMAIL_RE.test(s)) throw new Error('must be an email address');
      if (f.format === 'phone') {
        // stored as +16132220328ext4 (see phone.ts)
        const phone = checkPhone(s);
        if (!phone.valid) throw new Error(`must be a valid phone number (${phone.reason})`);
        return phone.value;
      }
      if (f.format === 'url' && !URL_RE.test(s)) throw new Error('must be a web address starting with http:// or https://');
      if (f.format === 'regex' && f.pattern && !patternRegExp(f.pattern).test(s)) {
        // a custom message is shown as written, not after the label
        throw f.pattern_message ? Object.assign(new Error(f.pattern_message), { whole: true }) : new Error('is not in the expected format');
      }
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
    // from_url fields: whatever the page's URL carried, checked like any answer
    let v: unknown;
    try {
      v = cleanValue(f, given[f.name]);
    } catch (err) {
      const e = err as Error & { whole?: boolean };
      throw badRequest(e.whole ? e.message : `${f.label} ${e.message}`, { field: f.name });
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

// ---- custom HTML -----------------------------------------------------------------

// What custom form HTML may contain: layout, text, images, form controls and
// <style>. No scripts, frames, event handlers or javascript: links. Forms lose
// action/method (the page posts to the API itself).
const HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'form', 'fieldset', 'legend', 'label', 'input', 'select', 'option', 'optgroup', 'textarea', 'button',
    'div', 'span', 'p', 'br', 'hr', 'section', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'small', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'style'
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'title', 'hidden', 'role', 'data-*', 'aria-*'],
    form: ['novalidate'],
    label: ['for'],
    input: ['name', 'type', 'value', 'placeholder', 'required', 'checked', 'min', 'max', 'step', 'minlength', 'maxlength', 'pattern', 'autocomplete', 'size'],
    select: ['name', 'required', 'multiple', 'size'],
    option: ['value', 'selected', 'disabled'],
    textarea: ['name', 'rows', 'cols', 'placeholder', 'required', 'minlength', 'maxlength'],
    button: ['type'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // <style> is wanted (styling is the point); scripts stay out
  allowVulnerableTags: true,
  disallowedTagsMode: 'discard'
};

const MAX_HTML = 200_000;

type El = { name: string; attribs: Record<string, string> };

// Cleans the HTML and checks it against the form: a <form>, a control named
// after every field the form asks (of a kind that fits the field), a
// data-field wrapper for every field with conditions, a submit button, and no
// controls for unknown keys. Returns the cleaned HTML and what is wrong.
export function checkFormHtml(raw: string, def: FormDefinition): { html: string; problems: string[] } {
  const problems: string[] = [];
  if (raw.length > MAX_HTML) return { html: raw, problems: [`the HTML is longer than ${MAX_HTML} characters`] };
  const html = sanitizeHtml(raw, HTML_OPTIONS);
  const doc = parseDocument(html);
  const els = DomUtils.findAll(() => true, doc.children) as unknown as El[];
  const forms = els.filter((e) => e.name === 'form');
  if (forms.length !== 1) problems.push(forms.length ? 'use one <form> element, not several' : 'the HTML needs a <form> element');
  const inForm = forms.length ? (DomUtils.findAll(() => true, (forms[0] as unknown as { children: never[] }).children) as unknown as El[]) : els;

  const controls = inForm.filter((e) => ['input', 'select', 'textarea'].includes(e.name) && e.attribs.name);
  const byName = new Map<string, El[]>();
  for (const c of controls) byName.set(c.attribs.name, [...(byName.get(c.attribs.name) ?? []), c]);
  const type = (e: El) => (e.attribs.type ?? 'text').toLowerCase();

  const known = new Set(def.fields.filter((f) => !f.hidden).map((f) => f.name));
  const unknown = [...byName.keys()].filter((n) => !known.has(n));
  if (unknown.length) problems.push(`controls with names that are not form fields: ${unknown.join(', ')}`);

  const missing: string[] = [];
  for (const f of def.fields) {
    if (f.hidden || f.from_url) continue;
    const found = byName.get(f.name) ?? [];
    if (found.length === 0) {
      missing.push(f.name);
      continue;
    }
    const fits =
      f.type === 'select' ? found.some((e) => e.name === 'select' || type(e) === 'radio')
      : f.type === 'multiselect' ? found.some((e) => (e.name === 'select' && 'multiple' in e.attribs) || type(e) === 'checkbox')
      : f.type === 'checkbox' ? found.some((e) => type(e) === 'checkbox')
      : f.type === 'textarea' ? found.some((e) => e.name === 'textarea' || e.name === 'input')
      : found.some((e) => e.name === 'input' || e.name === 'textarea');
    if (!fits) problems.push(`"${f.name}" (${f.label}) needs a ${f.type === 'select' ? '<select> or radio buttons' : f.type === 'multiselect' ? 'set of checkboxes or a <select multiple>' : f.type === 'checkbox' ? 'checkbox' : '<input> or <textarea>'}`);
    if (f.conditions?.length && !inForm.some((e) => e.attribs['data-field'] === f.name)) {
      problems.push(`"${f.name}" shows only under conditions, so wrap it in an element with data-field="${f.name}"`);
    }
  }
  if (missing.length) problems.push(`no control for these fields: ${missing.join(', ')}`);
  const submit = inForm.some((e) => (e.name === 'button' && (e.attribs.type ?? 'submit').toLowerCase() === 'submit') || (e.name === 'input' && type(e) === 'submit'));
  if (!submit) problems.push('the form needs a submit button');
  return { html, problems };
}

// Every write to a form: when the HTML or the definition changes and the form
// has custom HTML, the HTML must still fit the definition. Stored cleaned.
onWrite('forms', async (_client, input, existing) => {
  const properties = cleanSlug(input);
  if (!('html' in properties) && !('definition' in properties)) return properties;
  const html = 'html' in properties ? properties.html : existing?.html;
  if (typeof html !== 'string' || !html.trim()) return 'html' in properties ? { ...properties, html: null } : properties;
  const rawDef = 'definition' in properties ? properties.definition : existing?.definition;
  if (typeof rawDef !== 'string' || !rawDef.trim()) throw badRequest('add the form fields in the builder before giving the form custom HTML');
  const def = await readDefinition(rawDef, false);
  const checked = checkFormHtml(html, def);
  if (checked.problems.length) {
    const what = 'html' in properties ? 'The HTML does not fit the form' : 'The form\'s custom HTML would no longer fit these fields';
    throw badRequest(`${what}: ${checked.problems.join('; ')}.`, { problems: checked.problems });
  }
  return 'html' in properties ? { ...properties, html: checked.html } : properties;
});
