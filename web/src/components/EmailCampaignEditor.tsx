import { useEffect, useRef, useState } from 'react';
import { Eye, Send, CalendarClock, Ban, RefreshCw } from 'lucide-react';
import { api, getSchema, type CrmRecord, type FilterGroup, type ObjectDef } from '../lib/api';
import { useApp } from '../lib/app-context';
import { FilterBuilder } from './FilterBuilder';
import { DatePicker } from './DatePicker';
import { StatusPill, type Tone } from './settings';
import { confirmDialog } from './confirm';
import '../email.css';

// The middle of an email campaign's record page (api/src/email/campaigns.ts):
// who gets it (filters on contacts, or everyone), a preview drawn for one
// contact, a test to yourself, then send now or schedule. After it goes out,
// the counts. The email itself is the linked email template (right column).

interface Check { ready: boolean; problems: string[]; recipients: number; can_send: boolean }
interface Preview { contact_id: string; to: string | null; subject: string; html: string }
interface Audience { filter_groups?: FilterGroup[]; all_contacts?: boolean }

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
const TONES: Record<string, Tone> = { draft: 'off', scheduled: 'info', sending: 'pending', sent: 'on', canceled: 'warn' };

function parseAudience(v: unknown): Audience {
  if (typeof v !== 'string' || !v.trim()) return { filter_groups: [] };
  try {
    const a = JSON.parse(v) as Audience;
    return a.all_contacts ? { all_contacts: true } : { filter_groups: Array.isArray(a.filter_groups) ? a.filter_groups : [] };
  } catch {
    return { filter_groups: [] };
  }
}

const COUNTS: [string, string][] = [
  ['recipient_count', 'Sent to'], ['delivered_count', 'Delivered'], ['opened_count', 'Opened'], ['clicked_count', 'Clicked'],
  ['replied_count', 'Replied'], ['unsubscribed_count', 'Unsubscribed'], ['bounced_count', 'Bounced'], ['complained_count', 'Marked as spam']
];

