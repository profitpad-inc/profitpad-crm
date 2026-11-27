import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectDef, PropertyDef } from '../registry.js';
import type { AssociationFilterContext } from '../search.js';
import { compileDefinition, definitionObjects, parseDefinition, type ListCondition, type ListDefinition } from './compile.js';
import { formatSql, renderSql } from './sql.js';

const prop = (api_name: string, type: string, options: Record<string, unknown> = {}): PropertyDef => ({
  api_name, label: api_name, type, options, record_status: 'active', dropdown_options: []
} as unknown as PropertyDef);

const objectOf = (api_name: string, code: string, links: string[], props: PropertyDef[]) => ({
  api_name, label_plural: api_name, object_type_id: code, id_column: `${code}_id`, links_to: links, properties: props,
  byName: new Map(props.map((p) => [p.api_name, p]))
} as unknown as ObjectDef);

const contacts = objectOf('contacts', 'pc_0010', ['deals'], [
  prop('name', 'text'), prop('city', 'text'), prop('updated_at', 'datetime'), prop('created_at', 'datetime'),
  prop('birthday', 'date'), prop('score', 'number'), prop('email', 'email'), prop('stage', 'dropdown', { single_value: true }),
  prop('tags', 'dropdown'), prop('secret', 'text')
]);
const deals = objectOf('deals', 'pc_0012', ['contacts'], [
  prop('name', 'text'), prop('updated_at', 'datetime'), prop('close_date', 'date'), prop('amount', 'number'), prop('created_at', 'datetime')
]);
const ctx: AssociationFilterContext = {
  objects: new Map([['deals', deals]]),
  access: () => 'true',
  isHidden: () => false,
  directions: new Map([['pc_0012', { forward: true, reverse: false }]])
};
const hidden = (p: PropertyDef) => p.api_name === 'secret';

function compile(def: ListDefinition): { sql: string | null; params: unknown[] } {
  const params: unknown[] = [];
  const sql = compileDefinition(contacts, def, params, hidden, 't', ctx);
  return { sql, params };
}
const one = (c: ListCondition) => compile({ match: 'all', groups: [{ conditions: [c] }] });

test('no groups means every record', () => {
  assert.equal(compile({ match: 'all', groups: [] }).sql, null);
});

test('match all ANDs groups and ORs inside; match any is the reverse', () => {
  const groups = [
    { conditions: [{ property: 'city', operator: 'eq', value: 'Paris' }, { property: 'city', operator: 'eq', value: 'Rome' }] },
    { conditions: [{ property: 'score', operator: 'gt', value: 5 }] }
  ];
  assert.equal(compile({ match: 'all', groups }).sql, '((t."city" = $1::text or t."city" = $2::text) and (t."score" > $3::numeric))');
  assert.equal(compile({ match: 'any', groups }).sql, '((t."city" = $1::text and t."city" = $2::text) or (t."score" > $3::numeric))');
});

test('compares two of the record\'s own properties', () => {
  assert.equal(one({ property: 'updated_at', operator: 'gt', compare_to: { property: 'created_at' } }).sql, '((t."updated_at" > t."created_at"))');
  // a date against a datetime: both as times
  assert.equal(one({ property: 'birthday', operator: 'lt', compare_to: { property: 'created_at' } }).sql, '((t."birthday"::timestamptz < t."created_at"))');
  // single dropdowns compare their value, emails their primary address
  assert.equal(one({ property: 'stage', operator: 'eq', compare_to: { property: 'city' } }).sql, '((t."stage"[1] = t."city"))');
  assert.equal(one({ property: 'email', operator: 'neq', compare_to: { property: 'name' }, case_sensitive: false }).sql,
    '((lower((t."email" -> 0 ->> \'value\')) <> lower(t."name")))');
});

test('refuses comparisons that make no sense', () => {
  assert.throws(() => one({ property: 'score', operator: 'gt', compare_to: { property: 'created_at' } }), /can't be compared/);
  assert.throws(() => one({ property: 'city', operator: 'lt', compare_to: { property: 'name' } }), /only with eq or neq/);
  assert.throws(() => one({ property: 'tags', operator: 'eq', compare_to: { property: 'city' } }), /several values/);
  assert.throws(() => one({ property: 'city', operator: 'contains', compare_to: { property: 'name' } }), /eq, neq, lt/);
  assert.throws(() => one({ property: 'secret', operator: 'eq', compare_to: { property: 'name' } }), /unknown property "secret"/);
  assert.throws(() => one({ property: 'city', operator: 'eq', compare_to: { property: 'name', quantifier: 'most' as 'any' } }), /quantifier/);
});

test('compares the record with any of its linked records', () => {
  const { sql, params } = one({ property: 'updated_at', operator: 'gt', compare_to: { property: 'updated_at', association: { object: 'deals' } } });
  assert.equal(sql,
    '((exists (select 1 from crm.pc_0005 al3 join crm."pc_0012" ar3 on ar3."pc_0012_id" = al3.to_id'
    + ' where al3.from_object_type = $1::text and al3.from_id = t."pc_0010_id" and al3.to_object_type = $2::text'
    + ' and ar3.record_status = \'active\' and t."updated_at" > ar3."updated_at")))');
  assert.deepEqual(params, ['pc_0010', 'pc_0012']);
});

test('"all" linked records needs at least one and none failing (an empty value fails)', () => {
  const { sql } = one({ property: 'updated_at', operator: 'gt', compare_to: { property: 'updated_at', association: { object: 'deals' }, quantifier: 'all' } });
  assert.match(sql!, /^\(\(\(exists \(select 1 .*\) and not exists \(select 1 .* and not coalesce\(t\."updated_at" > ar\d+\."updated_at", false\)\)\)\)\)$/);
});

test('linked records against the record, and two properties of the same linked record', () => {
  assert.match(one({ property: 'amount', association: { object: 'deals' }, operator: 'gte', compare_to: { property: 'score' } }).sql!,
    /and ar\d+\."amount" >= t\."score"\)\)\)$/);
  assert.match(one({ property: 'close_date', association: { object: 'deals' }, operator: 'gt', compare_to: { property: 'created_at', association: { object: 'deals' } } }).sql!,
    /and ar(\d+)\."close_date"::timestamptz > ar\1\."created_at"\)\)\)$/);
});

