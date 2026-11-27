import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectDef, PropertyDef } from './registry.js';
import { compileFilterGroups, compileSearch, type AssociationFilterContext, type Filter } from './search.js';

const prop = (api_name: string, type: string): PropertyDef => ({
  api_name, label: api_name, type, options: {}, record_status: 'active', dropdown_options: []
} as unknown as PropertyDef);

const props = [prop('name', 'text'), prop('amount', 'number'), prop('close_date', 'date'), prop('created_at', 'datetime')];
const obj = { api_name: 'deals', object_type_id: 'pc_0100', id_column: 'pc_0100_id', links_to: ['companies'], properties: props, byName: new Map(props.map((p) => [p.api_name, p])) } as unknown as ObjectDef;

function compile(f: Filter): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const sql = compileFilterGroups(obj, [{ filters: [f] }], params, () => false)!;
  return { sql, params };
}

test('text equality ignores case only when case_sensitive is false', () => {
  assert.deepEqual(compile({ property: 'name', operator: 'in', values: ['Acme', 'GLOBEX'], case_sensitive: false }),
    { sql: '((lower(t."name") = any ($1::text[])))', params: [['acme', 'globex']] });
  assert.deepEqual(compile({ property: 'name', operator: 'in', values: ['Acme'], case_sensitive: true }),
    { sql: '((t."name" = any ($1::text[])))', params: [['Acme']] });
  // omitted: exact, as before
  assert.equal(compile({ property: 'name', operator: 'eq', value: 'Acme' }).sql, '((t."name" = $1::text))');
});

test('contains, starts_with and ends_with ignore case unless case_sensitive is true', () => {
  assert.deepEqual(compile({ property: 'name', operator: 'contains', value: '50%' }),
    { sql: '((t."name" ilike $1::text))', params: ['%50\\%%'] });
  assert.deepEqual(compile({ property: 'name', operator: 'ends_with', value: 'Inc', case_sensitive: true }),
    { sql: '((t."name" like $1::text))', params: ['%Inc'] });
  assert.equal(compile({ property: 'name', operator: 'not_contains', value: 'x', case_sensitive: true }).sql,
    '((coalesce(t."name" not like $1::text, true)))');
});

test('relative date operators take a whole number of days', () => {
  assert.deepEqual(compile({ property: 'close_date', operator: 'last_n_days', value: 7 }),
    { sql: '((t."close_date" between current_date - $1::integer and current_date))', params: [7] });
  assert.equal(compile({ property: 'created_at', operator: 'more_than_n_days_ago', value: 30 }).sql,
    '((t."created_at" < now() - make_interval(days => $1::integer)))');
  assert.throws(() => compile({ property: 'close_date', operator: 'next_n_days', value: 1.5 }), /whole number of days/);
  assert.throws(() => compile({ property: 'amount', operator: 'last_n_days', value: 3 }), /only applies to date/);
});

const companyProps = [prop('country', 'text'), prop('secret', 'text')];
const companies = {
  api_name: 'companies', label_plural: 'Companies', object_type_id: 'pc_0101', id_column: 'pc_0101_id', links_to: ['deals'], properties: companyProps,
  byName: new Map(companyProps.map((p) => [p.api_name, p]))
} as unknown as ObjectDef;
const ctx: AssociationFilterContext = {
  objects: new Map([['companies', companies]]),
  access: (_o, alias) => `${alias}.owner_ok`,
  isHidden: (p) => p.api_name === 'secret'
};

test('a filter on associated records is an exists over the links, with access and the other object\'s property', () => {
  const params: unknown[] = [];
  const sql = compileFilterGroups(obj, [{ filters: [{ property: 'country', operator: 'in', values: ['CA'], association: { object: 'companies', label_id: 'L1' } }] }], params, () => false, 't', ctx)!;
  assert.equal(sql, '((exists (select 1 from crm.associations_both al1 join crm."pc_0101" ar1 on ar1."pc_0101_id" = al1.other_record_id'
    + ' where al1.object_type_id = $1::text and al1.record_id = t."pc_0100_id" and al1.other_object_type_id = $2::text and al1.label_id = $3::text'
    + ' and ar1.record_status = \'active\' and ar1.owner_ok and ar1."country" = any ($4::text[]))))');
  assert.deepEqual(params, ['pc_0100', 'pc_0101', 'L1', ['CA']]);
});

