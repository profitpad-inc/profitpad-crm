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
| `color_display` | `none` / `dot` / `pill` | how choice colours show: none (the default when unset), a large dot left of the label, or a tinted pill around each value. *enforced*: `dot` needs `single_value` (migration 0039) |
| `default_value` | option `api_value` | *enforced*: the value is never empty (deleted records excepted) and new records start with it (column default). Must be one of the options. The UI offers no "None" choice (migration 0029; status on quotes, invoices, forms and booking pages defaults to `draft`) |

Always *enforced*: only known option values, no duplicates, no empty arrays. Archived options stay valid on records that already have them but are refused on new writes.

Each option can have a colour (`color`, lowercase `#rrggbb` or null; migration 0039), set with `meta.set_option_details` or `color` on the option endpoints and MCP option tools. Settings → Properties offers the portal's 16 dropdown colours (set in Settings → Theme) plus a custom colour once the property's Colours setting (`color_display`) is a dot or a pill; record pages and tables then show coloured values that way.

To model a boolean, use a single-value dropdown with options `true` / `false`.

## date / datetime
`datetime` accepts `timezone` (IANA name) as a display option. `date` has no time zone: it is a calendar day.

## calculation
`calc_sql` + `calc_output_type` (`text`, `number`, `date`, `datetime`). Display options: `display`, `format`, `prefix`, `suffix`, `decimals`, `timezone`. Rules in `docs/RULES.md` section 5.

## file
`max_files` (positive integer, *enforced*). Values are ids of `files` records; upload with the file endpoints first, then add the id (see `docs/architecture.md` "File storage"). Only ready files the caller can already open may be added.
