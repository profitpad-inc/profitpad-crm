# Property types

Each property is a real, typed column on `crm.<object code>`. Options are stored in `meta.pc_0002.options`; options marked *enforced* become CHECK constraints or indexes (named `pcc_<property id>_*` / `pci_<property id>_*`), so they apply to every writer, not just the API.

| Type | Column | API value |
|---|---|---|
| `text` | `text` | string |
| `number` | `numeric` | number (numeric strings accepted on input) |
| `dropdown` | `text[]` | single value: string; multi: array of strings (`"a;b"` also accepted) |
| `date` | `date` | `"2000-01-31"` (also accepts `"2000-01-31T00:00:00.000Z"`) |
| `datetime` | `timestamptz` | ISO 8601, returned as `"2000-01-31T13:45:00.000Z"` (UTC) |
| `calculation` | per `calc_output_type` | read-only |
| `file` | `text[]` of `pc_0050` ids | array of 10-char hex ids |
| `actor` | `text` | read-only, base only: `user:<user id>`, `api:<key prefix>`, `system:<process>` or `public` |
| `email` | `jsonb` | list: `[{"value": "jane@acme.com", "label": "work"}, ...]`, the first is the primary |
| `phone` | `jsonb` | list: `[{"value": "+18882345678ext9", "label": "cell"}, ...]`, the first is the primary |

Empty string and `null` both clear a value.

## text
| Option | Type | Effect |
|---|---|---|
| `single_line` | boolean | *enforced*: no newlines |
| `display` | `plain` `url` `markdown` `json` `html` `code` `button` | display only (`code`: a grey monospace box on record pages, migration 0079; `button`: a link value (http, https, mailto, tel) shown as a button that opens it, other values as text, migration 0113). `phone` was retired by migration 0129: phone numbers are the `phone` type |
| `regex` | string | *enforced* when `regex_scope` is `all` (default) |
| `regex_scope` | `all` `ui` | `ui`: only the UI checks it, API and imports are free |
| `json_only` | boolean | *enforced*: must parse as JSON |
| `unique` | boolean | *enforced*: unique index across active and archived records |
| `case_insensitive` | boolean | with `unique`, compares lowercase |

## number
| Option | Type | Effect |
|---|---|---|
| `min`, `max` | number | *enforced* |
| `decimals` | 0 to 10 | *enforced*: value must already be rounded |
| `format` | `formatted` `unformatted` `currency` `percentage` | display only |
| `prefix`, `suffix` | string | display only |
| `currency_code` | ISO code in `meta.pc_0007` | display only, fixed currency |
| `currency_property` | property api_name | display only, currency read from that property |

## dropdown
Values are `api_value`s; labels live in `meta.pc_0003` and are looked up at read time (`<name>__label` in views).

