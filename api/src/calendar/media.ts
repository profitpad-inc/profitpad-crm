import { pool, withTx } from '../db.js';
import { loadProviders, MailAuthError, providerReady, serviceToken, type ProviderRow } from '../mailbox/providers.js';
import { loadZoom, zoomMeetingId, zoomReady, zoomRecording } from './zoom.js';

// Recordings and transcripts of marked and booked online meetings
// (auth.meeting_media, filled by meetings.ts), when the admin turned on
// "Fetch recordings and transcripts" in Settings → Calendars.
//
//   Zoom:        the org's Server-to-Server app (zoom.ts): the cloud
//                recording's share link and its transcript (VTT).
//   Google Meet: the Meet REST API through the Google service account acting
//                as the organizer (or the calendar's owner), scope
//                meetings.space.readonly: the conference record for the
//                meeting code, its recording's Drive link and its transcript
//                entries.
//   Teams:       Microsoft Graph with the app's token (application permissions
//                OnlineMeetings.Read.All and OnlineMeetingTranscript.Read.All,
//                plus a Teams application access policy for the organizers):
//                the online meeting by join link and its transcript (VTT).
//                Teams recordings stay in Teams (no shareable link).
//
// Tried from 10 minutes after the meeting ends, then every 30 minutes, for a
// day. Saves recording_url and transcript on the calls record.

const meetUrl = () => (process.env.MEET_API_URL ?? 'https://meet.googleapis.com').replace(/\/$/, '');
const graphUrl = () => (process.env.MICROSOFT_GRAPH_URL ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const RETRY_MS = 30 * 60_000;
const GIVE_UP_MS = 24 * 3600_000;
const MAX_TRANSCRIPT = 500_000;

interface Job {
  call_id: string;
  platform: 'zoom' | 'google_meet' | 'teams';
  join_url: string;
  mailbox: string | null;
  ends_at: Date;
  attempts: number;
}

interface Found {
  recordingUrl: string | null;
  transcript: string | null;
  // try again later for what is missing
  more: boolean;
}

// ---- transcripts ----------------------------------------------------------------------

const clock = (t: string) => t.replace(/\.\d+$/, '').replace(/^00:(\d\d:\d\d)$/, '$1');

// A WebVTT transcript as markdown: "**Name** (mm:ss): text", one line per
// turn, consecutive cues of the same speaker joined.
export function vttToMarkdown(vtt: string): string {
  const out: { who: string; at: string; text: string }[] = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(Boolean);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const at = clock(lines[i].split('-->')[0].trim());
    let text = lines.slice(i + 1).join(' ').trim();
    let who = '';
    const voice = text.match(/^<v(?:\.[^ >]*)?\s+([^>]+)>/);
    if (voice) who = voice[1].trim();
    text = text.replace(/<[^>]+>/g, '').trim();
    if (!who) {
      const named = text.match(/^([^:]{1,60}):\s+(.*)$/);
      if (named) {
        who = named[1].trim();
        text = named[2];
      }
    }
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.who === who) last.text += ` ${text}`;
    else out.push({ who, at, text });
  }
  return out.map((x) => `${x.who ? `**${x.who}** ` : ''}(${x.at}): ${x.text}`).join('\n\n').slice(0, MAX_TRANSCRIPT);
}

// ---- Zoom ---------------------------------------------------------------------------------

async function zoomMedia(job: Job): Promise<Found> {
  const z = await loadZoom();
  if (!zoomReady(z)) throw new Error('Zoom is not connected (Settings > Calendars)');
  const { rows } = await pool.query<{ id: string | null }>('select external_meeting_id as id from crm.pc_0030 where pc_0030_id = $1', [job.call_id]);
  const id = rows[0]?.id ?? zoomMeetingId(job.join_url);
  if (!id) return { recordingUrl: null, transcript: null, more: false };
  const rec = await zoomRecording(z, id);
  if (!rec) return { recordingUrl: null, transcript: null, more: true };
  return { recordingUrl: rec.shareUrl, transcript: rec.transcriptVtt ? vttToMarkdown(rec.transcriptVtt) : null, more: rec.processing || !rec.transcriptVtt };
}

// ---- Google Meet ----------------------------------------------------------------------------