export function EmailCampaignEditor({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const p = record.properties;
  const status = first(p.status) ?? 'draft';
  const editable = status === 'draft' || status === 'scheduled';
  const [contacts, setContacts] = useState<ObjectDef | null>(null);
  const [audience, setAudience] = useState<Audience>(() => parseAudience(p.audience));
  const [count, setCount] = useState<{ n: number; sample: { id: string; email: string }[] } | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  const saved = JSON.stringify(parseAudience(p.audience));
  const dirty = JSON.stringify(audience) !== saved;

  useEffect(() => { getSchema('contacts').then(setContacts).catch(() => undefined); }, []);
  useEffect(() => { setAudience(parseAudience(p.audience)); }, [record.id, p.audience]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCheck = () => api<Check>('GET', `/v1/email/campaigns/${record.id}/check`).then(setCheck).catch((e) => setError((e as Error).message));
  useEffect(() => { loadCheck(); }, [record.id, p.audience, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // live size of the audience being edited
  useEffect(() => {
    if (!editable) return;
    const empty = !audience.all_contacts && !(audience.filter_groups?.length);
    if (empty) { setCount(null); setCountError(null); return; }
    const t = setTimeout(() => {
      api<{ count: number; sample: { id: string; email: string }[] }>('POST', '/v1/email/audience', { audience })
        .then((r) => { setCount({ n: r.count, sample: r.sample }); setCountError(null); })
        .catch((e) => { setCount(null); setCountError((e as Error).message); });
    }, 400);
    return () => clearTimeout(t);
  }, [JSON.stringify(audience), editable]); // eslint-disable-line react-hooks/exhaustive-deps

  async function reload() {
    onChanged(await api<CrmRecord>('GET', `/v1/objects/email_campaigns/${record.id}`));
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const saveAudience = () => run('save', async () => {
    const r = await api<CrmRecord>('PATCH', `/v1/objects/email_campaigns/${record.id}`, { properties: { audience: JSON.stringify(audience) } });
    onChanged(r);
    toast('Audience saved.');
  });

  const showPreview = () => run('preview', async () => {
    setPreview(await api<Preview>('POST', `/v1/email/campaigns/${record.id}/preview`, {}));
  });

  const sendTest = () => run('test', async () => {
    const r = await api<{ sent_to: string }>('POST', `/v1/email/campaigns/${record.id}/test`, preview ? { contact_id: preview.contact_id } : {});
    toast(`Test sent to ${r.sent_to}.`);
  });

  const send = (scheduled: boolean) => run(scheduled ? 'schedule' : 'send', async () => {
    const at = scheduled ? new Date(when) : null;
    if (scheduled && (!when || Number.isNaN(at!.getTime()))) throw new Error('Pick a date and time to send it.');
    const n = check?.recipients ?? 0;
    const ok = await confirmDialog(
      scheduled
        ? `Schedule "${String(p.name ?? 'this campaign')}" for ${at!.toLocaleString()}? It goes to the contacts who match the audience then (${n} right now).`
        : `Send "${String(p.name ?? 'this campaign')}" to ${n} contact${n === 1 ? '' : 's'} now? This can't be undone.`,
      { title: scheduled ? 'Schedule campaign' : 'Send campaign', confirmLabel: scheduled ? 'Schedule' : `Send to ${n}` }
    );
    if (!ok) return;
    const r = await api<{ status: string; recipients: number }>('POST', `/v1/email/campaigns/${record.id}/send`, scheduled ? { scheduled_at: at!.toISOString() } : {});
    toast(r.status === 'scheduled' ? 'Campaign scheduled.' : `Sending to ${r.recipients} contacts.`);
    await reload();
  });

  const cancel = () => run('cancel', async () => {
    const ok = await confirmDialog(status === 'sending'
      ? 'Stop sending? Emails already sent stay sent; the rest are not sent.'
      : 'Cancel this campaign? It will not be sent.', { title: 'Cancel campaign', confirmLabel: 'Cancel campaign', danger: true });
    if (!ok) return;
    await api('POST', `/v1/email/campaigns/${record.id}/cancel`);
    toast('Campaign canceled.');
    await reload();
  });

  const refresh = () => run('refresh', async () => {
    await api('POST', `/v1/email/campaigns/${record.id}/refresh`);
    await reload();
  });

  const fit = () => {
    const f = frame.current;
    if (f?.contentDocument?.body) f.style.height = `${Math.min(f.contentDocument.documentElement.scrollHeight + 8, 2400)}px`;
  };

  const sentCounts = status === 'sending' || status === 'sent' || status === 'canceled';

  return (
    <div className="campaign-editor">
      <div className="card">
        <div className="card-head">
          <h3>Campaign</h3>
          <span className="push-right"><StatusPill tone={TONES[status] ?? 'off'}>{status.replace(/^./, (c) => c.toUpperCase())}</StatusPill></span>
        </div>
        {status === 'scheduled' && p.scheduled_at ? <p className="muted">Goes out {new Date(String(p.scheduled_at)).toLocaleString()}.</p> : null}
        {sentCounts && (
          <>
            <div className="campaign-stats">
              {COUNTS.map(([k, label]) => (
                <div key={k} className="campaign-stat"><strong>{Number(p[k] ?? 0).toLocaleString()}</strong><span>{label}</span></div>
              ))}
            </div>
            <p className="small muted">Opens are a rough signal: some mail apps load images for the reader. Clicks and replies are the reliable ones.</p>
            <button className="btn small" disabled={!!busy} onClick={refresh}><RefreshCw size={14} /> Refresh counts</button>
          </>
        )}
        {editable && check && !check.ready && (
          <div className="callout warn">
            <strong>Before it can go out:</strong>
            <ul>{check.problems.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>

      {editable && (
        <div className="card">
          <div className="card-head"><h3>Audience</h3></div>
          <p className="muted">Contacts who opted out of marketing email or have no email address are always left out, and each address gets one copy.</p>
          <label className="campaign-all">
            <input type="checkbox" role="switch" checked={!!audience.all_contacts}
              onChange={(e) => setAudience(e.target.checked ? { all_contacts: true } : { filter_groups: [] })} /> Send to all contacts
          </label>
          {!audience.all_contacts && contacts && (
            <FilterBuilder schema={contacts} groups={audience.filter_groups ?? []} onChange={(g) => setAudience({ filter_groups: g })} />
          )}
          <div className="campaign-count">
            {countError ? <span className="error">{countError}</span>
              : count ? <span><strong>{count.n.toLocaleString()}</strong> contact{count.n === 1 ? '' : 's'} match{count.n === 1 ? 'es' : ''}{count.sample.length ? `, like ${count.sample.slice(0, 3).map((s) => s.email).join(', ')}` : ''}.</span>
              : <span className="muted">Add a filter, or send to all contacts.</span>}
          </div>
          <div className="campaign-actions">
            <button className="btn" disabled={!dirty || !!busy} onClick={() => setAudience(parseAudience(p.audience))}>Discard</button>
            <button className="btn primary" disabled={!dirty || !!busy} onClick={saveAudience}>Save audience</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Email</h3>
          <span className="push-right campaign-actions">
            <button className="btn small" disabled={!!busy} onClick={showPreview}><Eye size={14} /> {preview ? 'Redraw' : 'Preview'}</button>
            {editable && <button className="btn small" disabled={!!busy} onClick={sendTest}><Send size={14} /> Send me a test</button>}
          </span>
        </div>
        {preview ? (
          <>
            <p className="small muted">Drawn for {preview.to ?? `contact ${preview.contact_id}`}. Subject: <strong>{preview.subject}</strong></p>
            <iframe ref={frame} className="campaign-preview" title="Email preview" sandbox="allow-same-origin" srcDoc={preview.html} onLoad={fit} />
          </>
        ) : (
          <p className="muted">The email is the email template linked to this campaign. Preview draws it for a contact in the audience, with the footer and unsubscribe link added.</p>
        )}
      </div>

      {(editable || status === 'sending') && (
        <div className="card">
          <div className="card-head"><h3>Send</h3></div>
          {check && !check.can_send && <p className="muted">Only an admin signed in to the CRM can send or schedule a campaign.</p>}
          {editable && (
            <div className="campaign-send">
              <button className="btn primary" disabled={!!busy || !check?.ready || !check?.can_send || dirty} onClick={() => send(false)}>
                <Send size={14} /> {busy === 'send' ? 'Sending…' : `Send now${check?.ready ? ` to ${check.recipients.toLocaleString()}` : ''}`}
              </button>
              <span className="campaign-or muted">or</span>
              <DatePicker value={when} onChange={setWhen} withTime noPastDays ariaLabel="Send at" />
              <button className="btn" disabled={!!busy || !check?.ready || !check?.can_send || dirty || !when} onClick={() => send(true)}>
                <CalendarClock size={14} /> Schedule
              </button>
            </div>
          )}
          {dirty && <p className="small muted">Save the audience before sending.</p>}
          {(status === 'scheduled' || status === 'sending') && check?.can_send && (
            <button className="btn danger-text" disabled={!!busy} onClick={cancel}><Ban size={14} /> {status === 'sending' ? 'Stop sending' : 'Cancel campaign'}</button>
          )}
        </div>
      )}
    </div>
  );
}
