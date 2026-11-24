# Defense package: handoff

The `defense` package rebuilds Matt's "Signal Flare CRM" prototype (Base44, `https://defenedge-growth-sync.base44.app`) on this CRM: business development for defense, public safety and federal sellers. This file says what the package is, what is built, where it runs, how to change and ship it, and what is left. It replaces the old planning doc `defense_crm_handoff.md` (repo root, last state 2026-11-04), which is still in git history.

Rewritten 2026-11-22 from the manifest, the view sources, `HANDOFF.md` and the code. Everything below marked "not checked" was not checked when written.

## Where things are

| What | Where |
|---|---|
| Manifest (objects, properties, pipeline, labels, option list, records, views, menu) | `api/packages/defense/manifest.json`, version `0.1.0` |
| Views (18) | `api/packages/defense/views/<slug>.tsx` plus `<slug>.queries.json` |
| Installer | `api/src/packages.ts` (`checkManifest`, `installPackage`, `checkPackageViews`, `checkNav`), CLI `api/src/cli/install-package.ts` (`npm run install-package`), routes `api/src/routes/packages.ts`, tests `api/src/packages.test.ts`, docs `docs/architecture.md` (Packages) |
| Demo data for a real tenant | `scripts/seed_defense_data.py` (through the API) |
| Smoke test for views | `scripts/package-views/smoke.mts` with `scripts/package-views/seed-defense.sql` (throwaway cluster only) |
| Card scanner (core, used by the package's menu) | `web/src/pages/CardScanner.tsx`, `api/src/card-scan.ts`, `api/src/card-parse.ts` |
| Defense CRM install | `https://crm.defense.profitpad.com`, `/opt/profitpad-defense-crm` on ProfitPad's server, `PCRM_INSTANCE=defense`, containers `pc-defense-*`, web on 127.0.0.1:8082, Google sign-in only |
| Theme backup for the defense CRM | `backups/defense_theme_restore.sql`, `backups/defense_theme_20261122.json` (git-ignored) |
| Old worktree | `.claude/worktrees/defense-package` (branch `worktree-defense-package`) holds the first copy; everything in it is on main now |

## Status at a glance

| Area | State |
|---|---|
| Data model | Done: 12 custom objects, defense properties on 8 native objects, the Defense BD pipeline, 2 association labels, 1 shared option list, 16 opportunity sources |
| Views | 18 built, all published on the defense CRM; 15 in the default menu |
| AI features | 3 built through view integrations and n8n workflows calling Claude: Opportunity Evaluator, Reports, BOM reader (the n8n workflows are live; the CRM integrations are missing on the defense CRM since its reinstall, see AI features). The card scanner calls Claude natively. The rest (RFP drafting, follow-up drafts, lead extraction from email, intel feed, out-of-office email, receipt reading) are not built |
| Package installer | Install only. No upgrade and no uninstall. Sets the default menu only on the first install. Asks for the n8n address and creates the AI integrations with a per-tenant secret (not released yet) |
| Defense CRM | Running release v0.2.13 (last deploy logged in `HANDOFF.md`, 2026-11-22). Package 0.1.0 installed on a fresh install 2026-11-22 and seeded with demo data. Views and menu changed afterwards by hand through the MCP connector and `PUT /v1/ui/nav/default` |
| Latest release | v0.2.18. Releases after v0.2.13 (hotbar back to 4 items, migration 0107, and others) are not on the defense CRM yet |

## How to work on it

Install or check, from `api/` (it goes through the `meta.*` functions as `pc_api`, so the database rules apply):

```bash
npm run install-package -- defense
```

```bash
npm run install-package -- defense --apply
```

```bash
npm run install-package -- defense --check-views
```

The install asks for the n8n address first (Enter leaves it blank); `--set n8n_url=https://n8n.example.com` gives it up front and `--no-prompt` asks nothing. A new integration secret is printed once at the end of `--apply`.

The first is a plan (dry run), the second installs, the third compiles every view and runs its queries against a tenant that already has the package, changing nothing. On a server install, run it inside the API container (`docker compose exec api npm run install-package -- defense`). Admins can also call `POST /v1/packages/defense/install` (`dry_run` in the body), and `GET /v1/packages` lists packages with their installed version.

Smoke test: on a throwaway cluster (`db/test-local.sh` with its own `PCRM_TEST_PGDATA` and `PCRM_TEST_PORT`), install the package, load `seed-defense.sql`, then run `smoke.mts`. It runs every view query through `runQuery` and renders every view on the server with a stand-in kit in 38 param states. It does not check layout, clicks or phones: use the MCP `render_view` tool (1280 and 390 wide) against a tenant for that.

Demo data on a tenant: `/usr/bin/python3 scripts/seed_defense_data.py`. `PCRM_API_URL` defaults to `https://crm.defense.profitpad.com`; it asks for an API key (read and write, or admin) unless `PCRM_API_KEY` is set. Each run adds a new tagged set. On 2026-11-22 the key was made with `src/cli/create-key.ts` in `pc-defense-api` and revoked right after.

Deploy the CRM itself to the defense install: `./scripts/deploy.sh defense` (newest release; same flow as `demo`). Migrations run when the containers start. Installing or changing the package is a separate step.

### Changing the package after it is installed

There is no upgrade. A re-run of `--apply` creates only what is missing (objects, properties, options, labels, records, views by slug) and reports the rest as `exists`; it never changes an existing view, property or menu. So every manifest change that touches something already on a tenant has to be made there by hand too: properties with the MCP property tools or Settings, views with `save_view_draft` and `publish_view` (or the view editor), the menu in Settings, Navigation or `PUT /v1/ui/nav/default`. Do both: change the manifest so new installs are right, and change each live tenant.

Rules the installer enforces that are easy to trip on:

- In view files, `{{code:<object>}}` and `{{id:<object>}}` become the tenant's object code and id column, because custom objects get their codes at install.
- Every view query is checked with `meta.analyze_view_query` inside the install transaction. A dry run that plans new properties skips that check ("queries are checked when installing").
- `compileSource` refuses code that compiles but does not parse (sucrase alone let an `await` in a non-async arrow through).
- View icons, menu section icons and `nav` shapes are checked (`checkNav`). `nav.bottom` is the whole phone hotbar: `menu` or `home` first, at most 4 items before Search (`HOTBAR_MAX` in `api/src/routes/ui.ts`). `nav.bottom_left` is refused.
- A user dropdown with `auto_append_users` on the `users` object itself breaks creating users (core bug, still there); the manifest check refuses it, which is why "reports to" is `teams.lead`.
- `publish_views: true` publishes new package views, and publishes the package's own never-published drafts.

## Data model

### Custom objects

| Object | Holds | Notable properties |
|---|---|---|
| `partnerships` | Teaming partners, VARs, distributors, alliances | partner_type, product_category, status (pill, default prospecting), agreement_type, agreement and renewal dates, rationale, value_to_us, value_to_partner, gaps_addressed, still_needed, notes, owner |
| `oem_integrations` | Integration work with OEM partners | integration_type, status (pill), priority, target_completion, go_live_date, description, value_proposition, next_steps, notes, owner, contact_name, contact_email |
| `proposals` | RFP, RFQ and RFI responses (shown by the `rfp-generator` view) | solicitation_number, contract_type, status (pill), due_date, estimated_value, template (file), ai_context, content (markdown), fit_evaluation (markdown), owner |
| `boms` | A product's bill of materials; parts are its line items | product_category, total_cogs, target_margin, bom_file (up to 5 files), notes |
| `trips` | Travel with the itinerary folded in | destination, purpose, status (pill), dates, est_airfare/hotel/meals/other, `est_total` (calculation), travel_poc, ooo_email, approver, approved_date, approval_notes, outbound and return from/to/departs/flight, hotel name/address, check-in/out, owner ("Traveller") |
| `expenses` | Expenses with receipts | amount, expense_date, category, vendor, receipt (up to 3 files), notes, owner ("Spent by") |
| `marketing_materials` | Slick sheets, presentations, posts | material_type, product_category, folder (no options, users add), description, file, notes, owner |
| `documents` | Business documents | doc_type, section, folder (no options, users add), file (1), notes, owner |
| `opportunity_sources` | Where to look for solicitations | url, category, description. 16 seeded records (SAM.gov, DIBBS, NATO NSPA, CanadaBuys and others); 4 have no address, none were checked, and the user chose to keep them as they are (2026-11-18) |
| `leads` | Lead inbox, and where each Opportunity Evaluator run is stored | source, status (pill), solicitation_number, agency, due_date, raw_text, summary, owner, fit_score, fit_risk, fit_evaluation (JSON), requirements_document (file). The user plans to remove this object (noted 2026-11-22); the evaluator's history depends on it, so that needs a new home first |
| `intel_topics` | Topics, competitors and tenders to follow | topic_type, query. Nothing searches them yet |
| `escalations` | Red Star alerts on a deal | roadblocks (multi-select, users can add), status (pill), notified_users (multi-select of users), notes, owner ("Raised by") |

Amounts on trips, expenses, BOMs and product prices are fixed to USD in the property options. Deal amounts are summed from `amount_base` (the base currency, through the core currency rates).

### Properties on native objects

| Object | Added |
|---|---|
| deals | customer_type, product_category, contract_vehicle, region, solicitation_number, pwin (0 to 100), bant_budget/authority/need/timeline (0 to 25 each), `bant_total` (calculation, null when no score is set), bant_answers (JSON), `weighted_amount` (calculation: amount_base x pwin / 100), next_step, next_step_date, loss_reason, loss_notes, description. `close_date` is the expected award date and `owner` the assigned owner |
| contacts | branch (users can add), command_unit, rank, department, customer_type, linkedin_url |
| companies | customer_type, cage_code, uei |
| products | product_category, specifications, key_features, compliance_standards (markdown), spec_documents (up to 20 files), msrp, gsa_price, distributor_price, price_effective_date, price_expiry_date, berry_compliant, country_of_origin, lead_time, target_margin |
| quotes | customer_type, price_list, payment_terms, lead_time, berry_compliant, country_of_origin, shipping_address, ship_length/width/height/weight, ship_units, est_freight (in the quote's currency), notes_terms |
| lines | berry_compliant, lead_time, country_of_origin |
| users | position |
| teams | lead (who the team's members report to) |

Quote and deal discounts (`discount_type`, `discount_value`) are core since migration 0104, not package properties. The defense CRM got them by hand first, as non-native properties, on 2026-11-22.

Trade show follow-up uses the native `marketing_event_participations` fields (priority, follow-up status and date, notes); the package adds nothing there.

### Pipeline, labels, shared list

- Pipeline `defense` ("Defense BD") with 8 stages: Initial discussion, RFI/RFQ/RFP posted, In discussion or review, Passed to VAR or partner, Proposal or quote submitted, Customer review, Awarded (closed, won), Lost (closed). The existing sales stages are scoped to the `sales` pipeline so they do not show on the defense board.
- Association labels: Point of contact (deals to contacts), Partner company (partnerships to companies).
- Shared option list `product_categories`, linked to `product_category` on products, deals, partnerships, BOMs and marketing materials, seeded with Sensor, UAS, CUAS and Contract manufacturing. A value typed on any of the five reaches all of them.
- Dropdown values follow Matt's lists with these changes made on 2026-11-20: deals' RFP contract vehicle and the International customer type were archived on the defense CRM and dropped from the manifest.

## Views

All 18 are published on the defense CRM. "Menu" is where the package's default menu puts them.

| Slug | Menu | What it does | Core features it uses |
|---|---|---|---|
| `command-dashboard` | Dashboard | Pipeline and weighted value, average PWIN, PWIN bands, stage strip, 12-month award forecast by category or customer type, category and region tables, partnership chart, recent deals; Cash flow tab from quotes and invoices | |
| `my-dashboard` | My Dashboard | Per-person cards and quick links, month calendar (next steps, tasks, trips), action items, my opportunities; Training checklist; Achievements and ranks computed from counts | `useViewSetting` |
| `defense-pipeline` | Business Development, Pipeline | Board by stage with drag to move, PWIN band totals, workspace list with a detail panel (contacts, time in stage, escalations), Red Star alert that creates an escalation plus a task for each person notified | `property_history` |
| `partnerships` | Business Development, Partnerships | Partner cards by status and product line, and an OEM integrations board | |
| `quotations` | Business Development, Quotations | Quote Tracker by period (This Month to All Time) with totals; New/Edit Quote builder in Base44's sections (customer, partner/VAR, opportunity, kit BOM link, shipping and terms, notes, optional discount, totals). Lines go through the CRM's line items editor after the quote is saved as a draft. "Sent to customer" stands in for Base44's "PDFs exported" | `editLineItems` |
| `oem-integrations` | Business Development, OEM Integrations | Status counters that filter, cards by status, star toggles high priority; New/Edit opens a side panel beside the cards (full screen on phones, Escape closes) | |
| `defense-reports` | Business Development, Reports | Quick Reports: Base44's six report cards with filters, sent to the `ai-report` integration, shown as a structured report (last one kept per person). Trade Show Follow-Up Plan tab | integration `ai-report`, `property_history`, `useViewSetting` |
| `bant-calculator` | Tools, BANT Calculator | Matt's questions and points; writes the four scores, `bant_answers` and PWIN to a deal, or creates the deal (company, customer type, category, vehicle, stage, value) | |
| `scenario-generator` | Tools, Scenario Generator | BOM cost against bid and competitor price: margin, risk, position, discount table | |
| `rfp-generator` | Tools, RFP Generator | Base44's RFP / RFQ Generator (added 2026-11-24): proposal cards (status, customer organization, type, solicitation, due date, draft preview). The customer organization is the associated company, picked from a list (the newest association wins; the kit cannot remove an association, so changing it leaves the old one) laid out as a workspace since 2026-11-24 (the user's request): proposals in a list on the left (status, customer, type, due date with days left or overdue, draft preview), the open or new proposal in a panel beside it (full screen below 900px, Escape closes) with "Details and draft" (fields, previous proposal template, notes for AI, Generate Proposal with AI, the draft drawn as a serif document page with a word count, a Rendered / Markdown switch and Copy; on a panel 900px or wider the fields and the page sit side by side and scroll apart) and "Product fit" (a catalog product against the proposal, kept in `fit_evaluation` as markdown). Base44's PDF, Email, Share and Delete card buttons are not built (the view frame cannot print, download or email); Open goes to the record page | integrations `rfp-generator` (no n8n workflow yet) and `opportunity-evaluator` |
| `opportunity-evaluator` | Tools, Opp. Evaluator | Catalog by category, Manage Products (feature and compliance chips, spec upload; New/Edit opens a side panel beside the cards), Evaluator (product, optional lead, PDF or text upload plus pasted text) calling `opportunity-evaluator`; result card and History, stored on a `leads` record | integration `opportunity-evaluator`, file upload |
| `product-pricing` | Resources, Product Pricing | MSRP, GSA and distributor prices, margins, expiring price lists | |
| `materials-library` | Resources, Marketing Materials | Marketing materials and documents by folder and type, with upload | file upload |
| `org-chart` | Operations, Team Hierarchy | Customer contacts by organization; our teams under their leads | |
| `operations-bom` | Operations, Operations | BOM cards (COGS, target margin, price and profit at target, parts), margin projection matrix, New/Edit BOM in a side panel beside the list (with its parts, Edit parts opening the CRM line items editor, and the matrix; the address param focus=parts opens the panel at the parts; part cost reads unit_cost, else unit_price, because the seeded BOM lines only have unit_price) with "Read with AI" (PDF or CSV; fills COGS and saves parts as line items; Excel must be saved as CSV) | integration `bom-reader`, file upload |
| `travel-ops` | Operations, Travel Ops | Trips with itinerary, budget against spend and approval; expenses with receipt upload (camera on phones) | file upload |
| `defense-velocity` | not in menu | Days per stage, bottleneck, days to win and lose | `property_history` |
| `opportunity-discovery` | not in menu | Sources directory (opens outside links), lead inbox with push to pipeline, intel topics | `openUrl` / `ExternalLink` |
| `trade-show-follow-up` | not in menu (also a tab in Reports) | People met at events, hottest first, with follow-up buttons | |

The menu also has object links: Contacts, Documents, and the native Card Scanner. Sections: Business Development (briefcase), Tools (wrench), Resources (book-open), Operations (factory). Phone hotbar: Menu, Business Dev (with Command Dashboard and My Dashboard first), Tools, Resources, then Search; Operations is sidebar only.

View conventions used throughout: inputs with a fixed minimum width use `minWidth: 'min(Npx, 100%)'` so they fit a 360px phone. Four stat tiles stack one per row on phones in most views (left as is).

## AI features

Three views call Claude through view integrations that post to n8n. All three n8n workflows are in the n8n folder "Defense CRM", published, and only run when header `X-PCRM-Secret` matches (the secret is in the webhook's "only run if" option and in each CRM integration). The Opportunity Evaluator workflow calls `claude-sonnet-5-5` with the n8n credential "chris claude third-key"; the other two were built the same way (their model was not re-read for this doc).

| CRM integration | n8n workflow (id) | Webhook path | Measured time |
|---|---|---|---|
| `opportunity-evaluator` | Defense CRM: Opportunity evaluator (Claude) (`1xyczu7CKQBGeaC8`) | `/webhook/defense-crm-opportunity-evaluator` | about 18 s for a sample Army RFP PDF |
| `ai-report` | Defense CRM: AI report (Claude) (`x3MlWuI9RPvQnJDy`) | `/webhook/defense-crm-ai-report` | about 11 s for a small pipeline |
| `bom-reader` | Defense CRM: BOM reader (Claude) (`8fkYfbqQSCCygnyE`) | `/webhook/defense-crm-bom-reader` | about 4 s for a 5-part CSV |
| `rfp-generator` | Defense CRM: RFP generator (Claude) (`AK1EOWQW8SFJ9VWF`, built 2026-11-24) | `/webhook/defense-crm-rfp-generator` | about 17 s for a full RFP draft (claude-sonnet-5-5 at effort low, refusal fallback `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, a refusal comes back as `ok: false`; max 6000 tokens, asks for 1,100 to 1,500 words so it stays inside the CRM's 60 s limit; answers `truncated: true` if it hits the cap) |

Since 2026-11-22 the package creates the three CRM integrations itself (manifest `settings` and `integrations`, migration 0111). The installer asks for the **n8n address** (setting `n8n_url`; `--set n8n_url=https://...` on the CLI, `settings` in the API body). Blank: the integrations are skipped, and Opp. Evaluator, Reports and the BOM reader do not work until an install with the address creates them. Given: each url is `<address>/webhook/<path>` above, header `X-PCRM-Secret`, and the install makes one random secret per tenant, shown once (CLI output or the API result's `secret`). Put that value in the "only run if" check of each workflow's webhook. They start off when installed from the CLI (an admin turns them on in Settings, View integrations) and on when an admin signed in to the CRM installs through the API.

The four n8n workflows check one secret, the defense CRM's (the RFP generator copied it 2026-11-24; set 2026-11-22 after v0.2.19 was deployed there and the installer re-created its integrations; the secret is kept in git-ignored `backups/defense_integration_secret_20261122_231542.txt`). Another tenant with its own secret needs its own copy of the workflows, or the webhook check changed to accept that tenant's value too. On the defense CRM the three integrations are installed but off until an admin turns them on.

The card scanner is native, not an integration: Claude Haiku 5.5 with the tenant's Anthropic key (Settings, Card scanner), Tesseract without one. It has Trade Show Mode (pick or create an event and a default priority; each scan also records the participation with that priority). It does not extract branch, command or unit as their own fields; rank goes into the job title.

## Core features the package relies on

All built and on main. Listed so nobody rebuilds them.

| Feature | Where |
|---|---|
| Package install (migration 0091), package views (`publish_views`), package menu (0098) | `api/src/packages.ts` |
| Stage and property history for views (0089) | `view_data.property_history` |
| Per-user view settings (0090) | `useViewSetting`, `/v1/views/:slug/settings` |
| File upload and file properties from views | kit `uploadFile`, `FileInput` (`capture` for phone cameras), `FileImage`, `FileLink`, `openFile` |
| Outside links from views | `openUrl`, `ExternalLink`; the viewer confirms the domain |
| Line items editor from a view | `editLineItems(object, id)` |
| Multi-currency totals (0068a) | `amount_base`, `view_data.convert_currency` |
| Quote PDF and page as Liquid document templates (migration 0080, built-in "Standard quote") | document templates (MCP `save_document_template_draft`, the template editor). The old Settings, Quote document page was removed 2026-11-04. No defense quote template is in the repo (the defense CRM was not checked) |
| Quote, deal and invoice discounts (0104) | `web/src/lib/lines.ts` `parentTotals` |
| Shared option lists (0097) | manifest `option_lists` |
| Sidebar sections with icons and flyouts | `web/src/components/Sidebar.tsx` |
| Email: Gmail and Outlook sending, autolog, Postmark campaigns, notification emails for mentions and tasks | `api/src/mailbox/`, `api/src/email/`, `api/src/notifications/` |

## Still to do

From Matt's app, not built:

- **RFP Generator:** view, n8n workflow and CRM integration are built (2026-11-24). The defense CRM's `rfp-generator` integration was added through the MCP connector and starts off until an admin turns it on (Settings, View integrations). The view does not show `truncated`. No proposal PDF, email or share.
- **Pipeline extras:** "Draft Follow-up" (AI email from outcomes and notes), the email button on cards, quick assign owner and region on cards.
- **Red Star notifications:** an alert creates tasks for the notified people (which can send task notification emails if those are set up); it does not send its own alert.
- **My Dashboard:** no Opportunity Discovery or Intel Feed tabs (discovery is the separate view); no "Ingest from Email" for leads; intel topics are a list only, nothing searches them.
- **Travel Ops:** no AI out-of-office email, no receipt reading (receipt scanning, old 4.6), no approval request export, no CSV or PDF export.
- **PDF and CSV from views:** dashboard PDF, share to team, trip approval PDF. Not checked whether `window.print()` works in the view frame.
- **Documents:** "Email selected" not built (the composer can attach a record's files, but not from a view).
- **Card scanner:** extraction fields are not configurable per package (branch, command or unit, rank).
- **Quote PDF:** quotes use the built-in "Standard quote" Liquid template, which does not show the defense fields (per-line Berry, lead time and origin, payment terms, shipping, freight, kit BOM). Needs a defense quote template, made per tenant or shipped by the package.
- **"PDFs exported" counter** on the Quote Tracker.

Package and installer:

- No upgrade path (version-aware changes to owned items) and no uninstall.
- No manifest keys for document templates or tenant switches (such as turning gamification off).
- The `leads` object's future (see Data model).
- The old worktree `.claude/worktrees/defense-package` can be removed once nobody needs it.

## Reference: Matt's app

Matt's app has 14 record types and these pages (sidebar order). Read 2026-11-03 and again for the Quotations, OEM Integrations, Opportunity Evaluator, Reports and Operations pages on 2026-11-22.

| Group | Page | Here |
|---|---|---|
| | Command Dashboard | `command-dashboard` |
| | My Dashboard (Home, Opportunity Discovery, Intel Feed, Training, Achievements) | `my-dashboard`, `opportunity-discovery` |
| Business Development | Pipeline (board, Opportunity Workspace, Velocity, Draft Follow-up, Red Star) | `defense-pipeline`, `defense-velocity` |
| | Partnerships | `partnerships` |
| | Quotations | `quotations` |
| | OEM Integrations | `oem-integrations` |
| | Reports (six AI reports, Trade Show Follow-Up Plan) | `defense-reports`, `trade-show-follow-up` |
| Tools | BANT Calculator | `bant-calculator` |
| | RFP Generator | `rfp-generator` |
| | Scenario Generator | `scenario-generator` |
| | Opp. Evaluator | `opportunity-evaluator` |
| | Card Scanner (Trade Show Mode) | native Card Scanner |
| Resources | Contacts, Org Chart | Contacts object, `org-chart` |
| | Product Pricing | `product-pricing` |
| | Marketing Materials, Documents | `materials-library`, Documents object |
| Operations | Team Hierarchy | `org-chart` |
| | Operations (BOMs, margins) | `operations-bom` |
| | Travel Ops (trips, itineraries, expenses) | `travel-ops` |

Mapping of his record types: Opportunity to deals; Contact to contacts plus the company; Product and ProductPricing merged into products; Quote to quotes and lines; Cash Flow invoices to invoices; TeamMember to users and teams; trade show events to marketing events; TradeShowFollowUp to marketing event participations; Itinerary folded into trips; the rest are the custom objects above.

**BANT scoring** (as built in `bant-calculator.tsx`; Matt's numbers):

- **Budget (25):** budget exists (5); funding amount (above $5M 10, above $3M 8, above $1M 6, above $500K 4, above $100K 2, else 0); funding line assigned (5); product priority (1st 5, 2nd 3, 3rd 1)
- **Authority (25):** approving officer grade (O-6 15, O-7 12, O-8 9, O-9 6, O-10 3, Civilian/SES/CO 11, unknown 0); contract vehicle identified (yes 10, partial 5, unknown 0)
- **Need (25):** event-based need (10); existing program (none 5, building 3, active 0); incumbent vendor (none 5, weak 3, strong 0); customer product knowledge (qualified operators 5, unqualified 3, none 0)
- **Timeline (25):** 120 to 180 days 25, 6 to 12 months 20, 12 to 18 months 15, 18 to 24 months 10, over 24 months 0

PWIN is set to the BANT total as a percent; reps may override it on the deal.

## Open questions for Matt

- **"CLASSIFIED • FOUO" footer** in his app. Not reproduced. FOUO has been replaced by CUI marking in DoD use, and a label implying the system may hold controlled information is a compliance claim this CRM cannot back. (General guidance, not legal advice.)
- **Export control.** CUAS and UAS products can fall under ITAR or EAR. Should products carry an export classification (USML category or ECCN) and deals an export license status? Not in the package; flagged as a likely need, unverified.
- **Stage list.** His records used two stage sets; the package uses the newer one. Confirm it is final.
- **Gamification.** Achievements and military ranks: wanted by buyers or a demo flourish? They are on for everyone, with no switch.
- **Lead inbox.** If the `leads` object goes, where should evaluator runs and incoming tenders live?
