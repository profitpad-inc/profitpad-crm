import { pool } from '../db.js';
import { open } from '../secret-box.js';

// Zoom through the organization's Server-to-Server OAuth app
// (auth.meeting_settings, Settings → Calendars): one app for the whole Zoom
// account, no per-user linking. Booking pages make Zoom meetings for their
// host (by the host's address), and marked meetings get their cloud
// recording link and transcript (calendar/media.ts).
//
// The app needs these scopes in the Zoom Marketplace (classic names; Zoom's
// granular scopes have equivalents): meeting:write:admin to make, move and
// delete meetings, user:read:admin to test, cloud_recording:read:admin for
// recordings and transcripts.
//
// Base URLs can be pointed at a fake server for tests (ZOOM_OAUTH_URL,
// ZOOM_API_URL).

const oauthUrl = () => (process.env.ZOOM_OAUTH_URL ?? 'https://zoom.us/oauth/token').replace(/\/$/, '');
const apiUrl = () => (process.env.ZOOM_API_URL ?? 'https://api.zoom.us/v2').replace(/\/$/, '');

export const ZOOM_SCOPES = ['meeting:write:admin', 'user:read:admin', 'cloud_recording:read:admin'];

export interface ZoomSettings {
  zoom_enabled: boolean;
  zoom_account_id: string | null;
  zoom_client_id: string | null;
  zoom_client_secret: Buffer | null;
}

export class ZoomError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

export async function loadZoom(): Promise<ZoomSettings | null> {
  const { rows } = await pool.query<ZoomSettings>('select zoom_enabled, zoom_account_id, zoom_client_id, zoom_client_secret from auth.meeting_settings');
  return rows[0] ?? null;
}

export const zoomComplete = (z: ZoomSettings | null): z is ZoomSettings => !!z && !!(z.zoom_account_id && z.zoom_client_id && z.zoom_client_secret);
export const zoomReady = (z: ZoomSettings | null): z is ZoomSettings => zoomComplete(z) && z.zoom_enabled;

let cached: { id: string; token: string; expires: number } | null = null;

export function forgetZoomToken(): void {
  cached = null;
}

async function token(z: ZoomSettings): Promise<string> {
  const id = `${z.zoom_account_id}:${z.zoom_client_id}`;
  if (cached && cached.id === id && cached.expires > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(`${z.zoom_client_id}:${open(z.zoom_client_secret!)}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(`${oauthUrl()}?grant_type=account_credentials&account_id=${encodeURIComponent(z.zoom_account_id!)}`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(20_000)
    });
  } catch (err) {
    throw new ZoomError(`could not reach Zoom: ${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; reason?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new ZoomError(`Zoom refused the app's account ID, client ID or secret: ${data.reason || data.error || `HTTP ${res.status}`}`, res.status);
  }
  cached = { id, token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function call<T>(z: ZoomSettings, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const t = await token(z);
  let res: Response;
  try {
    res = await fetch(path.startsWith('http') ? path : apiUrl() + path, {
      method,
      headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
  } catch (err) {
    throw new ZoomError(`could not reach Zoom: ${(err as Error).message}`);
  }
  if (res.status === 204) return { status: 204, data: undefined as T };
  const data = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (res.status === 404) return { status: 404, data };
  if (!res.ok) {
    if (res.status === 401) forgetZoomToken();
    const hint = res.status === 400 && /scope/i.test(data.message ?? '') ? ` (the app needs the scopes ${ZOOM_SCOPES.join(', ')})` : '';
    throw new ZoomError(`Zoom ${method} ${path.split('?')[0]} failed: ${data.message ?? `HTTP ${res.status}`}${hint}`, res.status);
  }
  return { status: res.status, data };
}

// Gets a token and lists one user, so the admin sees the app works.
export async function testZoom(z: ZoomSettings): Promise<{ users: number }> {
  const { data } = await call<{ total_records?: number }>(z, 'GET', '/users?page_size=1&status=active');
  return { users: data.total_records ?? 0 };
}

export interface ZoomMeeting {
  id: string;
  joinUrl: string;
}

// A scheduled meeting hosted by the Zoom user with this address.
export async function createZoomMeeting(z: ZoomSettings, host: string, m: { topic: string; agenda: string; start: Date; minutes: number }): Promise<ZoomMeeting> {
  const { status, data } = await call<{ id?: number | string; join_url?: string }>(z, 'POST', `/users/${encodeURIComponent(host)}/meetings`, {
    topic: m.topic.slice(0, 200),
    agenda: m.agenda.slice(0, 2000),
    type: 2,
    start_time: m.start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: m.minutes,
    timezone: 'UTC'
  });
  if (status === 404 || !data.id || !data.join_url) throw new ZoomError(`Zoom has no user ${host} in this account`, 404);
  return { id: String(data.id), joinUrl: data.join_url };
}

export async function moveZoomMeeting(z: ZoomSettings, id: string, start: Date, minutes: number): Promise<void> {
  await call(z, 'PATCH', `/meetings/${encodeURIComponent(id)}`, { start_time: start.toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: minutes, timezone: 'UTC' });
}

export async function deleteZoomMeeting(z: ZoomSettings, id: string): Promise<void> {
  await call(z, 'DELETE', `/meetings/${encodeURIComponent(id)}`);
}

// The numeric meeting ID in a join link (https://x.zoom.us/j/123456789?pwd=...).
export function zoomMeetingId(joinUrl: string): string | null {
  return joinUrl.match(/zoom\.us\/(?:j|w)\/(\d{9,12})/i)?.[1] ?? null;
}

export interface ZoomRecording {
  shareUrl: string | null;
  transcriptVtt: string | null;
  // the recording is still being processed: try again later
  processing: boolean;
}

// The cloud recording of the meeting's latest occurrence, or null when there
// is none (yet).
export async function zoomRecording(z: ZoomSettings, meetingId: string): Promise<ZoomRecording | null> {
  const { status, data } = await call<{ share_url?: string; recording_files?: { file_type?: string; download_url?: string; status?: string }[] }>(
    z, 'GET', `/meetings/${encodeURIComponent(meetingId)}/recordings`
  );
  if (status === 404) return null;
  const files = data.recording_files ?? [];
  const processing = files.some((f) => f.status && f.status !== 'completed');
  const transcript = files.find((f) => f.file_type === 'TRANSCRIPT' && f.download_url && (!f.status || f.status === 'completed'));
  let transcriptVtt: string | null = null;
  if (transcript) {
    const res = await fetch(transcript.download_url!, { headers: { authorization: `Bearer ${await token(z)}` }, signal: AbortSignal.timeout(60_000) });
    if (res.ok) transcriptVtt = (await res.text()).slice(0, 2_000_000);
  }
  return { shareUrl: data.share_url ?? null, transcriptVtt, processing };
}
