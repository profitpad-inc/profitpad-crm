import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { hasPermission, requireRecentSignIn, type Principal } from '../auth.js';
import { logEvent } from '../audit.js';
import { seal, secretBoxReady } from '../secret-box.js';
import {
  GOOGLE_CALENDAR_SCOPES, GOOGLE_MEET_SCOPES, loadProviders, MAIL_PROVIDERS, MICROSOFT_CALENDAR_PERMISSIONS, MICROSOFT_MEETING_PERMISSIONS,
  providerReady, type MailProvider
} from '../mailbox/providers.js';
import { reconcileServiceCalendars } from './meetings.js';
import { forgetZoomToken, loadZoom, testZoom, ZOOM_SCOPES, zoomComplete } from './zoom.js';

// Settings → Meetings (admins): calendars connected for everyone through the
// mailbox service accounts, marking meetings with contacts, recordings and
// transcripts, and the Zoom app. See meetings.ts, media.ts and zoom.ts.

const INTERVALS = [1, 2, 3, 5, 15, 30, 60];
const GUIDISH_RE = /^[A-Za-z0-9_-]{6,100}$/;

function requireAdmin(p: Principal): void {
  if (!hasPermission(p, 'integrations')) throw forbidden('meeting settings need the Integrations permission');
}

async function settingsOut() {
  const providers = await loadProviders();
  const { rows: s } = await pool.query(
    `select log_enabled, interval_min, recordings_enabled, zoom_enabled, zoom_account_id, zoom_client_id,
       zoom_client_secret is not null as has_zoom_secret, zoom_secret_hint, zoom_status, zoom_last_error, zoom_last_checked_at
     from auth.meeting_settings`
  );
  const { rows: calendars } = await pool.query(
    `select c.id::text as id, c.provider, c.email, c.user_id, trim(concat_ws(' ', u.first_name, u.last_name)) as user_name, c.via_service,
       c.status, c.sync_ok_at, c.sync_run_at, c.sync_error, c.sync_needs_permission, c.meetings_logged
     from auth.calendar_connections c left join crm.pc_0000 u on u.pc_0000_id = c.user_id
     where c.status <> 'disconnected' order by lower(c.email), c.id`
  );
  return {
    providers: MAIL_PROVIDERS.map((p: MailProvider) => {
      const r = providers.get(p);
      return {
        provider: p,
        ready: providerReady(r),
        domains: r?.domains ?? [],
        calendar_enabled: r?.calendar_enabled ?? false,
        // The service account's client ID, for Google Admin's Domain-wide delegation.
        client_id: p === 'google' ? r?.google_client_id ?? null : null,
        calendar_scopes: p === 'google' ? GOOGLE_CALENDAR_SCOPES : MICROSOFT_CALENDAR_PERMISSIONS,
        meeting_scopes: p === 'google' ? GOOGLE_MEET_SCOPES : MICROSOFT_MEETING_PERMISSIONS
      };
    }),
    meetings: s[0] ?? null,
    zoom_scopes: ZOOM_SCOPES,
    calendars,
    secrets_ready: secretBoxReady()
  };
}

