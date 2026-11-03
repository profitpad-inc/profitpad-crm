# Defense base package: handoff

What it takes to rebuild Matt's "Signal Flare CRM" prototype (Base44, `https://defenedge-growth-sync.base44.app`) on top of this CRM as the **defense base package**, and which parts need changes to the core product.

Reviewed 2026-11-03 by reading every page, opening every create form and reading the app's own record shapes (Base44 entities). Nothing was saved in Matt's app; the only state changed was the Card Scanner's "Trade Show Mode" switch being flipped on in that browser session.

## Bottom line

- **Almost everything fits the current database model.** Matt's app has 14 record types. 5 map onto native objects (deals, contacts, companies, products, quotes, plus lines and invoices), 1 maps onto marketing events, and the rest become custom objects. None of them need a new kind of storage.
- **Most screens are custom views.** Dashboards, boards, the BANT calculator, the scenario model, the trackers and the calendars only read data and write records, which views already do.
- **The core work splits into two groups:**
  1. Things that make the CRM sellable as niche packages at all: package install, file upload from views, server-side AI calls, outbound email and stage history.
  2. Native features worth building once for every package: the business card scanner (with trade show mode) and receipt scanning, which uses the same pipeline.

---

## 1. What Matt built

### Pages (sidebar order)

| Group | Page | What it does |
|---|---|---|
| | Dashboard ("Command Dashboard") | Region filter; tabs Overview / Cash Flow / Tile View; PDF export; Share to team. KPIs: pipeline value, weighted value (value x PWIN), average PWIN, contacts. PWIN priority bands (High 80%+, Medium 60 to 79, Low 40 to 59, Monitor under 40), stage counts, 12-month award forecast (by product line or customer type), pipeline by product category, regional pipeline, partnership status chart, recent opportunities. Cash Flow tab: quoted, invoiced, pending and paid totals, quote-to-win rate, quotes and invoices table |
| | My Dashboard | Per-user tabs: Home (metric cards, quick links, calendar of next steps and travel, action items, my opportunities), Opportunity Discovery (curated list of solicitation sources such as SAM.gov, DIBBS and NATO NSPA, plus a Lead Inbox with "Ingest from Email"), Intel Feed (tracked topics and competitors, "powered by real-time web search"), Training (38 checklist steps across modules), Achievements (points, military rank progression from Recruit to General, 32 badges). "Customize" picks the metric cards and quick links |
| Business Development | Pipeline | Kanban board by stage plus "Opportunity Workspace" (filterable list with a detail panel). Card actions: quick assign owner and region, email, **Red Star Cluster** escalation. "Velocity": days per stage, bottleneck stage, time to win. "Draft Follow-up": AI email from conversation outcomes, notes, action items and tone |
| | Partnerships | Teaming, VAR and distribution partners by status and product category |
| | Quotations | Quote builder and Quote Tracker (see 2.3) |
| | OEM Integrations | Board by integration status |
| | Reports | Six AI-generated report types (Sales Projection, Pipeline Summary, Win/Loss, Customer Segment, Trade Show Report, BD Activity Summary) with filters; **Trade Show Follow-Up Plan** (prioritized contacts captured in Trade Show Mode) |
| Tools | BANT Calculator | Scores Budget, Authority, Need and Timeline (25 points each, 100 total), derives PWIN, pushes it to the opportunity |
| | RFP Generator | Proposal records; AI drafts a proposal from notes and an optional uploaded template; "Product Fit Evaluation" against a catalog product; PDF, email, share |
| | Scenario Generator | Pick a BOM, quantity, bid price and competitor price; shows margin, risk and competitive position |
| | Opp. Evaluator | Product catalog (description, specs, key features, compliance standards, spec documents) and an AI "fit" check of a product against an uploaded RFP or requirements document |
| | Card Scanner | Upload or photograph a business card, AI extracts the contact. **Trade Show Mode**: pick the event and a default priority (Hot, Warm, Cold); each scan also creates a follow-up item |
| Resources | Contacts | List with customer type filter and an Org Chart (contacts grouped by organization) |
| | Product Pricing | MSRP, GSA and distributor price per product, effective and expiry dates, price sheet upload |
| | Marketing Materials | Folders; slick sheets, presentations, LinkedIn posts, event support, case studies |
| | Documents | Folders; uploaded documents tagged by type and section; email selected documents |
| Operations | Team Hierarchy | Internal team by department (Sales, Marketing, Operations, Leadership) with "reports to" |
| | Operations | BOM records (product, category, total COGS, target margin %, uploaded BOM file); margin projections at discounts |
| | Travel Ops | Trips (estimated budget, approval, AI out-of-office email, approval request export), Itineraries (outbound, return, hotel), Expenses (AI fills fields from a receipt photo), calendar and list, CSV and PDF export |