test('reads definitions and the objects they reach', () => {
  assert.deepEqual(parseDefinition(''), { match: 'all', groups: [] });
  assert.deepEqual(parseDefinition('{"groups": []}'), { match: 'all', groups: [] });
  assert.throws(() => parseDefinition('{"match": "some"}'), /"match"/);
  assert.throws(() => parseDefinition('{"groups": [{"conditions": []}]}'), /1 to 20 conditions/);
  assert.throws(() => parseDefinition('nope'), /must be JSON/);
  const def = parseDefinition({ match: 'any', groups: [{ conditions: [
    { property: 'name', operator: 'eq', value: 'x', association: { object: 'companies' } },
    { property: 'updated_at', operator: 'gt', compare_to: { property: 'updated_at', association: { object: 'deals' } } }
  ] }] });
  assert.deepEqual(definitionObjects(def).sort(), ['companies', 'deals']);
});

test('the readable SQL writes values in safely', () => {
  assert.equal(renderSql('a = $1::text and b = any ($2::text[]) and c > $10 and d = $3', ["O'Brien", ['x', "y'z"], 5]),
    "a = 'O''Brien'::text and b = any (ARRAY['x', 'y''z']::text[]) and c > $10 and d = 5");
  assert.equal(renderSql('$1 $2 $3', [null, true, new Date('2026-01-02T03:04:05Z')]), "NULL true '2026-01-02T03:04:05.000Z'");
  assert.equal(formatSql('select t.id from crm.x t where a and ((b) or (c = \'x and y\'))'), 'select t.id\nfrom crm.x t\nwhere a\n  and ((b)\n    or (c = \'x and y\'))');
});

test('list membership: in any of some lists, or none, of the same object only', () => {
  const { sql, params } = one({ property: '__list', operator: 'not_in', values: ['000000000a', '000000000b'] });
  assert.equal(sql, '((not exists (select 1 from meta.list_members lm join crm.pc_0064 l on l.pc_0064_id = lm.list_id'
    + ' where lm.list_id = any ($1::text[]) and l.list_object = $2::text and l.record_status = \'active\' and lm.record_id = t."pc_0010_id")))');
  assert.deepEqual(params, [['000000000a', '000000000b'], 'contacts']);
  // on linked records: the deals' lists
  const linked = one({ property: '__list', operator: 'in', values: ['000000000c'], association: { object: 'deals' } });
  assert.match(linked.sql!, /lm\.record_id = ar\d+\."pc_0012_id"/);
  assert.deepEqual(linked.params.slice(-1), ['deals']);
  assert.throws(() => one({ property: '__list', operator: 'eq', value: 'x' }), /takes in or not_in/);
  assert.throws(() => one({ property: '__list', operator: 'in', values: [] }), /needs values/);
});

test('email campaign activity: did it for some campaigns, any campaign, or lately', () => {
  const opened = one({ property: '__campaign_opened', operator: 'in', values: ['0000000002'] });
  assert.deepEqual(opened.params, [['0000000002']]);
  assert.match(opened.sql!, /o\.contact_id = t\.pc_0010_id and o\.status = 'sent' and o\.campaign_id = any \(\$1::text\[\]\) and e\.first_opened_at is not null/);
  assert.match(opened.sql!, /o\.contact_id = any \(t\.merged_ids\)/);

  const lately = one({ property: '__campaign_clicked', operator: 'last_n_days', value: 30 });
  assert.deepEqual(lately.params, [30]);
  assert.match(lately.sql!, /e\.first_clicked_at >= now\(\) - make_interval\(days => \$1::integer\)/);

  // was sent one of them and never opened any
  const notOpened = one({ property: '__campaign_opened', operator: 'not_in', values: ['0000000002'] }).sql!;
  assert.match(notOpened, /^\(+exists .* and not \(exists .*e\.first_opened_at is not null/);

  // never sent: a plain not
  assert.match(one({ property: '__campaign_sent', operator: 'not_has_property' }).sql!, /^\(+not \(exists/);
});

test('email campaign activity refuses other objects, unknown events and bad values', () => {
  assert.throws(() => one({ property: '__campaign_read', operator: 'has_property' }), /unknown campaign activity/);
  assert.throws(() => one({ property: '__campaign_opened', operator: 'eq', value: 'x' }), /takes in, not_in/);
  assert.throws(() => one({ property: '__campaign_opened', operator: 'in', values: ['nope'] }), /email campaign ids/);
  assert.throws(() => one({ property: '__campaign_opened', operator: 'last_n_days', value: 0 }), /whole number of days/);
  const params: unknown[] = [];
  assert.throws(() => compileDefinition(deals, { match: 'all', groups: [{ conditions: [{ property: '__campaign_opened', operator: 'has_property' }] }] }, params, hidden, 't'),
    /contacts only/);
});
