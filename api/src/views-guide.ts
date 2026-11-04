import { pool } from './db.js';
import { getRegistry, isSingleValue, type ObjectDef, type PropertyDef } from './registry.js';
import { propertyAccess, type Principal } from './auth.js';
import { MAX_QUERIES, MAX_SOURCE, PARAM_TYPES, ROW_CAP, VIEW_MODULES, parseQueries } from './views.js';

// The guide the MCP server's view_guide tool returns (mcp.ts): everything an
// AI needs to build a custom view. The runtime it describes is
// web/src/view-runtime (kit.tsx); keep the two in step.

export const GUIDE_TOPICS = ['overview', 'runtime', 'ui_kit', 'styling', 'design', 'sql', 'schema', 'properties', 'integrations', 'examples', 'document_templates'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

const DOCUMENT_TEMPLATES = `# Document templates

A document template draws a record as a document: the customer's quote page and its PDF. Templates are records of the object "document_templates" (Settings shows them under /objects/document_templates). Each one is for one object type ("object": quotes for now) and is an HTML page with Liquid tags (liquidjs, like Shopify/HubSpot HubL), filled in on the server. Output is HTML-escaped by default; use | raw only on text you built yourself (for example after | escape | newline_to_br | raw). Documents are not interactive, so there is no React here: compute everything in Liquid.

The result is one static HTML page. The customer sees it in a sandboxed iframe (no scripts run), and the PDF is that page printed by Chromium with scripts off, so they look the same. Write a whole page (<!doctype html>, <style> in the head) sized for paper: for US Letter, 8.5in wide. Use @media print for PDF-only changes (no drop shadows, no grey backdrop) and @page { size: letter; margin: 0 } when the page draws its own margins. page_size, orientation and page_margin on the template are the PDF defaults; a CSS @page rule wins. <script> never runs: compute values with Liquid instead.

## Which template a record uses
The template linked to the record (association; a quote links to at most one), else the published template marked default for that object, else the CRM's built-in layout. Only published templates are used for customers; set_default_document_template picks the default.

## data (see it with get_document_template_data)
- record, and the same object under the singular name (quote): every property by api_name (a single-value dropdown as its value, numbers as numbers, dates YYYY-MM-DD, times ISO), id, and _text: each property as the CRM shows it (dropdown labels, money, long dates). public_key and customer_ip are never included.
- lines: the line items, oldest first. company, contact, deal: the first linked one (or null). linked: every linked record by object api name (linked.companies, linked.products ...).
- queries: the template's data sources by name. SQL sources run read-only over view_data like view queries (view_guide topic sql) with :record_id bound to the record; their rows are lists. Integration sources ({"integration": "key", "data": {...}}) call an enabled view integration while drawing; string values in data may hold Liquid ({{ quote.name }}), and the answer's data is queries.<name>.
- org: {logo (data URL or null), theme}. today (YYYY-MM-DD), now (ISO, UTC).

## Images, barcodes, fonts
Outside images (https) and web fonts in url(...) are downloaded by the server and written into the page, so they show in the PDF too (3 MB each). Barcodes need no outside service: in Liquid {{ quote.name | barcode }} (Code 128; | barcode: "code39", 12 for type and height in mm) or {{ quote.name | qrcode }}; or anywhere (an <img> or CSS url) the address https://barcode.invalid/<type>?text=<text>&height=<mm> (code128, code39, ean13, upca, qrcode, datamatrix, pdf417 and the other bwip-js types). Linear barcodes stretch to the size CSS gives them.

## Liquid filters beyond the standard ones
money: currency ("$1,240.00"), number: decimals ("1,240.5"), fixed: decimals ("15895.500", no separators, like printed forms), barcode, qrcode, zone_abbr: "America/Chicago" (CST/CDT at that moment), and date with a time zone: {{ now | date: "%m/%d/%Y %I:%M %p", "America/Chicago" }}. sum, map, where, default and the rest of liquidjs work as usual.

## How to build one (or copy an existing document exactly)
1. get_document_template_data for a real record: learn what is there. Missing fields need properties (create_property) or a SQL source.
2. To copy an existing page, start from its own HTML and CSS: keep the CSS as it is and put Liquid where the values are. Watch for inherited styles from stylesheets the page loads (a theme's line-height changes every box height).
3. create_document_template (draft), then render_document_template after each change: it returns a screenshot of the page at paper width, the PDF's page count and warnings (failed queries, images that did not load). Compare with the target until they match. save_document_template_draft takes edits (find and replace) like save_view_draft.
4. Ask the user before publish_document_template and set_default_document_template: published templates go to customers.`;

const OVERVIEW = `# Custom views

A custom view is a page in the CRM built from React (TSX) plus named, read-only SQL queries. It lives in the database (object "views"), so creating or changing one needs no deploy. People open it at /view/#<slug>; admins see every view and its code under /objects/views.

## How to build one
1. Read the other topics you need: runtime, ui_kit, styling, design (how to lay out a good view, and the review before handing it over), sql (always), schema (the data), examples (finished views to copy from).
2. Look at existing views with list_views and get_view; match their structure and look.
3. Learn the data: view_guide topic "schema" (optionally for one object), or describe_object.
4. Write and test each query with try_view_query until it returns what you expect.
5. create_view (new) or save_view_draft (change) with the code and queries. Both compile the code and check every query, and refuse with a precise error if something is wrong: fix it and save again. For changes, send save_view_draft edits (find and replace: [{"old_str", "new_str"}], each old_str matching exactly one place) instead of the whole source, and set_queries / remove_queries for single queries. Saves answer with a short summary, including publish_state (whether the published version is behind the draft, and by how many saves; someone may publish from the CRM while you work). get_view shows the current draft code; to find old_str without reading all of it, use get_view with search (matching lines with context) or lines [start, end].
6. run_view_query runs a saved draft query. Then give the user the draft_url from create_view / save_view_draft (/view/?draft=1#<slug>) so they can preview it, and ask whether to publish.
6b. render_view draws the draft in a headless browser as you and returns a screenshot and a report: element boxes (with text_cut, overflow and off_right flagged), console errors and failed queries. Check every change with it (also at width 390 for phones, and scrolled with scroll_y for sticky headers) before giving the user the draft_url, so they see a view that already looks right. It can click and type (steps found by text or CSS selector) before the screenshot, runs in the time zone of the person viewing (default: yours; pass timezone to check another), and refuses record changes and uploads (it shows real files, read as you). Outside links (openUrl, ExternalLink) open nothing; a clicked one shows its address in the report's navigations. Integration calls are refused unless you give integration_answers (canned answers, nothing sent) or call_integrations (really called); the report's integration_calls shows the data each call sent.
7. After the user has opened the draft, get_view_runtime_errors lists what went wrong in their browser since the last save: crashes, uncaught errors, console errors and failed queries, with the frame width. Check it after every change the user tries; no errors listed only means nothing failed while someone had it open.
8. publish_view only when the user says to publish. Never publish on your own, even for a small change: publishing replaces what everyone sees. Drafts never affect the published version.
9. Give the view an icon for menus: a Lucide icon name (lucide.dev/icons) such as chart-column, set with create_view or update_view_settings. find_icons searches the names. Admins can also pick one on the view's page.
10. To put a view in the sidebar, the admin adds a "Custom view" item in Settings, Navigation.

## What views can and cannot do
- Read data only through the view's own queries (SQL over the view_data schema). Every query runs as the person viewing, with row-level security: they only ever see records their roles let them see, and a query that reads a property their roles hide is refused for them.
- Change data only through the record actions in @pcrm/view (createRecord, updateRecord, linkRecords), which use the viewer's own permissions.
- Upload files and set file properties (uploadFile or <FileInput>, then the ids in createRecord / updateRecord), and show or open files the viewer can open (useFileUrl, <FileImage>, openFile). Topic runtime, "Files".
- Talk to outside services (an n8n webhook that posts to Slack, say) only through integrations an admin set up: callIntegration(key, data) (topic "integrations", list_view_integrations).
- Link to outside web pages (SAM.gov, a partner's site) only with <ExternalLink href> or openUrl(url) (or a plain <a href="https://...">, which the frame hands to openUrl): they open in a new tab, http and https only, and the viewer is asked to confirm the domain unless they said not to ask again for it.
- No direct network access (fetch, XHR, websockets, external scripts, images, fonts or stylesheets are all blocked; images must be data: or blob: URLs, or SVG drawn in JSX), and a view that navigates its own frame to another page is stopped, no imports besides ${VIEW_MODULES.filter((m) => m !== 'react/jsx-runtime').join(', ')}, no localStorage or cookies (the view runs in a sandboxed frame with no origin of its own). Keep state in React or in the address params (useParams / setParams).
- Views cannot create objects. Properties and dropdown options can be created, relabeled and archived with the property tools (topic "properties"), but always ask the admin before changing the CRM's setup. Nothing can be deleted through these tools; deletes are done by an admin in the CRM.
- Audience: "admins" (default) or "everyone". Even with "everyone", people only see rows their roles allow.

## Limits
Code up to ${MAX_SOURCE} characters, up to ${MAX_QUERIES} queries per view, ${ROW_CAP} rows per query (the result says truncated: true beyond that), 10 seconds per query.`;

const RUNTIME = `# Runtime

The code is one TSX module. It must \`export default\` the page component. JSX needs no React import. TypeScript is allowed (types are stripped, not checked).

Allowed imports:
- react (hooks: useState, useMemo, useEffect, ...)
- @pcrm/view (data hooks, actions, UI pieces, formatters; see topic ui_kit)
- recharts (charts, version 3)

Anything else fails to save.

## Data hooks (from @pcrm/view)
- useQuery(name, params?, { enabled? }) returns { data, columns, loading, error, truncated, refresh }.
  - data is an array of row objects (column name to value). Starts as [] while loading.
  - Re-runs when name or params change. { enabled: false } waits, for example until a row is picked.
  - Numbers (count, sum, numeric columns) arrive as JS numbers; dates as "YYYY-MM-DD"; datetimes as ISO strings; dropdowns as their api_value (single) or arrays (multi).
  - params must match the query's declared params (names and types); unknown params are refused. Missing params are null.
- useParams() returns the address params: /view/#my-view?stage=won gives { stage: 'won' } (strings).
- useMe() returns { id, name, is_admin } of the viewer.
- useViewport() returns { scrollTop, viewportHeight }: how many pixels of the view are scrolled out of sight above, and how tall the visible area is. Visible part of the view: scrollTop to scrollTop + viewportHeight. Use it for infinite scroll (load more when scrollTop + viewportHeight nears the bottom) or anything that depends on what is on screen.
- useDebounced(value, ms = 300) returns value once it has stopped changing for ms (search boxes).
- useView() returns { id, name, slug, draft }.

## Actions (from @pcrm/view, all return promises)
- openRecord(object, id): opens a record page in the CRM, e.g. openRecord('deals', row.id).
- navigate(path): goes to a CRM path, e.g. '/objects/contacts' or '/view/#other-view'.
- openUrl(url): opens a web page outside the CRM in a new tab, e.g. openUrl('https://sam.gov/opp/' + row.notice_id + '/view'). Only full http:// and https:// addresses; anything else (javascript:, data:, mailto:, relative paths, addresses with a user name or password) rejects with an Error. The CRM shows "You're leaving the CRM for <domain>" with the full address, unless the viewer ticked "Don't ask again" for that domain before. Resolves with { opened: true } or { opened: false } (the viewer cancelled). Call it only from a click or tap, never on load or after an await: browsers, phones above all, open tabs only straight from the viewer's tap, so a call without one always shows the confirmation. Prefer <ExternalLink> for links. For CRM pages use navigate or openRecord instead.
- setParams({ key: value }): merges into the address params (undefined or '' removes one). Use it for filters, tabs and the selected item (a picked row, an open detail panel: setParams({ page: row.id })) rather than React state, so links, refreshes and the back button keep them, and render_view can draw that state with params.
- createRecord(object, properties, associations?), updateRecord(object, id, properties), linkRecords(object, id, toObject, toId): change data with the viewer's permissions. The first time a view changes data, the CRM asks the viewer to allow it; one yes allows that view's changes for everyone from then on (anyone's "Don't allow" refuses only that change). Still call these only from something the viewer clicked, never on load. Property values follow the CRM API (dropdowns take api_values). They reject with an Error whose message explains why (including "The viewer did not allow this change"); show it. Call refresh() on the affected queries afterwards.
- uploadFile, getFiles, getFileBlob, openFile: files, below.
- callIntegration(key, data?): sends data to an outside service an admin set up (topic "integrations"). Resolves with { status, data } (the service's answer, parsed when it is JSON). The viewer is not asked: an admin enabling the integration is the approval. Call it only from what the viewer clicks or types, never on load.

## Files
File properties (type file in describe_object, with max_files when limited) hold an array of file ids, like ["0a1b2c3d4e"]; in queries they are text[] columns. The frame has no network, so the CRM page uploads and reads files for the view, as the viewer.
- uploadFile(fileOrBlob, nameOrOptions?) uploads a File (from <FileInput onFiles>, an <input type="file">, a drop) or a Blob you made (a canvas photo: canvas.toBlob) and resolves with { id, name, mime_type, size_bytes } once it is stored. The second argument is the name (default: the File's own name), or { name?, object?, id?, property?, onProgress?: (fraction) => void }. It is a change like createRecord: the first one asks the viewer to allow the view's changes. Uploading needs Create on files, or, with object, id and property, edit access to that record's file property (and room under max_files): pass them when adding files to an existing record, so people without Create on files can too.
- To attach: createRecord('expenses', { name, receipt: [file.id] }) or updateRecord(object, id, { photos: [...current, file.id] }). The value replaces the property's list, so add to the ids it already has (select the column in a query) and leave out an id to remove that file. At most max_files ids (refused with a message above it). Each new id must be a finished upload the viewer can open, so a view cannot attach someone else's file it was never shown.
- getFiles(ids) resolves with { id, name, mime_type, size_bytes } for the files the viewer can open (others are left out, up to 100): names for a file list.
- useFileUrl(id) returns { url, type, loading, error }: a blob: URL of the file's bytes for <img src>, <video src> or <iframe src> (a PDF), revoked when the component goes away. Files up to 25 MB; larger ones fail with an error, so open them instead. getFileBlob(id) resolves with the Blob itself. Read files only when they are shown (a selected record, a short list), not for hundreds of rows at once.
- openFile(id, { download? }) opens the file in a new tab (images, PDF, video, audio and plain text show in the browser, the rest downloads), or downloads it. Call it from a click; if the browser blocks the tab the CRM asks the viewer to open it.
- render_view refuses uploadFile (listed in not_run) and reads files as you, so FileImage shows real images there.

## Errors and size
- Show query errors (error is an Error or null); the ErrorBox and Table components do this for you.
- If the component throws, the page shows "This view crashed" with the message.
- Crashes, uncaught errors, console.error calls and failed queries are reported to the CRM, and get_view_runtime_errors returns them (only while someone has the view open; console.error is a fine way to report something you want to see).

## Scrolling and height
- By default the frame grows to fit the content and the CRM page scrolls, not the view. Do not set a fixed height on the page, and do not give the whole view its own scroll area (two scrollbars). CSS position: sticky does not work here because the frame never scrolls: use the kit's <Sticky> (it follows useViewport) for headers that stay in view. In this mode <Sticky> trails the scroll slightly (the scroll position arrives as a message from the CRM page), so headers visibly slip and catch up: fine for a summary bar, not for column headers.
- Boards, wide tables and anything with pinned column headers should be fill views (below), where sticky is native and has no lag.
- CSS trap: an element with overflow (overflow-x: auto for sideways scrolling included) becomes the scroll parent of everything inside it, so position: sticky inside it sticks to that box, not to the page, and headers inside a sideways scroller never stick vertically. Put the header outside the sideways scroller and move it with the scroller's scrollLeft: the kit's <ScrollX header={...}> does exactly that.
- For a view that should fill the screen and scroll itself (a board with pinned column headers, a map, a split pane), add \`export const frame = 'fill'\` next to the default export. The frame is then exactly as tall as the visible part of the CRM page, the document scrolls inside the frame, and position: sticky, height: 100vh and window scroll events all behave normally. <Sticky> uses position: sticky there.`;

const UI_KIT = `# UI kit (@pcrm/view)

Use these instead of building your own, so views look like the rest of the CRM.

Every component below also takes style and className, added to its own (style={{ minWidth: 220 }}), so adjust a kit piece rather than rebuilding it.

Types you can import for your own maps and props (types are stripped, not checked): BadgeTone ('primary'|'money'|'danger'|'warning'|'muted'), StatTone ('money'|'danger'|'muted'), ButtonVariant ('primary'|'danger'), Align, Column<Row>, QueryState<Row>, Viewport, Styled. E.g. import { Badge, type BadgeTone } from '@pcrm/view'; const toneFor: Record<string, BadgeTone> = { won: 'money', lost: 'danger' }.

## Layout
- <Page title subtitle actions>children</Page>: the page frame with padding. Use one per view, as the root.
- <Grid columns={2|3|4} gap={12}>: side-by-side cells; one column on phones.
- <Stack gap={12}>, <Row gap={8} align="center" wrap>: vertical and horizontal groups.
- <Card title subtitle actions>children</Card>: a white box with a border and shadow.
- <ScrollX header={<HeaderRow />} top={0}>body</ScrollX>: a wide area (kanban board, wide table) that scrolls sideways under a header that stays at the top while the page scrolls down and moves sideways with the body. Give the header's columns and the body's columns the same fixed widths (e.g. each column width: 280, flex: none) so they line up. Best in a fill view.
- <Sticky top={0}>children</Sticky>: stays in view at the top while its parent element scrolls past, then leaves with the parent (column headers of a long board; Table freezes its own header). Give it a background so content passes under it, e.g. style={{ background: 'var(--page-background)' }}. Works whether or not the view is a fill view.

## Data display
- <Stat label value hint tone="money"|"danger"|"muted" />: a KPI tile (a card of its own). tone colors the value: money is green (#1e7a4c), danger red (#b42318), muted grey; no tone is the normal text color. Use tone="money" for money amounts.
- <Table columns rows loading error onRowClick selected empty maxHeight sortable sort defaultSort onSortChange stickyHeader />
  - By default the header row stays frozen at the top while the page scrolls past the table (in grow views it trails the scroll slightly, as Sticky does; long record lists read best as fill views), and clicking any column header sorts by it: ascending, descending, then back to the query's order, with a mark on the sorted column. Keep both on for record lists; do not wrap a Table in Sticky. stickyHeader={false} or sortable={false} turn them off (a short summary table, say). Sorting is in the browser over the rows it has, empty values always last; numbers, dates and text sort as such. For a column drawn with render whose shown text differs from row[key], give sortValue: (row) => value, or sortable: false. defaultSort={{ key: 'created_at', direction: 'desc' }} starts sorted; sort plus onSortChange make it controlled, to keep the sort in address params.
  - To match the CRM's own table for an object (/objects/<object>), read get_object_list_config: its columns in order with labels and widths, and the sorts. get_object_create_form gives the native "Create" form's fields in order, for a create panel that matches it.
  - columns: [{ key, label, align?: 'left'|'right'|'center', width?, render?: (row) => node, hideOnMobile?, sortable?, sortValue?: (row) => value }]. hideOnMobile: true leaves the column out below 720px wide, so wide tables fit a phone without scrolling sideways; keep the name and one or two key figures.
  - Empty values show "--". Right-aligned columns use tabular figures.
  - onRowClick makes rows clickable; selected(row) highlights one. Rows are keyed by row.id when present, so select an id column.
  - When it sits directly in a Card, the table runs to the card's edges.
- <Badge tone="primary"|"money"|"danger"|"warning"|"muted">text</Badge>: a pill tinted with that color (warning is orange, #b54708).
- <Tabs tabs={[{ key, label }]} value onChange />
- <Loading label? />, <Empty>text</Empty>, <ErrorBox error={errOrString} />
- <RecordLink object id>text</RecordLink>: a link that opens a record.
- <ExternalLink href="https://sam.gov/...">text</ExternalLink>: a link to a web page outside the CRM, opened in a new tab through openUrl (http and https only; the viewer confirms the domain). Without children it shows the address. Use it for directories of outside sites, solicitation links and record fields holding a URL. A plain <a href="https://..."> also works (the frame hands it to openUrl) but ExternalLink is styled like the CRM's links. Never use target or window.open: the frame cannot open windows itself.

## Inputs
Sizes: Button, TextInput and Select are 34px tall, or 28px with small, so controls of the same size line up in a Row or in Page actions (which takes inputs as well as buttons: <Page actions={<><TextInput small .../><Button small>Send</Button></>}>). Mix sizes only on purpose. Text is 14px (12px small).

- <TextInput value onChange={(v) => ...} placeholder type="text"|"search"|"number"|"date" debounce={300} small />: with debounce (ms), the box updates as you type but onChange waits until typing stops; use it when onChange sets params or runs a query.
- <TextArea value onChange={(v) => ...} placeholder rows={4} snippets? />: several lines of text (notes, messages). Typing # in any textarea a view draws offers the viewer's snippets (saved text such as #welcome_email, kept in Settings, Snippets) when the view's "Allow snippets" setting is on (the default; update_view_settings allow_snippets). Snippet merge fields about a record ({{r.first_name|there}}) use their fallback in views. snippets={false} (or data-snippets="off" on a raw textarea) turns it off for one box, for code or ids.
- <PhoneInput value onChange={(v) => ...} small />: the CRM's phone box, for every phone property (display: phone in describe_object, get_object_create_form and the schema topic). A country picker (flag) beside the number; when the viewer leaves it, the number is checked and shown formatted (+1 888-234-5678 ext9), or a message under it says why it is not valid. onChange gets the value to save. Never use a TextInput for a phone property.
- <Select value onChange options={[{ value, label }]} placeholder? small />: the CRM's dropdown. It opens a menu-style list like every other dropdown in the CRM (a check beside the current choice, a search box from 11 choices, arrow keys, Enter and Escape), never the browser's own list. onChange gets the picked value as a string. Widen it with style={{ minWidth: 200 }}. Never write a raw <select> in a view: use Select for every single choice.
- <Button variant="primary"|"danger" small disabled onClick>text</Button>

## Files
- <FileInput onUpload={(files) => ...} accept="image/*,.pdf" multiple capture="environment" label hint compact small disabled object id property />: a dashed drop zone with a button that opens the file picker (compact: the button alone). On phones, capture opens the camera ("environment" the back camera, "user" the front; true is the back one) and the default label becomes "Take photo"; without capture phones offer camera, photos and files. With onUpload the picked or dropped files are uploaded as the viewer (with a progress bar) and onUpload gets [{ id, name, mime_type, size_bytes }] to put in a file property; with onFiles={(files: File[]) => ...} instead it hands over the File objects and uploads nothing (to check or preview first, then uploadFile). accept also filters dropped files; multiple false keeps the first. object, id and property: the record the files are for, as in uploadFile. Errors (refused, too many files) show under it.
- <FileImage id alt fit="cover"|"contain" width height />: an uploaded image (read through the CRM as a blob: URL; a grey box while loading). A file that is not an image shows as a link that opens it. Give width and height (e.g. 96 x 96 thumbnails with fit="cover").
- <FileLink id download?>text</FileLink>: a link that opens (or downloads) a file.
- formatBytes(n): 1.2 MB.
Example, a receipt on an expense: <FileInput accept="image/*,.pdf" capture="environment" onUpload={async ([f]) => { await updateRecord('expenses', row.id, { receipt: [f.id] }); refresh(); }} /> and {row.receipt?.[0] && <FileImage id={row.receipt[0]} width={120} height={120} />}.

## Formatters
- formatNumber(v, decimals?), formatMoney(v, currency = 'USD'), formatPercent(fraction, decimals = 0) (0.25 gives 25%)
- formatDate(v) gives YYYY-MM-DD, formatDateTime(v) gives YYYY-MM-DD HH:MM in the viewer's own time zone (their browser's), as in the rest of the CRM. Datetimes arrive as UTC; do not shift them yourself. render_view says which zone it drew in.
- chartColors: 8 series colors, in order: [0] the tenant's primary color (var(--primary), cobalt #2445b8 by default), [1] green #0e9f6e, [2] orange #d97706, [3] violet #7c3aed, [4] pink #db2777, [5] cyan #0891b2, [6] lime #65a30d, [7] slate #64748b. Pick by index, or use any CSS color string.

## Charts (recharts)
Wrap charts in <ResponsiveContainer width="100%" height={240}>. Typical: BarChart / LineChart / AreaChart / PieChart with XAxis, YAxis, Tooltip, CartesianGrid (strokeDasharray="3 3", vertical={false}). Use fill={chartColors[i]}, fontSize={12} on axes, radius={[4, 4, 0, 0]} on bars. The kit already colors grid lines and axis text.`;

const STYLING = `# Styling

- The CRM's look: Inter font, 14px text, white cards with 10px radius, subtle shadows, cobalt primary (tenants can change colors). The kit components already follow it; prefer them over custom CSS.
- Colors come from CSS variables set to the tenant's theme: var(--primary), var(--text), var(--muted-text), var(--border), var(--surface) (light grey panels, table headers), var(--page-background), var(--money) (green for amounts), var(--danger). Never hard-code brand colors; use these.
- Spacing: 4, 8, 12, 16, 20, 24 px. Radius: var(--radius-sm) 4px, var(--radius) 6px, var(--radius-lg) 10px.
- Classes you can use: muted (secondary text), small (12px), figures (tabular numbers).
- Inline styles are fine (style={{ ... }}). There is no Tailwind and no external CSS.
- Writing: sentence case labels ("Open deals", not "Open Deals" or "OPEN DEALS"); short titles; say what a number covers in a subtitle ("Last 12 months, by close date").
- Money: format with formatMoney and the record's currency. Never add raw amounts in different currencies together: convert them in SQL with convert_currency (topic sql) and format the total in the base currency, or group by currency.
- Dates: YYYY-MM-DD; datetimes YYYY-MM-DD HH:MM.
- Empty values: "--" (Table does this). Loading and errors: always handle both.
- Phones: Grid becomes one column below 720px; keep tables to the columns that matter.
- How to lay out a view and choose charts, tables and states: topic design.`;

const DESIGN = `# Design

A view should look like part of the CRM and answer one job quickly. These rules turn that into choices; the kit (topic ui_kit) and tokens (topic styling) are how you carry them out.

## Start from the job
- Before writing code, put the view in one sentence: who opens it, what they need to see or decide, and how often. "Sales reps, every morning: which of my deals close this month and which are stuck." The title is that job in a few words ("Deals closing this month"); the subtitle says the scope ("Your open deals, by close date").
- Pick one main shape, two at most:
  - Dashboard: a few numbers to watch, and a trend.
  - Work list: records someone acts on, one by one.
  - Board: records moving through stages (ScrollX in a fill view).
  - Drill-down: a list, and the selected item's details beside or below it.
  - Tool: a form or button that does something (an integration, record changes).
- If the user asks for "everything about X", ask what they will do with it, or build the work list first.

## Top to bottom
1. Page title and subtitle; filters and actions in Page actions, on the right.
2. Up to 4 Stat tiles in a Grid (columns={4}, or 3): the numbers that answer the job. Each label says what it counts; use hint for scope or a comparison ("of 120 open", "last 30 days").
3. The main chart or table, full width.
4. Supporting cards, two side by side (Grid columns={2}).
- What someone acts on should be visible without scrolling at 1280 by 800.
- One primary Button per screen; the rest are plain or small.
- One Page; never a Card inside a Card; no extra margins around kit pieces (Stack, Row and Grid gaps do the spacing: 12 between cards, 8 inside a row).

## Choosing what shows the data
| Question | Use |
| --- | --- |
| One number that matters | Stat (tone="money" for amounts) |
| How it changes over time | LineChart or AreaChart, time across, weeks or months |
| Which category is biggest | Horizontal BarChart, largest first; over 7 categories, show the top 7 plus "Other", or a table |
| Parts of a whole | Bar or stacked bar; a pie only for 2 to 4 parts |
| Exact values people read or copy | Table |
| Records people act on | Table with RecordLink or onRowClick |
| Records moving through stages | Board: ScrollX with fixed-width columns, in a fill view |
- Under 3 data points, show the numbers, not a chart.
- Money in different currencies: convert to the base currency in SQL (convert_currency, topic sql) before adding, and say so in the subtitle ("in USD at today's rates"); otherwise one series per currency. Never add raw amounts.

## Charts
- One message per chart; the card title says it ("Won per month") and the subtitle the scope.
- chartColors in order; the same series keeps the same color everywhere in the view; at most 5 series (group the rest). One series: chartColors[0].
- Bars start at zero. Format ticks and tooltips with formatMoney, formatNumber or formatPercent (tickFormatter, Tooltip formatter); fontSize={12} on axes; CartesianGrid vertical={false}.
- 200 to 280px tall inside a card; charts side by side get the same height.

## Tables
- 3 to 7 columns. First column: the record's name as a RecordLink. Numbers right-aligned (align: 'right'); dates YYYY-MM-DD; dropdowns by their __label.
- Status as a Badge with one meaning per tone across the view: money for won or paid, danger for lost or overdue, warning for at risk, primary or none for open. Keep the map in one place (Record<string, BadgeTone>).
- Sort by what matters and say so in the subtitle ("Biggest first"). Limit long lists in SQL and say it ("Top 50 by amount"), or page through them with a param.
- hideOnMobile: true on the columns a phone can do without; keep the name and one or two figures.

## Filters and selection
- Filters sit in Page actions as small Select and TextInput (search with debounce), with a small "Clear" button when any is set. Keep every filter and the selected item in address params (setParams), so links, refreshes and render_view params keep them.
- Say what the filters left: a count in the subtitle or card title ("12 deals").

## Words, numbers and states
- Labels in sentence case and the user's words: property labels and __label columns, never api_names or ids.
- Money with formatMoney and the record's currency; shares with formatPercent; counts with formatNumber; missing values "--".
- Loading: Loading or Table loading, not an empty message while data is still coming.
- Empty: say what is empty and what to do ("No deals close this month. Pick another month above.").
- Errors: ErrorBox with the message, in the card where the data would be.
- Color carries meaning only (money, danger, warning, primary). No decorative colors, gradients, extra shadows, emoji as icons, or font sizes outside the kit (only Stat values are big).

## Phones
- Grid becomes one column; keep Stat tiles to 4; tables use hideOnMobile; boards scroll sideways with 260 to 300px columns.

## Review before handing it over
Render with render_view and fix what it finds before giving the user the draft_url:
1. 1280 wide, and 390 wide (phones). Long pages: also scrolled (scroll_y), or full_page.
2. Drill-downs and tabs: with params, or click.
2b. Anything driven by typing (search, an autocomplete): a click step with type, e.g. {selector: 'input[placeholder="Street"]', type: '51 trolley'}. For an integration, first with integration_answers shaped like the real answer (from test_integration) to check the list, then, once the admin agrees, call_integrations to check it end to end. Then click a result and render again to check what it fills in.
3. The report has no text_cut, overflow or off_right (except a sideways scroller you meant), an empty console and no failed_queries.
4. The numbers match what try_view_query returns.
5. The empty state: params that match nothing.
6. Title and subtitle still say exactly what the page covers.
Then tell the user what the view shows, what you checked, and anything you could not check.`;

const SQL = `# SQL queries

queries is an object of named queries:
\`\`\`json
{
  "open_deals": { "sql": "select pc_0012_id as id, name, amount from deals where coalesce(stage, '') <> 'closed_won' order by amount desc nulls last limit :limit", "params": { "limit": "number" } },
  "contact_count": "select count(*) as n from contacts"
}
\`\`\`
A plain string is a query without params. Names: lowercase letters, digits, underscores.

## Rules (checked when saving; the error says what is wrong)
- One SELECT (or WITH ... SELECT). No writes, no semicolons, no comments (-- or /* */), no $ and no E'' strings.
- Read only the view_data schema. Unqualified names resolve there: "from deals" is view_data.deals. Nothing else is readable (no crm, reporting, meta, auth, pg_catalog tables).
- Only these functions: every aggregate (count, sum, avg, min, max, string_agg, array_agg, bool_or, json_agg, percentile_cont, ...) and window function (row_number, rank, lag, lead, ...); every operator (=, <, ||, LIKE, ILIKE, ~, date and interval math, @>, &&, ->, ->>, ...) and cast (::date, ::numeric, ...); and abs, ceil, floor, round, trunc, sign, mod, div, power, sqrt, exp, ln, log, pi, random, width_bucket; length, lower, upper, initcap, trim (btrim, ltrim, rtrim), substr, substring, left, right, replace, translate, concat, concat_ws, split_part, strpos, position, lpad, rpad, repeat, reverse, format, starts_with, regexp_replace, regexp_match, regexp_matches, regexp_split_to_array, string_to_array, array_to_string, md5, to_hex; to_char, to_number, to_date, to_timestamp; now, clock_timestamp, date_trunc, date_part, extract, date_bin, age, isfinite, make_date, make_time, make_timestamp, make_timestamptz, make_interval, justify_days, justify_hours, justify_interval, timezone (AT TIME ZONE); array_length, cardinality, array_position, array_positions, array_remove, array_replace, array_append, array_prepend, array_cat, unnest, generate_series, generate_subscripts; to_json, to_jsonb, row_to_json, json(b)_build_object, json(b)_build_array, json(b)_array_elements(_text), json(b)_each(_text), json(b)_object_keys, json(b)_typeof, json(b)_array_length, json(b)_extract_path(_text), jsonb_strip_nulls; num_nulls, num_nonnulls; similarity, word_similarity; convert_currency and currency_rate (see Money in different currencies). coalesce, nullif, greatest, least, CASE, EXISTS, IN, current_date and current_timestamp are SQL syntax and always fine. Anything else is refused when saving.
- Params are written :name and declared in "params" with a type: ${Object.keys(PARAM_TYPES).join(', ')}. ":name::date" casts as usual. :me is built in: the viewer's user id (text), useful with owner, e.g. "where owner = :me" (single-value owner) or ":me = any(owner)" (multi-value).
- Every query runs as the viewer with row-level security, read-only, 10 seconds at most, at most ${ROW_CAP} rows. Counts and sums therefore cover only what the viewer can see; say so if it matters.
- Never select * : a viewer whose roles hide a property gets an error for any query that reads it, so select only the columns you need.
- Output column names must be unique (alias them: "c.name as company").

## The view_data schema
- One view per object, named after the object's api_name (contacts, companies, deals, tickets, ...), active records only.
- The id column is <object code>_id, e.g. pc_0010_id for contacts (see topic schema). Alias it "as id" for tables and openRecord.
- Base columns on every object: object_type_id, <code>_id, name, created_at, updated_at, merged_ids, record_status.
- Single-value dropdowns are text (the api_value) plus <name>__label (the label). Multi-value dropdowns are text[] plus <name>__label (text[] of labels). Filter on the api_value, show the label.
- owner is a dropdown of user ids (owner__label is the user's name).
- users: the CRM's users (pc_0000_id, name, first_name, last_name, email, status: active or deactivated). For an owner filter that lists everyone, not just people who own something: "select pc_0000_id as id, name from users where status = 'active' order by name". Records can be owned by users who are archived or deactivated, and those are not in that list (or, when archived, not in users at all), so add the owners found on the records: "select pc_0000_id as id, name from users where status = 'active' union select owner, owner__label from deals where owner is not null order by 2".
- How CRM features link records (meetings to the booking page they were booked on, submissions to forms, lines to their parent, payments and invoices to quotes): see "How it is linked" for that object in topic schema, or how_linked in describe_object. Links listed as linked_only_by_crm are made only by the feature, so they mean exactly that (every call linked to a booking page was booked through it).
- associations: one row per link, seen from both sides: association_id, label_id, label, object_type_id, record_id, other_object_type_id, other_record_id, side, created_at, object, other_object (the last two are api_names, like 'deals' and 'contacts'). It holds links between every pair of objects, so always filter both object and other_object; joining contacts on other_record_id without other_object = 'contacts' matches ids of unrelated records. A deal's contacts:
  "select ct.pc_0010_id as id, ct.name from associations a join contacts ct on ct.pc_0010_id = a.other_record_id where a.object = 'deals' and a.other_object = 'contacts' and a.record_id = :deal"
  Contacts per deal, for a board: "select a.record_id as deal_id, string_agg(distinct ct.name, ', ') as contacts from associations a join contacts ct on ct.pc_0010_id = a.other_record_id where a.object = 'deals' and a.other_object = 'contacts' group by a.record_id"
  Always join to the other object's view (as above) rather than counting association rows, so hidden records are not counted, and use count(distinct ...) since two records can be linked under more than one label.
- objects, properties, property_options, association_labels, currencies: the CRM's setup. currencies: code, name, symbol, decimals, rate_to_base (1 of this currency in base units), is_base, rate_date, rate_source (manual or provider), rate_manual (pinned by an admin).
- currency_rates: the exchange rate history, one row per day and currency: rate_date, from_code, to_code (the base that day), rate (1 from_code = rate to_code), source (manual or provider), provider, created_at. Order dropdown values by property_options.display_order.
- property_options: object_type_id, property, api_value, label, display_order, record_status, parent_property, parent_values, is_closed, is_won, probability, color. color is the choice's colour as #rrggbb (null = none); use it for badges and board columns. Pipeline stages use parent_property to probability: deals.stage has parent_property 'pipeline', each stage lists the pipelines it belongs to in parent_values (empty means every pipeline), and is_closed / is_won / probability say what the stage means. Never hard-code stage values like 'closed_won' for won, lost or open: join property_options instead, so renamed or added stages stay right. Open pipeline:
  "select d.currency, sum(d.amount) as open_amount from deals d join property_options s on s.object_type_id = 'pc_0012' and s.property = 'stage' and s.api_value = d.stage where not s.is_closed group by d.currency"
  Columns for one pipeline: "select api_value, label from property_options where object_type_id = 'pc_0012' and property = 'stage' and record_status = 'active' and (cardinality(parent_values) = 0 or :pipeline = any(parent_values)) order by display_order"
- Property api_names with capitals or dots must be double-quoted: "favorite.color".

## Money in different currencies
Money properties (amount on deals, quotes, invoices, payments, carts, orders) hold the amount in the record's own currency, kept in a currency dropdown (currency_property in describe_object, usually currency). Adding them raw mixes currencies. Convert first:
- Deals, quotes, invoices, orders and carts also have amount_base ("Amount in base currency"): the amount already converted to the base currency at the rate of the record's own date (deals close_date, quotes customer_signed_at, invoices due_date, orders and carts created_at; a day not passed yet, or no date, uses today's rate). For totals on those objects, sum(amount_base) is simplest and matches what the record pages show. It is null when the currency has no rate. Use convert_currency when you need other dates or another target currency.
- convert_currency(amount, from_currency, to_currency default the base, on_date default null): the amount in to_currency, or null when a rate is unknown. With no date it uses today's rates; with a date, the rate that was in effect that day (the latest stored rate on or before it).
- currency_rate(from_currency, to_currency default the base, on_date default null): the rate itself (1 from = rate to).
- The base currency: "select code from currencies where is_base". Format totals with formatMoney(total, base).
- Open pipeline in the base currency at today's rates:
  "select sum(convert_currency(d.amount, d.currency)) as open_amount, count(*) filter (where d.amount is not null and convert_currency(d.amount, d.currency) is null) as unconverted from deals d join property_options s on s.object_type_id = 'pc_0012' and s.property = 'stage' and s.api_value = d.stage where not s.is_closed"
- Won per month at the rate of each deal's close date: "select date_trunc('month', close_date)::date as month, sum(convert_currency(amount, currency, null, close_date)) as won from deals ... group by 1 order by 1"
- A null currency is unknown, not the base: use coalesce(currency, (select code from currencies where is_base)) only if the user says blank means the base.
- Count what could not be converted (no rate yet) and show it ("2 deals in KRW have no rate"), rather than silently leaving them out. Say which rates were used in the subtitle (today's, or the rate of each close date).`;

const PROPERTIES = `# Property tools (admins)

Ask the admin before creating or changing properties: it changes the CRM for everyone. Nothing can be deleted with these tools: archive instead (an admin can delete in Settings, Properties).

- create_property(object, api_name, label, type, description?, options?, dropdown_options?, calc_sql?, calc_output_type?)
- update_property(object, property, label?, description?, options?, calc_sql?, calc_output_type?). The api_name and type never change.
- archive_property / unarchive_property(object, property): archived properties are hidden everywhere and their data is kept. Blocked while a calculation reads it.
- add_dropdown_option(object, property, value, label, display_order?, color?), update_dropdown_option(object, property, value, label?, display_order?, color?), where color is #rrggbb or null for none, archive_dropdown_option / unarchive_dropdown_option(object, property, value). Archived options stay on records that have them but cannot be chosen again.
- test_calculation(object, record_id, calc_sql, calc_output_type): tries a calculation on one record, saves nothing.

## Naming
- api_name: letters, digits, dots, underscores; starts with a letter; at most 63; unique per object; permanent. Prefer lowercase snake_case.
- Reserved: id, object_type_id, name, created_at, updated_at, merged_ids, merged_into_id, record_status, created_by, updated_by, anything starting pc_ or row_, anything containing __.
- Labels: 1 to 63 characters, unique per object, sentence case.
- Option values: letters, digits, dots, underscores, at most 63; unique per property.

## Types and options
- text: single_line, display (plain, url, markdown, json, html, phone: checked with Google's libphonenumber and stored as +18882345678ext9), regex, regex_scope (all, ui), json_only, unique, case_insensitive (with unique).
- number: min, max, decimals (0 to 10), format (formatted, unformatted, currency, percentage), prefix, suffix, currency_code (fixed currency) or currency_property (a dropdown holding the currency).
- dropdown: single_value, allow_user_add, auto_append_users (users as options), default_value (an option value; never empty), parent_property (another single-value dropdown on the same object that this one depends on, like stage on pipeline), color_display (how choice colours show: none (default), dot for a large dot left of the label (single_value only) or pill). A yes/no is a single-value dropdown with options true and false.

## Stage details on options
Dropdown options can carry details, set with add_dropdown_option or update_dropdown_option: parent_values (values of the dropdown's parent_property this option belongs to, e.g. the pipelines a stage is in; empty = all), is_closed, is_won (also makes it closed) and probability (0 to 1, for open options; closed won is always 1 and closed lost always 0, set automatically, and a different value is refused). Settings shows these as Open, Closed won or Closed lost. describe_object shows them where set; views read them from view_data.property_options. Deal stages start with stage under pipeline, closed_won closed and won, closed_lost closed. Ask the admin before changing them: reports and views read them.
- date (a calendar day), datetime (timezone display option), file (max_files).
- calculation: calc_sql is one SQL expression over the current record r (a row of crm.<object>), output type text, number, date or datetime. It may read crm, reporting and integrations, must return one value per record, and must run in under 1 second. Try it with test_calculation first. Options: display, format, prefix, suffix, decimals, timezone, currency_code. To convert money, call currency_to_base(amount, currency, on_date) (on_date null or not passed yet: today's rate); such calculations are recalculated when rates change, and their currency_code follows the base currency.`;

const INTEGRATIONS = `# Integrations

Views have no network access of their own. To reach an outside service (an n8n workflow that posts to Slack, sends an email, calls another API), an admin adds an integration in Settings, View integrations: a key, a name, a description, the endpoint's URL and optionally a secret header. The CRM's server makes the request, so there is no CORS to deal with and the secret never reaches the browser.

- list_view_integrations shows the ones that exist: key, label, description, audience, enabled, host and a masked url (where it points), the last call's status, and data_example: the data the other end expects.
- data_example is the contract between the view and the workflow. Build data to match it (same fields and types). A call whose data does not match still goes out, but the mismatch is logged in get_view_runtime_errors (kind "integration", "data for <key> does not match its example: ...") and the call's answer carries warnings. When you build both sides, record the shape with update_view_integration data_example first, and make the workflow read those fields.
- test_integration(key, data?) sends data now (data_example when none is given) and returns the status and answer, so the workflow can be checked without a person clicking the view's button. It really runs the workflow (a test Slack message is really posted): say so to the admin first.
- test_integration_url(url, data?) checks a workflow before it is saved as an integration: one call from the CRM's server (which can reach addresses your own shell may not) with the same payload shape plus dry_run: true, returning the status and answer. It also really runs the workflow; confirm the URL and data with the admin first.
- create_view_integration and update_view_integration add or change one. They send CRM data to an outside address: show the admin the URL and the data first and wait for their yes, as with webhooks. Admins can also do it in Settings, View integrations.
- You can add an integration but not turn it on. A new one starts off (awaiting_approval) and views cannot call it until an admin turns it on in the CRM: give them the approve_url from the answer. Changing an enabled one's url or audience turns it off again until they approve. test_integration works on one that is off, so the workflow can be checked while it waits.
- To see it working in the view without a person: render_view with a typing step and integration_answers (canned, nothing sent) or call_integrations (really sent); see topic design, step 2b of the render review.
- In the view: import { callIntegration } from '@pcrm/view'; then await callIntegration('slack-message', { channel: '#sales', text }) from a button's onClick.
- Sends are not confirmed by the viewer: an admin enabling the integration (and its audience) is the approval. Never call it on load or in an effect.
- Calls made while the viewer types (address autocomplete, lookups) need an integration with interactive: true (create_view_integration or update_view_integration; "Called while typing" in Settings). That raises the limit to 120 calls a minute instead of 30. Still debounce the input (300 ms or so) and only call from what the viewer types or clicks.
- It resolves with { status, data }: data is the service's answer (parsed JSON, or text). It rejects with an Error whose message explains why: the service's HTTP error ("Slack message answered HTTP 500: ..."), a timeout (15 seconds), or the viewer not being allowed to use it (audience "admins" means only admins can). Show the message, and disable the button while it runs.
- Limits: data up to 250 KB of JSON, 30 calls a minute per person per integration (120 for interactive ones), answers up to 1 MB.
- Failed calls show up in get_view_runtime_errors as kind "integration".

## What the service receives
A JSON POST:
\`\`\`json
{
  "integration": "slack-message",
  "data": { "channel": "#sales", "text": "Hello" },
  "view": { "slug": "deal-desk", "name": "Deal desk", "draft": false },
  "user": { "id": "...", "name": "Pat Lee", "email": "pat@example.com" },
  "sent_at": "2026-11-02T18:00:00.000Z"
}
\`\`\`
plus the header X-PCRM-Integration: <key> and the secret header if the admin set one. In n8n: a Webhook node (POST, Header Auth with that header) reads body.data; end with "Respond to Webhook" (or respond immediately) so the view gets an answer quickly.

## Example
\`\`\`tsx
import { useState } from 'react';
import { Page, Card, Stack, TextInput, Button, ErrorBox, callIntegration } from '@pcrm/view';

export default function SlackNote() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  async function send() {
    setBusy(true); setError(null); setSent(false);
    try {
      await callIntegration('slack-message', { text });
      setText(''); setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title="Message the team">
      <Card>
        <Stack>
          <TextInput value={text} onChange={setText} placeholder="What should Slack hear?" />
          <Button variant="primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Sending…' : 'Send to Slack'}</Button>
          {sent && <span className="muted small">Sent.</span>}
          <ErrorBox error={error} />
        </Stack>
      </Card>
    </Page>
  );
}
\`\`\``;

// How CRM features link the records they make (all through associations,
// unlabeled unless said). Shown with the object in the schema topic and by
// describe_object. Keep in step with the features (routes/booking.ts,
// forms.ts, payments/fulfil.ts, migrations 0016, 0022, 0028).
export const FEATURE_LINKS: Record<string, string> = {
  booking_pages: 'A meeting booked on a booking page is a calls record (call_type meeting) linked to the page. Only bookings make this link (users cannot add or remove it), so every call linked to a booking page was booked through it; to count bookings per page, count calls linked to it. A cancelled booking keeps its link with call status cancelled. The meeting is also linked to the contact (found or created by the attendee email) and to the form submissions of the page\'s forms.',
  calls: 'Meetings booked through a booking page are linked to that page (a link only bookings make), to the contact and to the form submissions. Other calls are linked by people as usual.',
  forms: 'Each submission is a form_submissions record linked to its form; only the form makes this link.',
  form_submissions: 'Linked to its form (a link only the form makes), to the contact it filled in, and to the ticket when the form creates tickets.',
  lines: 'A line is linked to at most one product and at most one parent: a deal, quote, invoice, payment, cart, order or custom object record. Archiving or deleting the parent does the same to its lines.',
  payments: 'A payment is linked to the quote or invoice it pays and to that record\'s contacts and companies.',
  invoices: 'A paid quote creates a paid invoice linked to the quote, the payment, and the quote\'s deals, contacts and companies.',
  users: 'Users link only to teams.',
  views: 'Views link to nothing.'
};

// ---- dynamic topics ---------------------------------------------------------------

function columnType(p: PropertyDef): string {
  const t = p.type === 'calculation' ? p.calc_output_type ?? 'text' : p.type;
  if (t === 'dropdown') return isSingleValue(p) ? 'text (dropdown, single)' : 'text[] (dropdown, multi)';
  if (t === 'number') return 'numeric';
  if (t === 'datetime') return 'timestamptz';
  if (t === 'file') return 'text[] (file ids)';
  if (t === 'id') return 'text (record ID)';
  if (t === 'id_list') return 'text[]';
  if (t === 'actor') return 'text (who: user:<user id>, api:<key prefix>, system:<what> or public)';
  return t;
}

function describeObject(o: ObjectDef, p: Principal, detailed: boolean): string {
  const props = o.properties.filter((pr) => pr.record_status === 'active' && pr.api_name !== 'object_type_id' && propertyAccess(p, pr) !== 'hidden');
  const lines = [`## ${o.api_name} (${o.label_plural}, code ${o.object_type_id}, id column ${o.id_column})`];
  if (o.description) lines.push(o.description);
  if (o.aliases.length) lines.push(`Also called: ${o.aliases.join(', ')}`);
  if (FEATURE_LINKS[o.api_name]) lines.push(`How it is linked: ${FEATURE_LINKS[o.api_name]}`);
  for (const pr of props) {
    let line = `- ${pr.api_name}: ${columnType(pr)}${pr.label !== pr.api_name ? `, "${pr.label}"` : ''}`;
    if (pr.type === 'text' && pr.options.display === 'phone') line += ', a phone number (use PhoneInput)';
    if (pr.type === 'number' && typeof pr.options.currency_property === 'string') line += `, money in the currency held in ${pr.options.currency_property} (convert with convert_currency, topic sql)`;
    else if (pr.type === 'number' && typeof pr.options.currency_code === 'string') line += `, money in ${pr.options.currency_code}`;
    if (pr.type === 'dropdown') {
      line += `, also ${pr.api_name}__label`;
      const opts = pr.dropdown_options.filter((x) => x.record_status === 'active');
      if (pr.options.parent_property) line += `, depends on ${pr.options.parent_property}`;
      const details = (x: (typeof opts)[number]) => [
        x.parent_values.length ? `in ${x.parent_values.join('/')}` : '', x.is_won ? 'won' : x.is_closed ? 'closed' : '',
        x.probability !== null ? `${Math.round(x.probability * 100)}%` : ''
      ].filter(Boolean).join(', ');
      if (detailed && opts.length && !pr.options.auto_append_users) {
        line += `; values: ${opts.slice(0, 40).map((x) => `${x.api_value} (${[x.label, details(x)].filter(Boolean).join('; ')})`).join(', ')}${opts.length > 40 ? ', ...' : ''}`;
      }
      if (pr.options.auto_append_users) line += '; values are user ids';
    }
    if (detailed && pr.description) line += `. ${pr.description}`;
    lines.push(line);
  }
  if (o.links_to.length) lines.push(`Links to: ${o.links_to.join(', ')}`);
  return lines.join('\n');
}

async function schemaTopic(p: Principal, object?: string): Promise<string> {
  const reg = await getRegistry();
  const readable = reg.objects.filter((o) => o.record_status === 'active' && (!p.permissions || p.permissions.objects.get(o.object_type_id)?.read));
  if (object) {
    const o = readable.find((x) => x.api_name === object || x.object_type_id === object);
    if (!o) return `No object "${object}" you can read. Objects: ${readable.map((x) => x.api_name).join(', ')}`;
    return `# view_data.${o.api_name}\n\n${describeObject(o, p, true)}`;
  }
  return `# The data (view_data)\n\nEvery object below is a view in view_data with these columns (plus name, created_at, updated_at). Call view_guide with topic "schema" and an object for dropdown values and descriptions. Also: currencies and currency_rates (exchange rates; convert money with convert_currency, topic sql), users, associations, objects, properties, property_options.\n\n${readable.map((o) => describeObject(o, p, false)).join('\n\n')}`;
}

async function examplesTopic(): Promise<string> {
  const { rows } = await pool.query(
    `select name, slug, description, coalesce(source, draft_source) as source, coalesce(queries, draft_queries) as queries
     from crm.pc_0055 where record_status = 'active' and slug in ('reporting', 'contacts-companies') order by slug desc`
  );
  if (!rows.length) return '# Examples\n\nThe example views were removed. Use list_views and get_view to read other views.';
  return `# Examples\n\nFinished views to copy from. list_views and get_view show the others.\n\n${rows.map((r) =>
    `## ${r.name} (/view/#${r.slug})\n${r.description ?? ''}\n\nqueries:\n\`\`\`json\n${JSON.stringify(parseQueries(r.queries), null, 2)}\n\`\`\`\n\ncode:\n\`\`\`tsx\n${r.source}\n\`\`\``
  ).join('\n\n')}`;
}

export async function viewGuide(p: Principal, topic: GuideTopic = 'overview', object?: string): Promise<string> {
  switch (topic) {
    case 'overview': return `${OVERVIEW}\n\nTopics: ${GUIDE_TOPICS.join(', ')}.`;
    case 'runtime': return RUNTIME;
    case 'ui_kit': return UI_KIT;
    case 'styling': return STYLING;
    case 'design': return DESIGN;
    case 'sql': return SQL;
    case 'schema': return schemaTopic(p, object);
    case 'properties': return PROPERTIES;
    case 'integrations': return INTEGRATIONS;
    case 'examples': return examplesTopic();
    case 'document_templates': return DOCUMENT_TEMPLATES;
  }
}