export async function meetingAdminRoutes(app: FastifyInstance) {
  app.get('/v1/meetings/settings', async (req) => {
    requireAdmin(req.principal!);
    return settingsOut();
  });

  // Connect every user's calendar through this provider's service account.
  app.put<{ Params: { provider: string }; Body: { calendar_enabled?: unknown } }>('/v1/meetings/settings/providers/:provider', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    const prov = req.params.provider as MailProvider;
    if (!MAIL_PROVIDERS.includes(prov)) throw notFound('unknown provider');
    const v = req.body?.calendar_enabled;
    if (typeof v !== 'boolean') throw badRequest('calendar_enabled must be true or false', { property: 'calendar_enabled' });
    if (v && !providerReady((await loadProviders()).get(prov))) throw badRequest('set up this provider in Settings > Mailboxes first');
    await pool.query(`insert into auth.mailbox_providers (provider) values ($1) on conflict do nothing`, [prov]);
    await pool.query(`update auth.mailbox_providers set calendar_enabled = $2, updated_by = $3, updated_at = now() where provider = $1`, [prov, v, p.actor]);
    await reconcileServiceCalendars();
    await logEvent(req, 'calendar.service_changed', { target: { type: 'mail_provider', id: prov }, details: { calendar_enabled: v } });
    return settingsOut();
  });

  // log_enabled, interval_min (1, 2, 3, 5, 15, 30 or 60), recordings_enabled.
  app.put<{ Body: Record<string, unknown> }>('/v1/meetings/settings/meetings', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    const b = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: Record<string, unknown> = {};
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
      changed[col] = v;
    };
    for (const f of ['log_enabled', 'recordings_enabled'] as const) {
      if (b[f] === undefined) continue;
      if (typeof b[f] !== 'boolean') throw badRequest(`${f} must be true or false`, { property: f });
      set(f, b[f]);
    }
    if (b.interval_min !== undefined) {
      if (!INTERVALS.includes(b.interval_min as number)) throw badRequest(`interval_min is one of ${INTERVALS.join(', ')}`, { property: 'interval_min' });
      set('interval_min', b.interval_min);
    }
    if (sets.length) {
      params.push(p.actor);
      await pool.query(`update auth.meeting_settings set ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now()`, params);
      // turning marking on starts each calendar with a full read
      if (changed.log_enabled === true) await pool.query('update auth.calendar_connections set full_scan_at = null, sync_run_at = null');
      await logEvent(req, 'meetings.settings_changed', { details: changed });
    }
    return settingsOut();
  });

  // zoom_account_id, zoom_client_id, zoom_client_secret (null removes), zoom_enabled.
  app.put<{ Body: Record<string, unknown> }>('/v1/meetings/settings/zoom', async (req) => {
    const p = req.principal!;
    requireAdmin(p);
    requireRecentSignIn(p);
    const b = req.body ?? {};
    const cur = await loadZoom();
    const next = {
      zoom_enabled: cur?.zoom_enabled ?? false,
      zoom_account_id: cur?.zoom_account_id ?? null,
      zoom_client_id: cur?.zoom_client_id ?? null,
      zoom_client_secret: cur?.zoom_client_secret ?? null
    };
    let hint: string | null | undefined;
    const changed: Record<string, unknown> = {};
    for (const f of ['zoom_account_id', 'zoom_client_id'] as const) {
      if (b[f] === undefined) continue;
      const v = typeof b[f] === 'string' ? (b[f] as string).trim() : '';
      if (v && !GUIDISH_RE.test(v)) throw badRequest(`That does not look like a Zoom ${f === 'zoom_account_id' ? 'account ID' : 'client ID'}`, { property: f });
      next[f] = v || null;
      changed[f] = next[f];
    }
    if (b.zoom_client_secret !== undefined) {
      if (b.zoom_client_secret === null || b.zoom_client_secret === '') {
        next.zoom_client_secret = null;
        hint = null;
        changed.zoom_client_secret = 'removed';
      } else {
        if (typeof b.zoom_client_secret !== 'string' || b.zoom_client_secret.trim().length < 10 || b.zoom_client_secret.length > 500) {
          throw badRequest('That does not look like a client secret', { property: 'zoom_client_secret' });
        }
        if (!secretBoxReady()) throw new ApiError(503, 'The server cannot store secrets: MASTER_ENCRYPTION_KEY is not set.', 'not_configured');
        const s = b.zoom_client_secret.trim();
        next.zoom_client_secret = seal(s);
        hint = s.slice(-4);
        changed.zoom_client_secret = 'replaced';
      }
    }
    if (b.zoom_enabled !== undefined) {
      if (typeof b.zoom_enabled !== 'boolean') throw badRequest('zoom_enabled must be true or false', { property: 'zoom_enabled' });
      next.zoom_enabled = changed.zoom_enabled = b.zoom_enabled;
    }
    if (next.zoom_enabled && !zoomComplete(next)) throw badRequest('enter the account ID, client ID and client secret first');
    const credentials = ['zoom_account_id', 'zoom_client_id', 'zoom_client_secret'].some((k) => k in changed);
    await pool.query(
      `update auth.meeting_settings set zoom_enabled = $1, zoom_account_id = $2, zoom_client_id = $3, zoom_client_secret = $4,
         zoom_secret_hint = case when $5 then $6 else zoom_secret_hint end,
         zoom_status = case when $7 then 'unchecked' else zoom_status end,
         zoom_last_error = case when $7 then null else zoom_last_error end,
         updated_by = $8, updated_at = now()`,
      [next.zoom_enabled, next.zoom_account_id, next.zoom_client_id, next.zoom_client_secret, hint !== undefined, hint ?? null, credentials, p.actor]
    );
    forgetZoomToken();
    await logEvent(req, 'zoom.settings_changed', { details: changed });
    return settingsOut();
  });

  app.post('/v1/meetings/settings/zoom/test', async (req) => {
    requireAdmin(req.principal!);
    const z = await loadZoom();
    if (!zoomComplete(z)) throw badRequest('save the account ID, client ID and client secret first');
    try {
      const r = await testZoom(z);
      await pool.query(`update auth.meeting_settings set zoom_status = 'ok', zoom_last_error = null, zoom_last_checked_at = now()`);
      return { ok: true, users: r.users, settings: await settingsOut() };
    } catch (err) {
      const message = (err as Error).message;
      await pool.query(`update auth.meeting_settings set zoom_status = 'error', zoom_last_error = $1, zoom_last_checked_at = now()`, [message.slice(0, 1000)]);
      return { ok: false, error: message, settings: await settingsOut() };
    }
  });
}
