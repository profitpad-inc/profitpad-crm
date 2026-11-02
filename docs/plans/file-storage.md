# File storage for ProfitPad CRM

Status (2026-11-02): for now files are stored on the API server's disk instead (built, see `docs/architecture.md` "File storage", migration `0025_file_storage.sql`). This R2 plan is for later. Its API (chunked uploads, signed links, public tokens) was built to match, so moving means swapping the disk code in `api/src/files.ts` for R2 calls and copying the bytes. Decided for R2: a separate files domain on Cloudflare; Cloudflare's terms checked, video from R2 allowed. Open: pick and register that domain.

## Context

Files are the next big missing piece (HANDOFF "What's next" item 3: "object storage + signed URLs for `pc_0050` and file properties"). The `files` object (`pc_0050`) and the `file` property type (`text[]` of `pc_0050` ids, `max_files` option, `docs/property-types.md`) already exist, but no bytes are stored anywhere. Goals from the user: extremely cheap, served from close to the viewer, an optional public URL per file, and large files (video) must work.

Today the API runs in Docker on one server behind nginx (`api.test-crm.profitpad.com`), the UI is on GitHub Pages, and `profitpad.com` DNS is at name.com (checked: `NS ns*.name.com`), not Cloudflare.

## Recommendation: Cloudflare R2, files never pass through our server