The sidebar footer says "CLASSIFIED • FOUO". See section 6.

### Matt's record types (Base44 entities)

These are the fields Matt's app stores, read from its API responses and create forms.

| Entity | Fields |
|---|---|
| Opportunity | name, customer_organization, customer_type, product_category, contract_vehicle, region, stage, value, currency, solicitation_number, expected_award_date, owner (name, email), POC (contact link or name, title/rank, email, phone), pwin, bant_total, bant_selections (JSON of the 13 BANT answers), next_step, next_step_date, loss_reason, loss_notes, stage_entered_date, description |
| Contact | full_name, title, organization, department, branch (e.g. USMC, CBP), command_unit, customer_type, country, state_region, address, email, phone, linkedin_url, source, card_image_url, notes |
| Partnership | partner_name, partner_type, product_category, status, contact_name, contact_email, agreement_type, agreement_date, renewal_date, rationale, value_to_us, value_to_partner, gaps_addressed, still_needed, notes |
| OEMIntegration | partner name, integration type, status, priority, contact name and email, target completion, go-live date, description, value proposition, next steps, notes |
| Quote | number, date, valid until, status, currency, logo, customer org, customer type, contact (name, title, email, phone), partner/VAR, shipping address, line items, kit BOM lines, shipping dimensions and weight, estimated freight, Berry compliance, lead time, payment terms, country of origin, notes, discount. The Cash Flow tab adds invoice #, invoice date, due date, invoice status and an "awarded" flag |
| Product | name, category, description, specifications, key features, compliance standards, spec documents, notes |
| ProductPricing | product name, category, SKU, MSRP, GSA price, distributor price, effective date, expiry date, price sheet, notes |
| BOM | product name, category, target margin %, BOM file, total COGS, notes |
| RFPProposal | title, solicitation #, customer org, contract type, status, due date, estimated value, template file, AI context notes, generated content |
| TradeShowFollowUp | contact (copied fields), event_name, priority, status, follow_up_date, notes, card_image_url |
| Trip | trip_name, destination, event_name, start/end dates, purpose, status, estimated airfare/hotel/meals/other, travel POC, OOO email draft, approver, approved date, approval notes |
| Itinerary, Expense | itinerary: trip name, destination, purpose, notes, outbound/return flights, hotel. Expense: description, amount, date, category, vendor, trip, receipt, notes |
| MarketingMaterial, Document | title, type, category or section, folder, description, file, product, event, notes |
| TeamMember | full_name, position, department, phone, email, reports_to |

Dropdown values worth keeping as seeds:

- **Customer type:** Defense, OEM, Public Safety, FED CIV, State or Local
- **Product category:** Sensor, UAS, CUAS, Contract Manufacturing (these are Matt's company's lines, so they are tenant setup, not package defaults)
- **Contract vehicle:** RFI, RFQ, Sole Source, IDIQ, BPA, GSA Schedule, Other
- **Region:** NORAM, Europe, Africa, Middle East, LATAM, Asia
- **Stages:** Initial Discussion, RFI/RFQ/RFP Posted, In Discussion/Review, Passed to VAR or Partner, Proposal/Quotation Submitted, Customer Review, Awarded, Lost. Older records also hold "RFI/RFQ Responded", "Department in Discussion", "Under Review" and "Proposal Submitted", so Matt's stage list has changed over time
- **Contact source:** Business Card Scan, Email Import, Manual Entry, Referral, Event
- **Partner type:** VAR, Teaming, Technology, Distribution, Strategic Alliance, Other. **Partner status:** Active, Pursuing, Prospecting, On Hold, Inactive. **Agreement:** NDA Only, MOU, Teaming Agreement, Reseller Agreement, None
- **OEM integration type:** Software, Hardware, Data, API, Manufacturing, Distribution. **Status:** Scoping, In Development, Testing, Active, On Hold, Cancelled
- **RFP contract type:** RFP, RFQ, RFI, Sources Sought, Other. **Status:** Draft, In Review, Submitted, Awarded, Lost, No Bid
- **Marketing material type:** Product Slick Sheet, Product Presentation, Company Presentation, LinkedIn Post, Event Support, Case Study, Other
- **Quote/invoice status:** Quoted, Invoiced, Pending Invoice, Paid, Overdue, Cancelled
- **Red Star roadblocks:** Need executed NDA, Need technical details / product specs, Awaiting customer product questions, Need pricing approval, Requires legal review, Budget confirmation needed, Need POC / decision-maker contact, Awaiting security clearance / export approval, Need teaming agreement, Customer demo required (plus custom)
- **Conversation outcomes** (follow-up email and trade show report) and **customer feedback themes** (trade show report): long lists on those screens, copy them when building

**BANT scoring** (to copy exactly):
- **Budget (25):** budget exists (5), funding amount (above $5M 10, above $3M 8, above $1M 6, above $500K 4, above $100K 2, else 0), funding line assigned (5), product priority (1st 5, 2nd 3, 3rd 1)
- **Authority (25):** approving officer grade (O-6 15, O-7 12, O-8 9, O-9 6, O-10 3, Civilian/SES/CO 11, unknown 0), contract vehicle identified (10, partial 5, unknown 0)
- **Need (25):** event-based need (10), existing program (none 5, building 3, active 0), incumbent vendor (none 5, weak 3, strong 0), customer product knowledge (qualified operators 5, unqualified 3, none 0)
- **Timeline (25):** 120 to 180 days 25, 6 to 12 months 20, 12 to 18 months 15, 18 to 24 months 10, over 24 months 0

Derived PWIN = the BANT total as a percent.

---

## 2. Data model in this CRM

### 2.1 Native objects reused, with new properties

All of these are `meta.create_property` calls in the package. None change the core.