test('association filters are refused without a context, on unlinkable objects and on hidden properties', () => {
  const f: Filter = { property: 'country', operator: 'has_property', association: { object: 'companies' } };
  assert.throws(() => compileFilterGroups(obj, [{ filters: [f] }], [], () => false), /not supported here/);
  assert.throws(() => compileFilterGroups(obj, [{ filters: [{ ...f, association: { object: 'tickets' } }] }], [], () => false, 't', ctx), /cannot be associated/);
  assert.throws(() => compileFilterGroups(obj, [{ filters: [{ ...f, property: 'secret' }] }], [], () => false, 't', ctx), /unknown property "secret"/);
});

test('property __count on an association filters on how many linked records there are', () => {
  const run = (f: Filter) => {
    const params: unknown[] = [];
    return { sql: compileFilterGroups(obj, [{ filters: [f] }], params, () => false, 't', ctx)!, params };
  };
  const linked = 'from crm.associations_both al1 join crm."pc_0101" ar1 on ar1."pc_0101_id" = al1.other_record_id'
    + ' where al1.object_type_id = $1::text and al1.record_id = t."pc_0100_id" and al1.other_object_type_id = $2::text'
    + ' and ar1.record_status = \'active\' and ar1.owner_ok';
  assert.equal(run({ property: '__count', operator: 'not_has_property', association: { object: 'companies' } }).sql, `((not exists (select 1 ${linked})))`);
  assert.deepEqual(run({ property: '__count', operator: 'gte', value: 2, association: { object: 'companies' } }),
    { sql: `(((select count(distinct ar1."pc_0101_id") ${linked}) >= $3::integer))`, params: ['pc_0100', 'pc_0101', 2] });
  assert.throws(() => run({ property: '__count', operator: 'contains', value: 'x', association: { object: 'companies' } }), /does not apply/);
  assert.throws(() => run({ property: '__count', operator: 'eq', value: -1, association: { object: 'companies' } }), /whole number/);
});

const contactProps = [prop('name', 'text'), prop('first_name', 'text'), prop('last_name', 'text'), prop('email', 'email'), prop('phone', 'phone'),
  prop('created_at', 'datetime'), prop('updated_at', 'datetime')];
const contacts = (built: string[] | null) => ({
  api_name: 'contacts', object_type_id: 'pc_0010', id_column: 'pc_0010_id', links_to: [], properties: contactProps,
  byName: new Map(contactProps.map((p) => [p.api_name, p])),
  search_properties: ['name', 'first_name', 'last_name', 'email', 'phone'], search_text_properties: built
} as unknown as ObjectDef);
const all = ['name', 'first_name', 'last_name', 'email', 'phone'];

test('search uses the row_search_text column when it holds every searched property', () => {
  const params: unknown[] = [];
  const q = compileSearch(contacts(all), { query: 'Smith' }, params, () => false);
  assert.match(q.where, /^t\.record_status = \$1 and t\.row_search_text ilike \$2$/);
  assert.deepEqual(params, ['active', '%Smith%']);
  // phone digits are matched too
  const p2: unknown[] = [];
  const q2 = compileSearch(contacts(all), { query: '(613) 555' }, p2, () => false);
  assert.match(q2.where, /\(t\.row_search_text ilike \$2 or t\.row_search_text like \$3\)/);
  assert.deepEqual(p2, ['active', '%(613) 555%', '%613555%']);
});

test('search matches each property when the column is missing, stale or holds a hidden property', () => {
  for (const [built, hidden] of [[null, ''], [['name', 'email'], ''], [all, 'email']] as const) {
    const params: unknown[] = [];
    const q = compileSearch(contacts(built as string[] | null), { query: 'smith' }, params, (p) => p.api_name === hidden);
    assert.doesNotMatch(q.where, /row_search_text/);
    assert.match(q.where, /t\."name" ilike \$2/);
    assert.equal(q.where.includes('t."email"'), hidden !== 'email');
  }
});

test('created_at, updated_at and the record id sort without nulls last, so their indexes serve the sort', () => {
  const order = (property: string, direction: 'asc' | 'desc') =>
    compileSearch(contacts(all), { sorts: [{ property, direction }] }, [], () => false).orderBy;
  assert.equal(order('created_at', 'desc'), 't."created_at" desc, t."pc_0010_id" asc');
  assert.equal(order('updated_at', 'desc'), 't."row_updated_at" desc, t."pc_0010_id" asc');
  assert.equal(order('name', 'desc'), 't."name" desc nulls last, t."pc_0010_id" asc');
  assert.equal(order('email', 'asc'), '(t."email" -> 0 ->> \'value\') asc nulls last, t."pc_0010_id" asc');
});