| Option | Type | Effect |
|---|---|---|
| `single_value` | boolean | *enforced*: at most one value. Switching on fails (listing record IDs) if any record has more than one. Switching is instant either way: storage is always `text[]` |
| `allow_user_add` | boolean | API writes may introduce new values (created with label = api_value; on a dropdown that shares an option list, the new value reaches every dropdown on the list) |
| `allow_form_add` | boolean | reserved for forms |
| `auto_append_users` | boolean | every active user becomes an option (`api_value` = user id, label = user name). A user who is archived, deactivated, merged or deleted has their option archived, and it comes back if they return (migration 0050) |
| `button_label` | string, at most 63 | the button's text for display `button` (the property's label when unset). *enforced*: only with display `button` (migration 0113) |
| `color_display` | `none` / `dot` / `pill` | how choice colours show: none (the default when unset), a large dot left of the label, or a tinted pill around each value. *enforced*: `dot` needs `single_value` (migration 0039) |
| `default_value` | option `api_value` | *enforced*: the value is never empty (deleted records excepted) and new records start with it (column default). Must be one of the options. The UI offers no "None" choice (migration 0029; status on quotes, invoices, forms and booking pages defaults to `draft`; users' status defaults to `active`, migration 0072) |

Always *enforced*: only known option values, no duplicates, no empty arrays. Archived options stay valid values: records keep them and API writes may still set them, but the UI no longer offers them (a picker keeps the value a record already has).

Each option can have a colour (`color`, lowercase `#rrggbb` or null; migration 0039), set with `meta.set_option_details` or `color` on the option endpoints and MCP option tools. Settings → Properties offers the portal's 16 dropdown colours (set in Settings → Theme) plus a custom colour once the property's Colours setting (`color_display`) is a dot or a pill; record pages and tables then show coloured values that way.

To model a boolean, use a single-value dropdown with options `true` / `false`.

## date / datetime
`datetime` accepts `timezone` (IANA name) as a display option. `date` has no time zone: it is a calendar day.

## calculation
`calc_sql` + `calc_output_type` (`text`, `number`, `date`, `datetime`). Display options: `display` (text results may use `button`), `button_label`, `format`, `prefix`, `suffix`, `decimals`, `timezone`, `currency_code` (migration 0070). A calculation may call `currency_to_base(amount, currency, on_date)` to convert money to the base currency; every calculation that does is re-queued when rates change, and its `currency_code` is set to the new base when the base changes. The built-in `amount_base` ("Amount in base currency") on deals, quotes, invoices, orders and carts is one. Rules in `docs/RULES.md` section 5.

## file
`max_files` (positive integer, *enforced*). Values are ids of `files` records; upload with the file endpoints first, then add the id (see `docs/architecture.md` "File storage"). Only ready files the caller can already open may be added.

## email / phone
Migration 0129. A record can have several email addresses or phone numbers, each with an optional label. The column is `jsonb`, a list of entries `{"value": ..., "label": ...}`; the first entry is the **primary** (the CRM sends to it, merge tags and the generated views show it). An empty list is stored as `null`.

- **Values:** emails are stored lowercase and must look like an address; phones are checked with Google's libphonenumber by the API and stored as E.164 plus `ext` (`+18882345678ext9`). No value appears twice in one list.
- **Labels:** optional, at most 40 characters. Presets are stored as keys (email: `work`, `personal`; phone: `cell`, `landline`, `work`); anything else is custom text, kept as typed.
- **Writing through the API:** a list (of entries or plain strings) replaces the whole list. A plain string adds its value(s) at the top (the first becomes the primary) and leaves values the record already has where they are, so forms, imports, integrations and custom views that write one address never drop the others. `null`, `""` or `[]` clears it. Imports split a cell on `;` (emails also on `,` and spaces).
- **Reading through the API:** always the list.

| Option | Type | Effect |
|---|---|---|
| `unique` | boolean | *enforced*: no two active or archived records share any value, primary or not (`crm.unique_values`, kept by trigger `pcu_<property id>`). Contacts' and users' Email are unique |

*Enforced* always: `pcc_<id>_shape` (`meta.is_multi_value`), and a GIN index `pci_<id>_gin` (`jsonb_path_ops`).

- **Generated views** (`crm.<object>`, `reporting.*`, `view_data.*`, calculations): `<name>` is the primary value as text; `<name>__all` is the whole list. So report SQL and custom views reading `email` or `phone` see one address or number, as before.
- **Filters:** any entry matches. `eq`/`in` compare whole values (emails ignoring case), `contains`/`starts_with` use `ilike`, and for phones also the digits ("555 0100" finds `+15550100`). Sorting uses the primary. Search properties may be email or phone.
- **Merges** combine the lists: the winner's entries, then the loser's new ones.
- `meta.primary_value(jsonb)` returns the primary value for SQL on the raw tables.
- `meta.convert_to_multi(property_id, 'email'|'phone', extra_property_id)` turns a text property into a list (each value one entry with no label; with an extra property, its addresses are appended and it is deleted). Migration 0129 used it for contacts' Email (folding in Additional emails), users' Email and every text property shown as a phone.

## actor
Only the base properties `created_by` and `updated_by` (migration 0049), stamped by `tg_object_before_write` from `crm.actor`; nobody can create or write one. Filter and sort like text (`eq`, `in`, `has_property` and so on). The schema endpoint lists every user (active and archived) as the property's `dropdown_options` (`user:<id>` with the user's name), so the UI shows names and filters offer users; other actors show as API key, system or public page (`actorLabel` in `web/src/lib/display.tsx`).
