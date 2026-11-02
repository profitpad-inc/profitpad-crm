# Meeting booker, phase 1

Status: built 2026-11-02, not deployed (see HANDOFF.md and `docs/architecture.md` "Meeting booker" for what was built).

Changes from the plan while building: the migration is `0022` (0021 was taken); time zones use Intl instead of `luxon` (no new dependency); calendar fields on calls are `attendee_name`, `attendee_email`, `meeting_url`, `calendar_provider`, `calendar_event_id` (no `booking_answers`: the answers live in the form submissions and the call's `body`); there is no booking_pages to forms association (the page stores the form ids); meetings and booking pages are system-only links.

## Goal

A CRM user connects their Google or Microsoft calendar and publishes a booking page. A visitor opens `/p/book/#<key>`, sees open times computed from the user's working hours and real calendar busy times, and picks one. The booking page has a regular CRM form before the time picker, after it, or both (two different forms). The result:

- an event on the host's calendar with the visitor invited (the provider sends the invite, which is the only confirmation; no CRM email), with a Google Meet or Teams link when chosen
- each form applied exactly as a normal submission would be (`applySubmission` in `api/src/forms.ts`): contact upserted by email with its properties overwritten by the answers, ticket created if the form maps ticket properties, a `form_submissions` record
- a `calls` record with `call_type = meeting`, `status = scheduled`, linked to the contact, the booking page and the form submission(s)

### In phase 1

- One host per booking page
- Connecting Google and Microsoft calendars, choosing which calendars count as busy and which one gets new events
- Booking page settings: duration, slot step, buffers, minimum notice, how far ahead, daily cap, weekly hours, date overrides, location, form before and/or form after the time picker
- Slot finder and booking with double-booking protection
- Hosted public page (no embed yet)

### Not in phase 1 (phase 2 or 3)

Cancel and reschedule links, reminder emails, embed script, booking from a record page, round robin and team pages, routing from form answers, push webhooks from the providers, syncing changes made on the calendar back to the call.

## Decisions (defaults chosen; change before building if needed)

1. **Booking pages are a native record object** (like `forms`), so they get record pages, permissions, history and the existing `public-link` route. Proposed code `pc_0054`, next to forms (`pc_0052`, `pc_0053`); confirm it is unused before writing the migration.
2. **Calendar connections are separate from sign-in.** Sign-in keeps asking only for `openid email profile`. Connecting a calendar is its own consent with offline access, started from Settings. A user can connect an account that is not their sign-in account.
2a. **Google calendars: profitpad.com accounts only (decided 2026-11-01)**, so Google's app verification is not needed. The consent screen stays **Internal** (`docs/deploy.md` already sets it up that way), and the connect callback also refuses any ID token whose `hd` claim is not `profitpad.com` (`CALENDAR_GOOGLE_DOMAINS`, default `profitpad.com`). Switching to External later means going through verification for the calendar scopes. Microsoft has no such step; `MICROSOFT_ALLOWED_DOMAINS` applies to connections too.
2b. **Booking forms are regular forms (decided 2026-11-01).** A booking page points at up to two `forms` records: `form_before` (shown before the time picker) and `form_after` (shown after). They are applied with the same code as a normal form submit, so contact properties are overwritten the same way. At least one of them must contain the contact `email` field (the form builder already adds and requires it once any contact property is used), because the invite and the contact both need it. Answers from both forms are sent in the one booking request, so nothing is written until a time is booked.
2c. **No CRM confirmation email (decided 2026-11-01)**: the calendar invite is enough.
3. **Refresh tokens are encrypted in the database** with AES-256-GCM using a key from `CALENDAR_TOKEN_KEY` (32 random bytes, base64). Access tokens live only in memory.
4. **Times are stored in UTC.** Each booking page has an IANA time zone for its working hours. Slot math uses `luxon` so daylight saving changes come out right (new API dependency, pin the version at install).
5. **Double booking** is prevented with a Postgres advisory lock per host while booking, plus a live re-check of the provider and of CRM meetings inside that lock.
6. **Ordering on booking:** CRM records are written in a transaction, the provider event is created before commit, and if the provider call fails the transaction rolls back and the visitor is asked to pick again. If the commit fails after the event was made, the event is deleted (best effort, logged).

## Database: `db/migrations/0021_meeting_booker.sql`

(0020 is the OAuth server migration, not committed yet. If its number changes, take the next one.)

### `auth.calendar_connections`

| column | type | notes |
| --- | --- | --- |
| id | bigserial pk | |
| user_id | text | CRM user, same check as `auth.identities` |
| provider | text | `google` or `microsoft` |
| provider_subject | text | `sub` / `oid` of the connected account |
| email | text | account shown in the UI |
| refresh_token_enc | bytea | AES-256-GCM ciphertext (iv + tag + data) |
| scopes | text[] | what was granted |
| busy_calendar_ids | text[] | calendars that count as busy (default: primary) |
| write_calendar_id | text | where new events go (default: primary) |
| status | text | `active`, `needs_reconnect`, `disconnected` |
| last_error | text | last provider error shown in the UI |
| created_at, updated_at, last_used_at | timestamptz | |

Unique on `(user_id, provider, provider_subject)`. Grants: the API role reads and writes; reporting and readers get nothing.

### `booking_pages` object (`pc_0054`)

Created with the native object machinery (the same path `0004` used), properties via `meta.create_property(..., p_is_native => true)`:

- `name`, `description`
- `status`: dropdown `draft`, `published`, `archived`
- `public_key`: same options as forms (`unique`, regex `^[A-Za-z0-9_-]{22,64}$`)
- `host`: user dropdown (`auto_append_users`, single value)
- `duration_minutes`, `slot_step_minutes`, `buffer_before_minutes`, `buffer_after_minutes`, `min_notice_minutes`, `max_days_ahead`, `daily_limit`: numbers, whole, min 0
- `timezone`: text, IANA name, checked by the API
- `availability`: `json_only`, `{"weekly": {"mon": [["09:00","17:00"]], ...}, "overrides": [{"date": "2026-12-24", "ranges": []}]}`
- `location_type`: dropdown `google_meet`, `teams`, `phone`, `in_person`, `custom`
- `location_details`: text
- `form_before_id`, `form_after_id`: text, single line, same style as `form_submissions.form_id`; the API checks each points at a published form, that they differ, and that at least one has the contact `email` field
- `confirmation_message`: text, markdown

### `calls` additions

- `booking_attendee_name`, `booking_attendee_email`: text (from the forms: contact `email`, and `firstname`/`lastname` or the first name-like field)
- `meeting_url`: text, `display: url`
- `calendar_provider`: text; `calendar_event_id`: text (provider event id)
- `booked_via_page`: boolean, so reports can tell booked meetings from logged ones

### Associations

Allow `calls` to `booking_pages`, `calls` to `form_submissions`, and `booking_pages` to `forms` in `meta.association_allowed` (rules from `0016_association_rules.sql`). `calls` to `contacts` should already be allowed; confirm.

### Tests

Add assertions to `db/tests/001_core.sql`: the object and properties exist, the association is allowed, and `auth.calendar_connections` is not readable by the reader role.

## API

### `api/src/secret-box.ts` (new)

`seal(plain: string): Buffer` and `open(sealed: Buffer): string` with AES-256-GCM. The API refuses to start calendar routes (they report "not configured") without `CALENDAR_TOKEN_KEY`.

### `api/src/calendar/connect.ts` (new)

Signed-in routes, same PKCE, state cookie and `toUi` style as `api/src/sso.ts`:

- `GET /v1/calendar/{google|microsoft}/connect` starts consent
  - Google: scopes `openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `access_type=offline`, `prompt=consent` (so a refresh token comes back every time), `include_granted_scopes=true`
  - Microsoft: scopes `openid email offline_access Calendars.ReadWrite`
- `GET /v1/calendar/{provider}/callback` exchanges the code, checks the ID token the way sign-in does, checks the needed scopes were granted, stores the encrypted refresh token, redirects to Settings
- `GET /v1/calendar/connections` lists the user's connections with their calendars (fetched live, cached briefly)
- `PATCH /v1/calendar/connections/:id` sets `busy_calendar_ids` and `write_calendar_id`
- `DELETE /v1/calendar/connections/:id` revokes at Google (`oauth2.googleapis.com/revoke`) and marks it disconnected; Microsoft has no per-token revoke, so just delete the token
- Every connect and disconnect goes to `auth.security_events` via `logEvent`

Scope names, endpoints and quotas should be re-checked against the current Google and Microsoft docs when building.

### `api/src/calendar/providers.ts` (new)

One interface, two implementations:

```ts
interface CalendarProvider {
  accessToken(conn: Connection): Promise<string>;
  listCalendars(conn: Connection): Promise<{ id: string; name: string; primary: boolean }[]>;
  busy(conn: Connection, from: Date, to: Date): Promise<{ start: Date; end: Date }[]>;
  createEvent(conn: Connection, event: NewEvent): Promise<{ id: string; meetingUrl: string | null }>;
  deleteEvent(conn: Connection, id: string): Promise<void>;
}
```

- Google busy: `POST /calendar/v3/freeBusy` with the busy calendar ids
- Microsoft busy: `GET /me/calendars/{id}/calendarView` per busy calendar, keeping events whose `showAs` is not `free` and that are not cancelled
- Google create: `POST /calendar/v3/calendars/{id}/events?conferenceDataVersion=1&sendUpdates=all`, with `conferenceData.createRequest` for Meet
- Microsoft create: `POST /me/calendars/{id}/events` with `isOnlineMeeting: true` and `onlineMeetingProvider: "teamsForBusiness"` for Teams
- Token refresh: an `invalid_grant` answer sets `status = needs_reconnect` and `last_error`
- Base URLs and token URLs can be overridden by env (`GOOGLE_CALENDAR_API_URL`, `MICROSOFT_GRAPH_URL`, existing `GOOGLE_TOKEN_URL`, `MICROSOFT_TOKEN_URL`) so tests can use fake servers, the way the sign-in tests did

### `api/src/calendar/slots.ts` (new, pure)

`computeSlots(page, busy, now, from, to): Date[]`

1. For each day from `from` to `to` in the page time zone, take the override for that date if there is one, else the weekly ranges.
2. Walk each range in `slot_step_minutes` steps; a slot is `[start, start + duration]`.
3. Drop slots that start before `now + min_notice`, after `now + max_days_ahead`, or that overlap any busy interval widened by `buffer_before` and `buffer_after`.
4. Drop whole days that already reached `daily_limit` (counting CRM booked meetings for that host).

No database or network calls, so it is easy to unit test.

### `api/src/routes/booking.ts` (new)

Public routes, under `/v1/public/` so the auth hook skips them, with `rateLimit` like `routes/public.ts`:

- `GET /v1/public/booking/:key`: page title, description, duration, location type, host display name, time zone, theme, and the before and after forms as `publicDefinition()` (plus their custom HTML, if any). 404 unless published and the host has an active connection.
- `GET /v1/public/booking/:key/slots?from&to`: range capped at 31 days. Busy times come from the host's connection (cached 60 seconds per host and range) plus CRM `calls` where the host is owner, status is `scheduled` and the times overlap.
- `POST /v1/public/booking/:key/before`: optional early check of the before form's answers (`cleanAnswers`, required fields, formats) so the visitor sees errors before picking a time. Writes nothing.
- `POST /v1/public/booking/:key/book` with `{ start, before: { values }, after: { values }, tz, page_url, _hp, _elapsed }`:
  1. Validate the honeypot and elapsed time, and each form's values with `cleanAnswers` and the same checks as form submit; 400 with the form and field on errors
  2. Begin transaction, `pg_advisory_xact_lock` on the host
  3. Re-check the exact slot against `computeSlots` with fresh provider busy times and CRM meetings; 409 `slot_taken` if gone
  4. `applySubmission` for the before form, then the after form, in the same transaction: each upserts the contact by email and overwrites the mapped properties (after-form answers win where both set the same property), creates its ticket if mapped, and makes its `form_submissions` record with `origin`, IP, user agent, `page_url`
  5. Create the call: name `"<page name>: <visitor name or email>"`, `call_type = meeting`, `status = scheduled`, `started_at`, `ended_at`, `duration_seconds`, `owner = host`, attendee fields, `booked_via_page = true`; linked to the contact, the booking page and the submission(s)
  6. Create the provider event with the visitor as attendee and the CRM call link in the description; save `calendar_event_id` and `meeting_url` on the call
  7. Commit; on commit failure delete the event
  8. Return start, end, location and meeting link for the confirmation screen

`PUBLIC_PRINCIPAL` gains `pc_0030` create and `pc_0054` read (it already has what forms need: contacts, tickets, form submissions).

The book route does not check `ui.settings.forms.allowed_origins` (that list is for embedded forms on other sites); the hosted `/p/book/` page is on the UI's own origin.

The existing `POST /v1/objects/{object}/:id/public-link` route (`routes/public.ts`) gets `booking_pages` in its object list so the record page can make and regenerate the link.

`docs/architecture.md` and the OpenAPI spec get the new routes.

## Web

### Settings → Account: Calendars card

Connect Google, connect Microsoft, list connections with status (and a Reconnect button when `needs_reconnect`), pick busy calendars and the calendar for new events, disconnect. Shows "Calendar connections are not configured" when the API says so.

### Booking page record page

`web/src/components/BookingPageEditor.tsx`, shown on `booking_pages` records the way `FormBuilder` is shown on forms:

- duration, step, buffers, notice, days ahead, daily cap
- weekly hours grid with several ranges per day, date overrides list
- time zone picker (defaults to the browser's)
- location type and details
- "Form before the time" and "Form after the time" pickers (published forms only), each with an "Open form" link; a warning when neither has the email field
- publish toggle, copy link, a preview of the next few open slots
- warning when the host has no active calendar connection

Add Booking pages to the default sidebar menu (or leave it to the admin "Edit menu"; decide when building).

### Public page `/p/book/#<key>`

New Vite entry `web/p/book/index.html` and `web/src/public/book.ts`, loading no app code, like quote and form pages:

1. Before form, if set, rendered with `form-renderer.ts` (same conditions, phone picker, URL prefill and custom HTML as `/p/form/`), checked through `/before` on Next
2. Month view with days that have open slots
3. Time list for the picked day in the visitor's time zone, with a time zone switcher
4. After form, if set, same renderer; its button says "Book"
5. Confirmation: date, time, location or meeting link, `confirmation_message`; on 409 go back to the time list with a "that time was just taken" note, keeping the form answers

`form-renderer.ts` may need a small change so it can render a form without submitting it (hand its values back to the booking page instead).

The CSP plugin already allows `connect-src` to the API, so nothing changes there.

## Setup outside the code

- Google Cloud console (done 2026-11-01: Calendar API enabled): keep the consent screen Internal, add the calendar scopes to it, and add to the existing Web OAuth client's authorized redirect URIs:
  - `https://api.test-crm.profitpad.com/v1/calendar/google/callback`
  - `http://localhost:5173/v1/calendar/google/callback`
- Azure app registration (done 2026-11-01: `Calendars.ReadWrite` and `offline_access` added): add to the existing Web platform redirect URIs:
  - `https://api.test-crm.profitpad.com/v1/calendar/microsoft/callback`
  - `http://localhost:5173/v1/calendar/microsoft/callback`
  Some tenants require admin consent for `Calendars.ReadWrite`.
- Server `.env`: `CALENDAR_TOKEN_KEY` (generate with `openssl rand -base64 32`). `docs/deploy.md` gets the steps.

## Testing

- Unit tests for `computeSlots`: weekly hours, overrides, buffers, minimum notice, horizon, daily cap, a busy event spanning midnight, and both daylight saving changes (March and November) in `America/Toronto`.
- Fake Google and Microsoft servers (token, freeBusy or calendarView, events) for end-to-end checks against the local copy (`api-local-copy` on :3001, database from `db/test-local.sh`): connect, list calendars, slots, book, event created with the right attendee and time, call and contact written and linked.
- Forms: before only, after only, both (after-form value wins on a shared property), neither form with email (page refuses to publish), a bad answer in the after form (nothing written, slot not taken).
- Google connect with a non-profitpad.com account is refused.
- Concurrency: two simultaneous bookings for the same slot, exactly one gets 201 and the other 409.
- Failure paths: provider down on book (rollback, nothing written), revoked refresh token (connection marked `needs_reconnect`, page shows no slots).
- SQL suite for the migration; `npm run typecheck` and `npm run build`.
- Then one real run with a Google and a Microsoft test account.

## Order of work

1. Migration `0021` and SQL tests
2. `secret-box.ts`, connect routes, Settings Calendars card (can be tried live on its own)
3. `providers.ts` with fake servers
4. `slots.ts` with unit tests
5. Public booking routes, then booking page editor
6. Public `/p/book/` page
7. Docs (`architecture.md`, `deploy.md`, `HANDOFF.md`), deploy, live test

## Answered (2026-11-01)

- Google: profitpad.com accounts only for now, no Google verification.
- No CRM confirmation email; the calendar invite is enough.
- Contact properties: bookings use regular forms (before, after or both), which overwrite contact properties like any form submit.