| Matt's entity | CRM object | Properties to add (api_name: type) |
|---|---|---|
| Opportunity | **deals** (new pipeline `defense` with Matt's stages; set `is_closed`/`is_won` on Awarded and Lost) | `customer_type`: dropdown; `product_category`: dropdown; `contract_vehicle`: dropdown; `region`: dropdown; `solicitation_number`: text; `pwin`: number (percentage, 0 to 100); `weighted_amount`: calculation (amount x pwin / 100); `bant_budget`, `bant_authority`, `bant_need`, `bant_timeline`: number (0 to 25 each); `bant_total`: calculation; `bant_answers`: text (JSON, so the calculator can reload the 13 answers); `next_step`: text; `next_step_date`: date; `loss_reason`: dropdown; `loss_notes`: text; `description`: text. Use `close_date` as the expected award date and `owner` as the assigned owner. The POC is the associated contact (an association label "Point of contact") |
| Contact | **contacts** | `branch`: dropdown (allow_user_add); `command_unit`: text; `rank`: text (Matt mixes rank into the title); `department`: text; `customer_type`: dropdown; `contact_source`: dropdown; `linkedin_url`: text (url); `card_image`: file (max 1). Organization becomes the associated **company**. Address and country are already native |
| (organization) | **companies** | `customer_type`: dropdown; `branch`: dropdown; `cage_code`: text, `uei`: text (DoD and SAM identifiers. Matt did not ask for these; suggested only) |
| Product, ProductPricing | **products** (merge both into one record) | `product_category`: dropdown; `specifications`, `key_features`, `compliance_standards`: text (markdown); `spec_documents`: file; `msrp`, `gsa_price`, `distributor_price`: number (currency); `price_effective_date`, `price_expiry_date`: date; `berry_compliant`: dropdown (yes, no, n/a); `country_of_origin`: dropdown; `lead_time`: text; `target_margin`: number (percentage). `unit_price` and `unit_cost` are already native |
| Quote | **quotes** + **lines** | quotes: `customer_type`, `partner_var` (association to a partnership record), `shipping_address`: text, `ship_length`/`ship_width`/`ship_height`/`ship_weight`: number, `ship_units`: dropdown, `est_freight`: number, `berry_compliant`, `lead_time`, `payment_terms`: dropdown, `country_of_origin`, `notes_terms`: text, `price_list`: dropdown (MSRP, GSA, distributor). lines: `berry_compliant`, `lead_time`, `country_of_origin`. Discount, currency, status, customer link, signing and PDF are already native |
| Cash Flow invoices | **invoices** | already native (number, amount, due date, status). Add `invoice_date` if `created_at` is not good enough. "Awarded/Won" comes from the linked deal's stage |
| Action items | **tasks** | native. The "next step" stays a deal property for the board card; the action item list on My Dashboard reads open tasks plus deals' next steps |
| TeamMember | **users** + **teams** | teams: Sales, Marketing, Operations, Leadership. users: `position`: text, `reports_to`: dropdown (auto_append_users) |
| Trade show (event) | **marketing_events** | native (`event_type`, `location`, `start_at`, `end_at`). Trips link to events |
| TradeShowFollowUp | **marketing_event_participations** (contact to event) | `priority`: dropdown (Hot, Warm, Cold), `follow_up_status`: dropdown (Pending, Contacted, Done), `follow_up_date`: date, `notes`: text. The contact details stay on the contact rather than being copied the way Matt's app copies them |
| Document | **files** | `doc_type`, `section`, `folder`: dropdown; `notes`: text. Only if custom properties on `files` are allowed; otherwise a `documents` custom object with a file property (see 2.2) |

### 2.2 Custom objects

Created with `meta.create_object` in the package.

| Custom object | Properties | Links |
|---|---|---|
| `partnerships` | partner_type, product_category, status, agreement_type, agreement_date, renewal_date, rationale, value_to_us, value_to_partner, gaps_addressed, still_needed, notes | company (the partner), contacts, deals, quotes (as VAR) |
| `oem_integrations` | integration_type, status, priority, target_completion, go_live_date, description, value_proposition, next_steps, notes | company, contacts, products |
| `proposals` (RFP/RFQ) | solicitation_number, contract_type, status, due_date, estimated_value, template: file, ai_context: text, content: text (markdown), fit_evaluation: text (markdown) | deal, company, products |
| `boms` | product_category, total_cogs: number, target_margin: number, bom_file: file, notes. Component rows as **lines** with a custom-object parent (lines already allow one) | product |
| `trips` | destination, purpose, status (Planning, Pending, Approved, ...), start_date, end_date, est_airfare/hotel/meals/other, est_total: calculation, travel_poc: dropdown (users), ooo_email: text, approver_name, approved_date, approval_notes, plus itinerary fields: outbound and return flights (from, to, datetime, flight number) and hotel (name, address, check-in, check-out). Folding itineraries into trips is simpler than Matt's separate entity: his "Add as Trip" button suggests they are the same thing at two stages | marketing event, deals, contacts, users |
| `expenses` | amount, expense_date, category, vendor, receipt: file, notes | trip |
| `marketing_materials` | material_type, category, folder, description, file: file, product_name, event_name, notes | products, marketing events |
| `opportunity_sources` | url, category (Federal, Defense, Intel, Research, International), description. Seed with Matt's 18 sources | none |
| `leads` (Lead Inbox) | source, status (New, Reviewed, Pushed to Pipeline, Pushed to Evaluator, Dismissed), solicitation_number, due_date, raw_text, summary | deal (once pushed) |
| `intel_topics` | topic_type (Topic, Competitor, Tender, Company), query | none |
| `escalations` (Red Star) | roadblocks: dropdown multi (seeded list, allow_user_add), notes, status, notified_users: dropdown multi (users) | deal |
| `training_progress` | user: dropdown (users), step_key: text, completed_at | none |

Achievement points and rank are computed in the view from counts (deals created, deals won, won value, contacts, quotes, BANT scores, partnerships, trips, escalations) and need no storage. If badges should be permanent once earned, add an `achievements` object later.

---

## 3. Custom views

Every item below uses only what views already do: SQL reads, `createRecord` / `updateRecord` / `linkRecords`, `openRecord`, `navigate` and `callIntegration`. Items marked **needs core** depend on section 4.

| View | Content | Depends on |
|---|---|---|
| **Command Dashboard** | Region filter, KPI tiles, PWIN bands, stage strip, award forecast (close_date by month, value or weighted, by product category or customer type), category and region breakdowns, partnership status chart, recent deals. Cash Flow tab from quotes, invoices and payments | PDF export and Share need core (4.4, 4.8) |
| **My Dashboard** | Metric cards, quick links, month calendar (next step dates, tasks, trips), action items, my deals. Tabs: Opportunity Discovery (sources plus Lead Inbox), Intel Feed, Training, Achievements | Lead "Ingest from Email" and Intel Feed need AI (4.2); card and link choices need per-user settings (4.9) |
| **Pipeline board** | Fill view, ScrollX columns per stage of the defense pipeline, cards with PWIN, category, vehicle, owner, next step; quick assign owner and region | none |
| **Opportunity Workspace** | Filter list plus detail panel; "Draft Follow-up" | follow-up draft needs AI (4.2) |
| **Velocity** | Days in each stage, bottleneck, time to win | stage history (4.5) |
| **BANT Calculator** | The scoring form; writes `bant_*`, `bant_answers` and `pwin` to a deal (or creates one) | none |
| **Red Star alert** | Form from a pipeline card: creates an `escalations` record | notifying people needs email or in-app notifications (4.4) |
| **Scenario Generator** | BOM, quantity, bid price, competitor price, then margin, risk and position | none |
| **Opportunity Evaluator** | Product catalog by category, fit evaluation | uploading a requirements document (4.1) and AI (4.2) |
| **RFP Generator** | Proposal list and editor, AI draft, fit evaluation | 4.1 (template upload), 4.2 (AI), proposal PDF (4.8) |
| **Partnerships**, **OEM Integrations** | Category counters, status tabs or a board | none |
| **Quote Tracker** | Period filter, totals, PDFs exported, awarded count | "PDFs exported" needs a counter (4.8) |
| **Product Pricing** | Table with MSRP, GSA and distributor columns | price sheet upload (4.1) |
| **Org Chart** | Contacts grouped by company, filter by customer type | none |
| **Team Hierarchy** | Users by team, reports_to tree | none |
| **Operations (BOM and margins)** | BOM list, margin at a range of discounts | BOM file upload (4.1); parsing the file into lines needs AI (4.2) |
| **Travel Ops** | Trips calendar and list, budget totals, expenses by trip, CSV export | OOO email (4.2); receipt fill (4.6); approval request and PDF export (4.8) |
| **Reports** | Report type picker and filters, sends the filtered rows to an AI integration and shows the result; Trade Show Report; Trade Show Follow-Up Plan (participations by event and priority) | AI (4.2) |
| **Marketing Materials**, **Documents** | Folder tree and list | file upload (4.1); "Email selected" (4.4) |

Quotes are built on the native quote record page (line items editor, PDF, customer link). Matt's quote builder is not rebuilt as a view.

---

## 4. Core CRM changes

### 4.0 Base packages (a must for selling niche packages)
A "package" is a versioned bundle: custom objects, properties and dropdown seeds, pipelines and stages, association labels, views, navigation menus, integrations (as placeholders), email templates and optional sample data. It installs into a tenant in one step and can be upgraded later without overwriting the tenant's own changes. Today all of this is created one call at a time (`meta.*` functions, MCP property and view tools). Needed:
- A package manifest format and an installer, which can run as a series of `meta.*` calls so the database rules still apply.
- Package-owned markers on objects, properties, options and views, so upgrades know what they may change.
- Per-tenant switches for package features such as gamification.

### 4.1 File upload from views
Views cannot upload files, and file properties are not editable from a view (`editable()` in `api/src/native-ui.ts` excludes `file`). Matt uploads a file in eight places: card photo, receipt, BOM file, RFP template, requirements document, price sheet, documents and marketing materials. Needed:
- A kit `uploadFile()` bridge call (and a `FileInput` component) that uploads as the viewer and returns a file id.
- Letting `createRecord` / `updateRecord` set file properties.
- A camera capture option on phones. The view frame is sandboxed with no camera permission, so capture probably has to happen in the parent page (`<input type=file capture>` launched through the bridge).

### 4.2 AI calls
Ten features in Matt's app call an AI model: card scan, receipt fill, follow-up email, RFP draft, product fit, report generation, OOO email, lead extraction from email, BOM parsing and Intel Feed (web search). Two options:
- **No core change:** each one is a view integration posting to an n8n workflow that calls Claude. This works for text in and text out. It does not work for files until integrations can send a file (4.1), and the tenant has to maintain n8n workflows.
- **Core (recommended):** a native AI action. It is a server-side call with prompt templates kept in the package, passes file ids, returns text or JSON, and has per-tenant usage limits and logging. The card scanner and receipts (4.6) need this in any case.

### 4.3 Business card scanner (native, as agreed)
Build into the CRM for every package:
- Capture from the phone camera or upload. Mobile-first, with several cards in a row.
- AI extraction of name, title or rank, organization, department, branch or unit, email, phones, address, website and LinkedIn.
- A review screen before saving.
- Match against existing contacts (email, then name plus company) and companies (domain, then name). Create or update, and link the contact to the company.
- The card image is kept as a file on the contact, and "Source: business card scan" is stamped.
- **Trade show mode:** choose a marketing event and a default priority. Each scan also creates the event participation with priority, follow-up status and a note.
- Package hooks: the defense package adds `branch`, `command_unit` and `rank` to what is extracted, so the extraction field list must come from configuration, not code.

### 4.4 Outbound email and notifications
There is no email sending yet (HANDOFF lists it as a prerequisite for magic links). Matt uses it for:
- Red Star alerts to team members
- "Share" on the dashboard and on proposals
- Emailing documents
- The email button on pipeline cards
- Follow-up drafts
- Trip approval requests

Needed: sending (or at least logging an `emails` activity and opening the user's mail client) and in-app notifications for alerts. Until then, a Red Star alert can create a task for each notified user.

### 4.5 Stage history for views
Velocity (days per stage, bottleneck, time to win) needs when each deal entered each stage. `meta.record_history` has it but is not in `view_data`. Options:
- Expose a filtered, RLS-safe history view (`view_data.property_history` for chosen properties). Preferred, since it also serves any package.
- Or keep a native `stage_entered_at` that the deal trigger stamps when `stage` changes.

### 4.6 Receipt scanning
This is the same pipeline as the card scanner: an image goes in, fields come out for review, and an `expenses` record is created. Build it as a generic "scan to record" flow (image, extraction schema, target object) so cards and receipts share it.

### 4.7 Multi-currency totals
Matt offers 11 currencies on a deal but adds all values together on the dashboard. Deals here have a currency dropdown (USD, CAD today; more are just options). Adding amounts in different currencies needs exchange rates. Decide whether the package shows totals per currency (no core change) or converts them (needs a rates table and a conversion helper in `view_data`).

### 4.8 PDFs
- **Quote PDF:** Matt's quote PDF carries per-line Berry compliance, lead time and country of origin, a kit BOM table, shipping dimensions, payment terms and freight. The native quote PDF (`api/src/pdf/quote.ts`) has fixed columns, so it needs configurable extra columns and sections, driven by the package.
- **Other PDFs:** the dashboard PDF, proposal PDF, trip approval request and Travel Ops export need a "print this view" or "render markdown to PDF" service, because views cannot download files or open print dialogs reliably from the sandboxed frame. (Not verified; check whether `window.print()` works in the view frame.)
- **"PDFs exported" counter on the Quote Tracker:** have the PDF endpoint stamp the quote.

### 4.9 Per-user view settings
My Dashboard's chosen cards and quick links, training progress, and "My Assigned" defaults. Views have no storage (no localStorage). These can be records in a custom object keyed by user (as `training_progress` above). A small generic `user_settings` store per view would be cleaner and reusable.

### 4.10 Smaller items
- **Bulk actions from views:** "Email selected (N)" on documents, pushing leads to the pipeline in bulk. These work one record at a time today; check whether views need a batch call for speed.
- **Opening a link outside the CRM** (Opportunity Discovery sources such as SAM.gov): views cannot navigate their own frame away. Needed: an `openUrl` bridge call that opens a new tab after a check.

---

## 5. Suggested order

1. Package manifest and installer (4.0), built by writing the defense package itself as its first manifest.
2. Native data model: deals pipeline and properties, contacts and companies properties, products merge, quotes and lines properties (2.1).
3. Custom objects (2.2).
4. Views with no core dependency: Pipeline board, BANT Calculator, Command Dashboard (minus PDF and share), Partnerships, OEM Integrations, Scenario Generator, Org Chart, Team Hierarchy, Trade Show Follow-Up Plan.
5. File upload from views (4.1) and native AI actions (4.2).
6. Business card scanner with trade show mode, then receipt scanning on the same pipeline (4.3, 4.6).
7. Stage history (4.5), then Velocity.
8. Email and notifications (4.4), then Red Star alerts, sharing and document email.
9. AI views: RFP Generator, Opportunity Evaluator, Reports, follow-up drafts, Lead Inbox, Intel Feed.
10. Quote PDF columns and print to PDF (4.8), per-user settings (4.9), achievements and training.

## 6. Open questions for Matt

- **"CLASSIFIED • FOUO" banner.** FOUO has been replaced by CUI marking in DoD use. Any label implying the system is cleared to hold controlled information is a compliance claim this CRM cannot back today. Recommend dropping it unless there is a hosting and accreditation plan. (General guidance, not legal advice; confirm with whoever owns compliance.)
- **Export control.** Products like CUAS and UAS can fall under ITAR or EAR. Should the package track export classification (USML category or ECCN) on products and an export license status on deals? Matt did not include it; flagging as a likely need, unverified.
- **PWIN source.** Is PWIN always the BANT total, or can a rep override it? Matt's data has deals with PWIN set and no BANT total, so overrides exist today.
- **Stage list.** Which stage list is final? Matt's records use two different sets.
- **Separate itineraries.** Are itineraries a real separate thing from trips, or can they be merged as proposed?
- **Package defaults.** Product categories (Sensor, UAS, CUAS, Contract Manufacturing) look specific to Matt's company. Confirm they are tenant setup and not package defaults.
- **Gamification.** Are achievements and military ranks wanted by buyers, or a demo flourish? They cost little as a view, but should be a switch.
