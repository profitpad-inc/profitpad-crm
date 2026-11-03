# Rules for AI (and humans) changing a ProfitPad CRM tenant

These rules are enforced by the database (`meta.*` functions, constraints, grants), not only by this document. If a rule here and the database disagree, the database wins and this file is wrong.

## 1. Never run DDL directly

- Never `CREATE`, `ALTER` or `DROP` anything in `crm`, `meta`, `reporting` or `auth` by hand.
- All schema changes go through the API (`/v1/schema`, `/v1/schema/{object}/properties`, ...) or the matching `meta.*` function:

| Change | Function |
|---|---|
| New custom object | `meta.create_object(api_name, label_singular, label_plural, description)` |
| Relabel object | `meta.update_object(...)` |
| New property | `meta.create_property(object, api_name, label, type, options, description, dropdown_options, calc_sql, calc_output_type)` |
| Change label/description/options | `meta.update_property(object, api_name, label, description, options)` |
| Change a calculation | `meta.update_calculation(object, api_name, calc_sql, calc_output_type)` |
| Hide / unhide a property | `meta.archive_property` / `meta.unarchive_property` |
| Drop an archived property (destroys data) | `meta.delete_property(object, api_name, confirm => api_name)` |
| Dropdown options | `meta.add_option`, `meta.update_option`, `meta.delete_option` |
| Association label | `meta.create_association_label(from, to, label, inverse_label, is_symmetric, max_to_per_from, max_from_per_to)` |
| Integration table | `meta.create_integration_table(name, columns, primary_key)` |

Every call is logged in `meta.schema_changes` with the actor (`crm.actor`) and the SQL it ran.

## 2. Naming

- Object `api_name`: lowercase letters, digits, underscores; starts with a letter; max 63; not `pc_*`; unique.
- Property `api_name`: letters, digits, dots, underscores; starts with a letter; max 63; unique per object (case-insensitive); immutable.
- Reserved property names: `id`, `object_type_id`, `name`, `created_at`, `updated_at`, `merged_ids`, `merged_into_id`, `record_status`, `created_by`, `updated_by`, anything starting `pc_` or `row_`, anything containing `__` (used for `<name>__label` view columns).
- Labels: any characters (emoji fine), 1 to 63, unique per object (case-insensitive).
- Dropdown option `api_value`: letters, digits, dots, underscores, max 63; label max 63; both unique per property.
- Property names with dots or capitals must be double-quoted in SQL: `select "favorite.color" from reporting.contacts`.

## 3. Object codes

- Native objects: `pc_0000` to `pc_1999` (fixed list, see `docs/architecture.md`).
- Custom objects: `pc_2001` to `pc_2999`, assigned automatically in order.
- The primary key of `crm.pc_0010` is `pc_0010_id`: a 10-character lowercase hex string from a per-object sequence. Ids are never reused (deleted records keep a tombstone row).

## 4. Records

- Archive (`record_status = 'archived'`) is the recycle bin. Archived rows never appear in `reporting.*`.
- Permanent delete (`meta.delete_record`) wipes every value and the record's history; only the id remains. It cannot be undone. Only admin keys may call it.
- Merge (`meta.merge_records(object, winner, loser)`): the winner keeps its values, fills empty ones from the loser, gains the loser's associations; the loser becomes `merged` and points to the winner. Looking up a merged id returns the winner.
- Every insert/update is recorded per property in `meta.record_history` (old value, new value, actor, source).

## 5. Calculations

- One property type covers same-record math and values from associated records.
- Write one SQL expression. The current record is `r`, a row of `crm.<object>` (friendly view: dropdowns unwrapped, `__label` columns available). Example: `coalesce(r.quantity, 0) * coalesce(r.unit_price, 0)`.
- To read other records, join through `crm.associations_both` and read `reporting.<object>` (active rows only) or `crm.<object>`. Example (contact's company domain):

  ```sql
  (select c.domain
   from crm.associations_both a
   join reporting.companies c on c.pc_0011_id = a.other_record_id
   where a.object_type_id = 'pc_0010' and a.record_id = r.pc_0010_id
     and a.other_object_type_id = 'pc_0011'
   order by c.pc_0011_id limit 1)
  ```
- Output type is `text`, `number`, `date` or `datetime`. The expression must return exactly one value per record (use `limit 1` or an aggregate inside a subquery).
- Rejected automatically: semicolons, comments, `$`, `E''` strings, unbalanced quotes or parentheses; reading anything outside `crm`, `reporting`, `integrations`; dangerous functions (`pg_sleep`, `set_config`, `query_to_xml`, `ts_stat`, `nextval`, advisory locks, file and large-object functions, ...); circular references; taking more than 1 second on any of 10 sampled records; failing on any sampled record.
- Values are stored in a real column and refreshed by `meta.calc_queue`: the record itself and records one association away are queued when something they read changes. The API worker drains the queue every 2 seconds and right after each write. Chains deeper than one association are caught by `select meta.enqueue_calcs();` (schedule nightly, e.g. from n8n).
- To try an expression before saving it, `POST /v1/schema/{object}/calculations/test` with `calc_sql`, `calc_output_type` and `record_id` (or `meta.test_calculation(object, calc_sql, output_type, record_id)`). It runs the same checks as saving, returns the value for that record, and saves nothing.
- A calculation that later fails at runtime keeps its last value; the error is in `meta.pc_0002.calc_last_error` (also on `GET /v1/schema/{object}/properties/{property}`).

## 6. Reporting (read-only AI)

- Log in as `reporting_reader` (member of `test_crm_reader`). It can read the `reporting` and `integrations` schemas only, with a 60 second statement timeout and read-only transactions.
- Use `reporting.<object>` views (active rows only, single dropdowns as text, `<property>__label` columns), `reporting.associations`, `reporting.properties`, `reporting.property_options`, `reporting.objects`.
- Saved report views or helper tables built on top of `reporting.*` block property archiving/retyping (the database refuses with a dependency error). Remove or update them first.

## 6a. Custom view queries

- Written in a view's `queries` (or tried with `POST /v1/views/try-query`); checked by `meta.analyze_view_query` on every save.
- One SELECT (or WITH ... SELECT). Only `view_data.*` (unqualified names resolve there). Same text rules and function denylist as calculations. Params are `:name`, declared with a type; `:me` is the viewer.
- They run as `test_crm_view_reader`: read-only, 10 seconds, at most 5000 rows, filtered by row-level security to the viewer's records. Never `select *`: a viewer whose roles hide a property gets a 403 for any query that reads it.
- Never add amounts in different currencies together.

## 7. Before anything destructive

- Take a backup: `pg_dump -h localhost -p 5433 -U claude_admin -d test_crm -Fc -f backups/test_crm_$(date +%Y%m%d_%H%M%S).dump`
- Ask a human first. Destructive means: `delete_property`, `delete_option`, `delete_record`, dropping integration tables, anything that removes data.

## 8. Testing

- `./db/test-local.sh` runs the SQL suite on a throwaway local cluster. Never run `db/tests/*.sql` against a real tenant: tests consume record IDs.
