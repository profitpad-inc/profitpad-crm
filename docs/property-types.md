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

Empty string and `null` both clear a value.

## text
| Option | Type | Effect |
|---|---|---|
| `single_line` | boolean | *enforced*: no newlines |
| `display` | `plain` `url` `markdown` `json` `html` | display only |
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
| `single_value` | boolean | *enforced*: at most one value. Switching on fails (listing record ids) if any record has more than one. Switching is instant either way: storage is always `text[]` |
| `allow_user_add` | boolean | API writes may introduce new values (created with label = api_value) |
| `allow_form_add` | boolean | reserved for forms |
| `auto_append_users` | boolean | every active user becomes an option (`api_value` = user id, label = user name) |

Always *enforced*: only known option values, no duplicates, no empty arrays. Archived options stay valid on records that already have them but are refused on new writes.

To model a boolean, use a single-value dropdown with options `true` / `false`.

## date / datetime
`datetime` accepts `timezone` (IANA name) as a display option. `date` has no time zone: it is a calendar day.

## calculation
`calc_sql` + `calc_output_type` (`text`, `number`, `date`, `datetime`). Display options: `display`, `format`, `prefix`, `suffix`, `decimals`, `timezone`. Rules in `docs/RULES.md` section 5.

## file
`max_files` (positive integer, *enforced*). File storage itself is not built yet.
