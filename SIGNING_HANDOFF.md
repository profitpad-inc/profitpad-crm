# Quote Signing — Implementation Handoff

**Created:** 2026-11-01  
**Status:** Implemented 2026-11-01 (see HANDOFF.md). Not committed, not browser-tested, 0018 not applied to the server DB. Delete this file once merged.

---

## What this feature is

Adding customer draw-signature + fillable fields + query-param prefill + dual signing (customer first, then optional staff countersignature) to the public quote page (`/p/quote/#key`).

---

## Design decisions (already locked in)

1. **Signature format:** PNG via `canvas.toDataURL('image/png')` — no extra deps, pdfkit can embed directly
2. **No typed-name fallback** — draw only
3. **Signing fields config:** JSON textarea editor card on the quote record page in the CRM (similar to FormBuilder)
4. **Customer-facing status after signing with countersign required:** "Awaiting countersignature"
5. **Who can countersign:** Any staff with edit access to the quote
6. **Canvas size:** 520 × 160 px

---

## Full list of files to create/modify

### New file
- `db/migrations/0018_quote_signing.sql` — new properties + `pending_countersign` status option

### Modified files
| File | What changes |
|---|---|
| `api/src/routes/public.ts` | `SigningField` interface; extend `PublicQuote`; extend `loadPublicQuote` SQL+return; extend `/accept` body (fields + signature_png); new authenticated `POST /v1/objects/quotes/:id/countersign`; `onWrite` hook for `signing_fields` validation |
| `api/src/pdf/quote.ts` | Signature sections at end: customer sig + signed fields + countersig |
| `web/src/public/public-api.ts` | Extend `PublicQuote` interface; extend `respond()` method signature |
| `web/src/public/quote.ts` | `pending_countersign` in STATUS map; import `queryParamsFromLocation`; replace `respondForm` with `respondDecline` + `respondAccept` (multi-step: fields → canvas → submit) |
| `web/src/public/public.css` | Canvas styles (`.pp-sig-*`); `.pp-pill.pending_countersign` amber pill |
| `web/src/pages/RecordPage.tsx` | Update `HIDDEN_PROPS` + `ACTIVITY_PROPS` for quotes; add `CountersignModal` component; add `SigningFieldsEditor` component; wire both into the quote record page right sidebar |

---

## DB migration details — `0018_quote_signing.sql`

New properties on `quotes` (all `p_is_native => true`):

| api_name | type | options | notes |
|---|---|---|---|
| `signing_fields` | `text` | — | JSON array of `{key, label, type, required}` — validated by onWrite hook |
| `signed_fields` | `text` | — | JSON object of customer's filled values, keyed by field key |
| `customer_signature` | `text` | — | PNG data URL |
| `customer_signed_at` | `datetime` | — | |
| `customer_ip` | `text` | `{"single_line": true}` | |
| `requires_countersign` | `dropdown` (single value, `true`/`false`) | — | no checkbox type exists |
| `countersigner_name` | `text` | `{"single_line": true}` | |
| `countersigner_signature` | `text` | — | PNG data URL |
| `countersigned_at` | `datetime` | — | |

Plus add `pending_countersign` to the quotes status dropdown:
```sql
select meta.add_option('pc_0022', 'status', 'pending_countersign', 'Pending countersignature');
```

---

## API logic details

### `signing_fields` validation (onWrite hook, registered at module load in `public.ts`)
- Must be valid JSON array
- Max 20 fields
- Each field: `key` matches `/^[a-z0-9_]{1,64}$/`, `label` 1-200 chars, `type` in `['text','email','date']`, `required` boolean

### `/accept` route changes
- New body fields: `fields?: Record<string, string>`, `signature_png?: string`
- `signature_png` must start with `data:image/png;base64,`, max 200 KB
- Required signing fields validated against `q.signing_fields`
- If `requires_countersign`: status → `pending_countersign`, no `responded_at` set yet
- If not: status → `accepted`, `responded_at = now()`
- Always writes: `customer_signed_at`, `customer_ip`, `customer_signature`, `signed_fields` (JSON stringified)

### `POST /v1/objects/quotes/:id/countersign` (authenticated)
- Body: `{ name: string, signature_png: string }`
- Only works when status is `pending_countersign`
- Sets: `status: 'accepted'`, `responded_at`, `countersigner_name`, `countersigner_signature`, `countersigned_at`
- Returns `{ ok: true }` — CRM reloads record normally

---

## Public quote page flow (quote.ts)

For **decline**: unchanged flow (name, email, reason textarea).

For **accept**: 
1. Name + email inputs (pre-filled from `q.contact` and query params `?name=&email=`)
2. Any `signing_fields` rendered as labeled inputs (pre-filled from query params by field `key`)
3. Signature canvas (520×160, mouse + touch, clear button)
4. Validate: name/email required, required fields, `hasDrawn` must be true
5. `canvas.toDataURL('image/png')` → POST to `/accept` with `{ name, email, fields, signature_png }`

---

## CRM RecordPage changes

### `HIDDEN_PROPS.quotes` — hide from normal property list:
```ts
['public_key', 'signing_fields', 'signed_fields', 'customer_signature', 'countersigner_signature']
```

### `ACTIVITY_PROPS.quotes` — read alongside the record:
```ts
['status', 'responded_at', 'responder_name', 'responder_email', 'decline_reason',
 'customer_signed_at', 'requires_countersign', 'countersigned_at', 'countersigner_name']
```

### Right sidebar additions (quotes only):
1. **`SigningFieldsEditor`** — always shown on quote pages; JSON textarea for `signing_fields`
2. **Countersign card** — shown only when `status === 'pending_countersign'`; button opens `CountersignModal`
3. **`CountersignModal`** — name input + canvas; POSTs to `/v1/objects/quotes/:id/countersign`; on success reloads record

---

## Verification steps (after implementation)

```bash
cd api && npm run typecheck
cd web && npm run build
```

Common TS issues to watch for:
- `PublicQuote` in `public-api.ts` (frontend) vs `public.ts` (backend) are separate types — both need updating
- `respond()` in `publicApi` needs the extended body type to accept `fields` and `signature_png`
- `useRef`, `useCallback` imports in `RecordPage.tsx`
- `CountersignModal` uses `useRef` and `useCallback` — must be imported

---

## What is NOT done yet (future work)

- Storing signatures as file attachments rather than text columns (large data URLs in Postgres)
- Email notification to staff when customer signs (requiring countersign)
- Email notification to customer after countersign
- Per-field validation (email format check on `type: 'email'` signing fields on the client)
- Audit trail page / certificate of completion PDF download

---

## How to resume

1. Check if the subagent (`943a9ac5-21fa-4d26-9392-b46fc762af08`) already completed — check `git status` in the repo.
2. If incomplete, implement each file in the order listed under "Full list of files to create/modify".
3. Run `npm run typecheck` in `api/` and `npm run build` in `web/` after all changes.
4. Delete this file once the feature is merged.