async function meetGet<T>(token: string, path: string): Promise<{ status: number; data: T }> {
  const res = await fetch(meetUrl() + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (res.status === 404) return { status: 404, data };
  if (!res.ok) throw new Error(`Google Meet ${path.split('?')[0]}: ${data.error?.message ?? `HTTP ${res.status}`}`);
  return { status: res.status, data };
}

async function meetMedia(job: Job, cfg: ProviderRow): Promise<Found> {
  const code = job.join_url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1]?.toLowerCase();
  if (!code || !job.mailbox) return { recordingUrl: null, transcript: null, more: false };
  const token = await serviceToken(cfg, job.mailbox, 'meet');
  const filter = encodeURIComponent(`space.meeting_code = "${code}"`);
  const { data } = await meetGet<{ conferenceRecords?: { name: string; startTime?: string; endTime?: string }[] }>(token, `/v2/conferenceRecords?filter=${filter}&pageSize=50`);
  // the conference that ran around this meeting's end
  const end = job.ends_at.getTime();
  const record = (data.conferenceRecords ?? [])
    .filter((r) => r.startTime && new Date(r.startTime).getTime() <= end + 3600_000 && new Date(r.startTime).getTime() >= end - 12 * 3600_000)
    .sort((a, b) => Date.parse(b.startTime!) - Date.parse(a.startTime!))[0];
  if (!record) return { recordingUrl: null, transcript: null, more: true };
  if (!record.endTime) return { recordingUrl: null, transcript: null, more: true };

  const { data: recs } = await meetGet<{ recordings?: { state?: string; driveDestination?: { exportUri?: string } }[] }>(token, `/v2/${record.name}/recordings`);
  const recording = (recs.recordings ?? []).find((r) => r.state === 'FILE_GENERATED' && r.driveDestination?.exportUri);
  const { data: trs } = await meetGet<{ transcripts?: { name: string; state?: string }[] }>(token, `/v2/${record.name}/transcripts`);
  const transcripts = trs.transcripts ?? [];
  const ready = transcripts.find((t) => t.state === 'FILE_GENERATED');
  let transcript: string | null = null;
  if (ready) {
    const { data: ps } = await meetGet<{ participants?: { name: string; signedinUser?: { displayName?: string }; anonymousUser?: { displayName?: string }; phoneUser?: { displayName?: string } }[] }>(
      token, `/v2/${record.name}/participants?pageSize=250`
    );
    const names = new Map((ps.participants ?? []).map((p) => [p.name, p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? '']));
    const lines: { who: string; at: string; text: string }[] = [];
    let pageToken = '';
    const startMs = Date.parse(record.startTime!);
    for (let page = 0; page < 40; page++) {
      const { data: es } = await meetGet<{ transcriptEntries?: { participant?: string; text?: string; startTime?: string }[]; nextPageToken?: string }>(
        token, `/v2/${ready.name}/entries?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      );
      for (const e of es.transcriptEntries ?? []) {
        if (!e.text) continue;
        const who = names.get(e.participant ?? '') ?? '';
        const secs = Math.max(0, Math.round((Date.parse(e.startTime ?? '') - startMs) / 1000)) || 0;
        const at = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
        const last = lines[lines.length - 1];
        if (last && last.who === who) last.text += ` ${e.text}`;
        else lines.push({ who, at, text: e.text });
      }
      if (!es.nextPageToken) break;
      pageToken = es.nextPageToken;
    }
    transcript = lines.map((x) => `${x.who ? `**${x.who}** ` : ''}(${x.at}): ${x.text}`).join('\n\n').slice(0, MAX_TRANSCRIPT) || null;
  }
  const waiting = transcripts.some((t) => t.state !== 'FILE_GENERATED') || (recs.recordings ?? []).some((r) => r.state !== 'FILE_GENERATED');
  return { recordingUrl: recording?.driveDestination?.exportUri ?? null, transcript, more: waiting || (!transcript && !recording) };
}

// ---- Teams ----------------------------------------------------------------------------------

async function teamsMedia(job: Job, cfg: ProviderRow): Promise<Found> {
  if (!job.mailbox) return { recordingUrl: null, transcript: null, more: false };
  const token = await serviceToken(cfg, job.mailbox, 'meet');
  const user = `${graphUrl()}/users/${encodeURIComponent(job.mailbox)}`;
  const get = async (url: string, accept = 'application/json') => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      const hint = res.status === 403
        ? ' (the app needs OnlineMeetings.Read.All and OnlineMeetingTranscript.Read.All with admin consent, and a Teams application access policy for the organizer)'
        : '';
      throw new Error(`Microsoft Teams: ${body.error?.message ?? `HTTP ${res.status}`}${hint}`);
    }
    return res;
  };
  const filter = encodeURIComponent(`JoinWebUrl eq '${job.join_url.replace(/'/g, "''")}'`);
  const found = await get(`${user}/onlineMeetings?$filter=${filter}`);
  const meeting = found ? (((await found.json()) as { value?: { id: string }[] }).value ?? [])[0] : undefined;
  if (!meeting) return { recordingUrl: null, transcript: null, more: false };
  const listed = await get(`${user}/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts`);
  const list = listed ? (((await listed.json()) as { value?: { id: string; createdDateTime?: string }[] }).value ?? []) : [];
  const latest = list.sort((a, b) => Date.parse(b.createdDateTime ?? '') - Date.parse(a.createdDateTime ?? ''))[0];
  if (!latest) return { recordingUrl: null, transcript: null, more: true };
  const content = await get(`${user}/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts/${encodeURIComponent(latest.id)}/content?$format=text/vtt`, 'text/vtt');
  const vtt = content ? (await content.text()).slice(0, 2_000_000) : '';
  return { recordingUrl: null, transcript: vtt ? vttToMarkdown(vtt) : null, more: !vtt };
}

// ---- worker --------------------------------------------------------------------------------

async function fetchMedia(job: Job): Promise<Found> {
  if (job.platform === 'zoom') return zoomMedia(job);
  const cfg = (await loadProviders()).get(job.platform === 'google_meet' ? 'google' : 'microsoft');
  if (!providerReady(cfg)) throw new Error(`${job.platform === 'google_meet' ? 'Google' : 'Microsoft'} is not set up in Settings > Mailboxes`);
  try {
    return job.platform === 'google_meet' ? await meetMedia(job, cfg) : await teamsMedia(job, cfg);
  } catch (err) {
    if (err instanceof MailAuthError) throw new Error(err.message);
    throw err;
  }
}

export async function processMediaJob(job: Job): Promise<void> {
  let found: Found | null = null;
  let error: string | null = null;
  try {
    found = await fetchMedia(job);
  } catch (err) {
    error = ((err as Error).message || 'failed').slice(0, 1000);
  }
  if (found && (found.recordingUrl || found.transcript)) {
    await withTx({ actor: 'system:meeting_media', source: 'meeting_media' }, (c) =>
      c.query(
        `update crm.pc_0030 set recording_url = coalesce($2, recording_url), transcript = coalesce($3, transcript)
         where pc_0030_id = $1 and record_status in ('active', 'archived')`,
        [job.call_id, found!.recordingUrl, found!.transcript]
      )
    );
  }
  const giveUp = Date.now() > job.ends_at.getTime() + GIVE_UP_MS;
  const done = (found && !found.more) || giveUp;
  await pool.query(
    `update auth.meeting_media set attempts = attempts + 1, last_error = $2,
       next_try_at = now() + make_interval(secs => $3), done_at = case when $4 then now() else null end
     where call_id = $1`,
    [job.call_id, error ?? (giveUp && !(found?.recordingUrl || found?.transcript) ? 'no recording or transcript was found within a day' : null), RETRY_MS / 1000, done]
  );
}

export async function processDueMedia(log: { error: (o: unknown, m: string) => void }): Promise<void> {
  const { rows } = await pool.query<Job>(
    `update auth.meeting_media m set next_try_at = now() + interval '10 minutes'
     where m.call_id in (select call_id from auth.meeting_media where done_at is null and next_try_at <= now()
                         order by next_try_at limit 10 for update skip locked)
     returning m.call_id, m.platform, m.join_url, m.mailbox, m.ends_at, m.attempts`
  );
  for (const job of rows) await processMediaJob(job).catch((err) => log.error(err, `meeting media: ${job.call_id} failed`));
}
