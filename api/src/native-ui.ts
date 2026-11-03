import type { Principal } from './auth.js';
import { propertyAccess } from './auth.js';
import type { ObjectDef, PropertyDef } from './registry.js';
import { tableViews } from './routes/ui.js';

// What the CRM's own pages show for an object, described for the UI and for
// AI view builders (MCP get_object_list_config and get_object_create_form),
// so a custom view can copy the native table and create form.

// Create form: the identifying fields first, then the object's other native
// properties. Objects not listed get name plus their first 6 native properties.
const CREATE_FIELDS: Record<string, string[]> = {
  contacts: ['first_name', 'last_name', 'email', 'phone', 'job_title', 'lifecycle_stage', 'owner'],
  companies: ['name', 'domain', 'industry', 'phone', 'owner'],
  deals: ['name', 'amount', 'currency', 'pipeline', 'stage', 'close_date', 'owner'],
  tasks: ['name', 'task_type', 'status', 'priority', 'due_at', 'owner'],
  users: ['first_name', 'last_name', 'email', 'status'],
  // the builder, the link card and Status on the record page do the rest
  forms: ['name', 'description'],
  // the rest is filled in on the record page; they start as drafts
  quotes: ['name', 'expiration_date'],
  invoices: ['name', 'due_date'],
  // key, lengths and start times are set in the editor; status starts as draft
  booking_pages: ['name', 'description', 'host']
};
// User pickers that start on the signed-in user.
const STARTS_AS_ME = ['owner', 'host'];
// Values every new record of the object starts with, not asked.
const STARTS_WITH: Record<string, Record<string, unknown>> = {
  forms: { status: 'draft' },
  quotes: { status: 'draft' },
  invoices: { status: 'draft' },
  booking_pages: { status: 'draft' }
};

// The same rule as the UI's isEditable, plus the caller's property access.
function editable(pr: PropertyDef, p?: Principal): boolean {
  if (pr.record_status !== 'active' || pr.type === 'calculation' || pr.type === 'file') return false;
  if (p && propertyAccess(p, pr) !== 'full') return false;
  if (pr.is_base) return pr.api_name === 'name';
  return !pr.read_only;
}

// The create form's fields in order, for the UI (api_names) and the MCP.
export function createForm(obj: ObjectDef, p?: Principal) {
  const can = obj.properties.filter((pr) => editable(pr, p));
  const listed = CREATE_FIELDS[obj.api_name];
  const fields = listed
    ? listed.map((n) => can.find((pr) => pr.api_name === n)).filter((pr): pr is PropertyDef => !!pr)
    : [can.find((pr) => pr.api_name === 'name'), ...can.filter((pr) => !pr.is_base).slice(0, 6)].filter((pr): pr is PropertyDef => !!pr);
  return {
    fields: fields.map((pr) => pr.api_name),
    starts_as_me: fields.filter((pr) => STARTS_AS_ME.includes(pr.api_name)).map((pr) => pr.api_name),
    starts_with: STARTS_WITH[obj.api_name] ?? {}
  };
}

const labelOf = (obj: ObjectDef, name: string) => obj.byName.get(name.toLowerCase())?.label ?? name;

// MCP get_object_create_form: the fields with labels and types, and what the
// form does around them.
export function describeCreateForm(obj: ObjectDef, p: Principal) {
  const form = createForm(obj, p);
  const calculatedName = obj.byName.get('name')?.type === 'calculation';
  return {
    object: obj.api_name,
    title: `Create ${obj.label_singular.toLowerCase()}`,
    shown_as: 'a modal: one column of labelled fields in this order, the first focused; Cancel and Create buttons at the bottom right',
    fields: form.fields.map((n) => {
      const pr = obj.byName.get(n)!;
      return { api_name: n, label: pr.label, type: pr.type, ...(pr.options.single_value !== undefined ? { single_value: pr.options.single_value } : {}), ...(form.starts_as_me.includes(n) ? { starts_as: 'the signed-in user' } : {}) };
    }),
    required: [],
    required_note: 'No field is required: the API creates a record with any of them blank. Unique properties (like a page address) are refused when the value is taken.',
    ...(Object.keys(form.starts_with).length ? { starts_with: form.starts_with } : {}),
    ...(calculatedName ? { name_note: 'name is a calculation, so it is not asked: it fills itself once the record is saved (see describe_object for its parts)' } : {}),
    after_create: 'opens the new record page',
    other_properties: 'everything else is edited on the record page'
  };
}

// MCP get_object_list_config: the table views (tabs) of /objects/<object> as
// the caller sees them, with column labels.
export async function listConfig(obj: ObjectDef, p: Principal) {
  const views = (await tableViews(p, obj)) as unknown as {
    id: number; name: string; shared: boolean; columns: { type: string; property?: string; object?: string; label_id?: string | null; width?: number }[]; sorts: unknown;
  }[];
  return {
    object: obj.api_name,
    page: `/objects/${obj.api_name}`,
    title: obj.label_plural,
    default_view: views[0]?.name ?? null,
    views: views.map((v) => ({
      id: v.id,
      name: v.name,
      shared: v.shared,
      columns: v.columns.map((c) =>
        c.type === 'property'
          ? { property: c.property, label: labelOf(obj, c.property!), ...(c.width ? { width: c.width } : {}) }
          : { association: c.object, label_id: c.label_id ?? null, ...(c.width ? { width: c.width } : {}) }
      ),
      sorts: v.sorts
    })),
    filters: 'none saved: table views have columns and sorts only; the page has a search box over the search_properties and an Active / Archived switch',
    search_properties: obj.search_properties,
    table: 'a checkbox column for picking rows (Edit all, Delete all), then the columns; the first column and name link to the record page; editable cells edit in place; Load more under the rows. Widths not given are the table default. People can resize, reorder, add and remove columns and save them to the view'
  };
}