Why R2:
- Egress is free, which is what matters for video. Storage is $0.015/GB-month, writes $4.50/million, reads $0.36/million; first 10 GB, 1M writes and 10M reads per month free (Cloudflare's R2 pricing page, checked 2026-11-02).
- S3-compatible, so the API uses the standard AWS SDK and the code is portable to B2, Bunny (S3 mode) or S3 later.
- Public files on a custom domain are cached on Cloudflare's edge, so reads come from near the viewer. The bucket itself lives in one region (pick a location hint near most clients).

How bytes move (the API only signs, never streams):
1. Browser asks the API for an upload: `POST /v1/files/uploads` with name, size, type, target record/property. API checks permission, `max_files`, a size cap, creates the `pc_0050` row as `pending`, returns presigned PUT URL(s). Files over ~100 MB use S3 multipart (presigned per part) so a 5 GB video uploads in resumable chunks.
2. Browser uploads straight to R2.
3. Browser calls `POST /v1/files/{id}/complete`; API does a HEAD on the object to confirm size/type, marks it `ready`, attaches the id to the record's file property.
4. Downloads:
   - Private (default): `GET /v1/files/{id}/url` checks record access via existing `recordFilter` (`api/src/auth.ts`) and returns a short-lived presigned GET (supports range requests, so video seeking works).
   - Public (opt-in toggle per file): object is copied/moved under a `public/` prefix served from the separate files domain with long cache headers; the record stores the public URL. Unpublishing deletes the public copy and purges cache.
5. Keys are random (`t/<tenant>/<file id>/<random>`), never the filename, so URLs are not guessable; the original name goes in `Content-Disposition`.

Pieces to build:
- Migration (built as `0025_file_storage.sql` for disk storage): native properties on `pc_0050` (storage key, size, content type, sha256 optional, status pending/ready, is_public, public_url, uploaded_by); a cleanup job target for `pending` rows older than a day (and an R2 lifecycle rule to abort stale multipart uploads).
- `api/src/storage.ts`: S3 client for R2 (env `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `FILES_PUBLIC_BASE`), presign helpers.
- `api/src/routes/files.ts`: uploads, multipart parts, complete, url, publish/unpublish, delete (archive then purge, matching the existing archive/delete rules).
- UI: a file property editor and a Files card on `web/src/pages/RecordPage.tsx` (drag-drop, progress, public toggle, copy link); re-enable `file` in Settings → Properties (`PropertySettings.tsx` currently leaves it out).
- R2 bucket CORS: allow PUT/GET from `test-crm.profitpad.com` and localhost dev.
- Later: quote signatures as files (HANDOFF lists this), thumbnails, Cloudflare Stream if adaptive video streaming is needed (pricing not checked).

## Why not Google Cloud Storage

GCS works technically (V4 signed URLs, resumable uploads, Cloud CDN), and the code would be nearly identical since GCS has an S3-interoperable XML API. The difference is delivery cost, which dominates once video is involved. Third-party figures, not yet checked on Google's own pages:
- Storage about $0.020/GB-month (US Standard), close to R2's $0.015.
- Internet egress about $0.12/GB direct, or about $0.08/GiB through Cloud CDN (NA/EU, first 10 TiB), plus cache fill and lookup fees.
- Cloud CDN also needs an external HTTPS load balancer in front of the bucket, which has its own monthly charge (amount not checked).

Example: 100 GB of video watched 10 times a month = 1 TB out. R2: $0 delivery. GCS: roughly $80 to $120. Storage for the same 100 GB: R2 about $1.35 after the free 10 GB, GCS about $2.

Using Cloudflare also does not mean moving the whole stack: the API, UI and Google sign-in stay where they are. Only DNS (or a separate files domain) would sit on Cloudflare.

## The DNS catch (decided: option B)

An R2 custom domain needs the domain's zone on Cloudflare. `profitpad.com` is on name.com. Options:
- A. Move `profitpad.com` nameservers to Cloudflare (free plan; records copied over, GitHub Pages and the API keep working). Then `files.profitpad.com` is an R2 custom domain with edge caching.
- B. **Chosen.** Use a separate domain on Cloudflare just for files (name not picked yet; `pcrmfiles.com` is only an example, availability not checked), leaving profitpad.com alone. The domain's nameservers point to Cloudflare (free plan), the R2 bucket gets it as a custom domain, and `FILES_PUBLIC_BASE` is set to it. Private files use presigned R2 URLs and do not depend on this domain.
- C. Skip the custom domain: private files only via presigned URLs (works today, no edge cache), public URLs via the `r2.dev` address, which Cloudflare documents as rate-limited and not for production. Fine for testing only.
- D. Bunny Storage + Bunny CDN instead: CNAME at name.com works, storage replicates to multiple regions, but CDN delivery is billed per GB (about $0.01/GB NA/EU per third-party sources, unverified), so video gets costly vs R2.

Checked 2026-11-02 against Cloudflare's own pages:
- Video is allowed. The CDN terms (Service-Specific Terms, Application Services, updated 2026-09-28) say non-Enterprise customers must use specific Paid Services, "(e.g., the Developer Platform, Images, and Stream)", to serve video and other large files via the CDN. The Developer Platform terms (same date) list R2 as part of the Developer Platform and say it "can be used to host content". So video served from R2 is the allowed route; video proxied from our own server through the CDN would not be. Unconfirmed: whether R2 usage that stays inside the free allowance counts as a "Paid Service" (R2 is billed per use, so a billing method on the account is the safe setup).
- A partial (CNAME) setup that keeps DNS at name.com is only available on Business or Enterprise plans, so on the free plan only options A or B give a custom domain.
- Max cacheable file size on Free, Pro and Business is 512 MB. `.mp4`, `.webm`, `.mkv` are cached by default. Files over 512 MB are served from the R2 bucket's region uncached; egress is still free, but they load from one region instead of the edge.
- r2.dev is documented as rate-limited, "intended for non-production traffic", with no caching. So option C is for testing only.
- Range requests (video seeking) on cached custom-domain files were not covered by the pages read; test them during the build.

Sources: cloudflare.com/service-specific-terms-application-services, cloudflare.com/service-specific-terms-developer-platform, developers.cloudflare.com/r2/buckets/public-buckets, developers.cloudflare.com/dns/zone-setups/partial-setup, developers.cloudflare.com/cache/concepts/default-cache-behavior.

## Verification

- Local: run against a real R2 test bucket (or MinIO in Docker for the end-to-end script): upload small file, 1 GB multipart file, abort midway and resume, complete with wrong size refused, private URL expires, user without record access gets 403, public toggle on/off, `max_files` enforced, archive/delete removes the object.
- SQL suite (`./db/test-local.sh`), API typecheck, web build.
- Browser check of the record page upload only when the user asks.
