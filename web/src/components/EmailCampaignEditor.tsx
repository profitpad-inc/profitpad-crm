import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Eye, Send, CalendarClock, Ban, RefreshCw, X } from 'lucide-react';
import { api, type CrmRecord, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { DatePicker } from './DatePicker';
import { StatusPill, type Tone } from './settings';
import { confirmDialog } from './confirm';
import { Select } from './Select';
import { CampaignActivity, FILTER_PARAM } from './CampaignActivity';
import '../email.css';
import '../lists.css';

// The middle of an email campaign's record page (api/src/email/campaigns.ts):
// who gets it (the contact lists linked to it), a preview drawn for one
// contact, a test to yourself, then send now or schedule. After it goes out,
// the counts (each opens the Activity card on those recipients) and who did
// what (CampaignActivity). The email itself is the linked email template (right column).

interface Check { ready: boolean; problems: string[]; recipients: number; can_send: boolean }
interface Preview { contact_id: string; to: string | null; subject: string; html: string }
interface LinkedList { id: string; name: string; member_count: number; list_type: string }
interface SubscriptionType { value: string; label: string; description: string | null }

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
const TONES: Record<string, Tone> = { draft: 'off', scheduled: 'info', sending: 'pending', sent: 'on', canceled: 'warn' };

// each count, and the Activity filter that lists those recipients
const COUNTS: [string, string, string][] = [
  ['recipient_count', 'Sent to', 'all'], ['delivered_count', 'Delivered', 'delivered'], ['opened_count', 'Opened', 'opened'],
  ['clicked_count', 'Clicked', 'clicked'], ['replied_count', 'Replied', 'replied'], ['unsubscribed_count', 'Unsubscribed', 'unsubscribed'],
  ['bounced_count', 'Bounced', 'bounced'], ['complained_count', 'Marked as spam', 'complained']
];

export function EmailCampaignEditor({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const [, setParams] = useSearchParams();
  const p = record.properties;
  const status = first(p.status) ?? 'draft';
  const editable = status === 'draft' || status === 'scheduled';
  // the contact lists it goes to (linked records), and the ones that could be added
  const [lists, setLists] = useState<LinkedList[] | null>(null);
  const [choices, setChoices] = useState<{ value: string; label: string }[]>([]);
  // email subscription types (Settings → Email); null while loading
  const [types, setTypes] = useState<SubscriptionType[] | null>(null);
  const savedTopic = first(p.subscription_type) ?? '';
  const [topic, setTopic] = useState(savedTopic);
  const [count, setCount] = useState<{ n: number; sample: { id: string; email: string }[] } | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  // lists are linked straight away; only the subscription type waits for Save
  const dirty = topic !== savedTopic;
  const listIds = (lists ?? []).map((l) => l.id);

  const loadLists = () => api<CrmRecord>('GET',
    `/v1/objects/email_campaigns/${record.id}?properties=name&associations=lists&association_properties=lists:name,lists:member_count,lists:list_type,lists:list_object`)
    .then((r) => setLists((r.associations?.lists ?? []).map((a) => ({
      id: a.id, name: String(a.properties?.name ?? 'Untitled list'), member_count: Number(a.properties?.member_count ?? 0),
      list_type: first(a.properties?.list_type) ?? 'dynamic'
    }))))
    .catch((e) => setError((e as Error).message));
  useEffect(() => { loadLists(); }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // contact lists to pick from
  useEffect(() => {
    if (!editable) return;
    api<SearchResult>('QUERY', '/v1/objects/lists/search', {
      limit: 200, properties: ['name', 'member_count', 'list_type'], sorts: [{ property: 'name', direction: 'asc' }],
      filter_groups: [{ filters: [{ property: 'list_object', operator: 'in', values: ['contacts'] }] }]
    }).then((r) => setChoices(r.results.map((l) => ({
      value: l.id, label: `${String(l.properties.name ?? 'Untitled list')} (${Number(l.properties.member_count ?? 0).toLocaleString()}, ${first(l.properties.list_type) ?? 'dynamic'})`
    })))).catch(() => setChoices([]));
  }, [editable]);
  useEffect(() => {
    api<{ subscription_types: SubscriptionType[] }>('GET', '/v1/email/subscription-types')
      .then((r) => setTypes(r.subscription_types)).catch(() => setTypes([]));
  }, []);
  useEffect(() => { setTopic(savedTopic); }, [record.id, savedTopic]);

  const loadCheck = () => api<Check>('GET', `/v1/email/campaigns/${record.id}/check`).then(setCheck).catch((e) => setError((e as Error).message));
  useEffect(() => { loadCheck(); }, [record.id, savedTopic, status, listIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // how many contacts the lists reach together, with the type being picked
  useEffect(() => {
    if (!editable || !lists) return;
    if (lists.length === 0) { setCount(null); setCountError(null); return; }
    const t = setTimeout(() => {
      api<{ count: number; sample: { id: string; email: string }[] }>('POST', '/v1/email/audience', { list_ids: listIds, subscription_type: topic || null })
        .then((r) => { setCount({ n: r.count, sample: r.sample }); setCountError(null); })
        .catch((e) => { setCount(null); setCountError((e as Error).message); });
    }, 300);
    return () => clearTimeout(t);
  }, [listIds.join(','), topic, editable, !!lists]); // eslint-disable-line react-hooks/exhaustive-deps

  const addList = (id: string) => run('lists', async () => {
    await api('PUT', `/v1/objects/email_campaigns/${record.id}/associations/lists/${id}`, {});
    await loadLists();
  });

  const removeList = (id: string) => run('lists', async () => {
    await api('DELETE', `/v1/objects/email_campaigns/${record.id}/associations/lists/${id}`);
    await loadLists();
  });

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
    const r = await api<CrmRecord>('PATCH', `/v1/objects/email_campaigns/${record.id}`, {
      properties: { subscription_type: topic ? [topic] : null }
    });
    onChanged(r);
    toast('Subscription type saved.');
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
        ? `Schedule "${String(p.name ?? 'this campaign')}" for ${at!.toLocaleString()}? It goes to the contacts in its lists then (${n} right now).`
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

  // a count opens the Activity card on the recipients it counts
  const showActivity = (filter: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (filter === 'all') next.delete(FILTER_PARAM);
      else next.set(FILTER_PARAM, filter);
      return next;
    }, { replace: true });
    document.getElementById('campaign-activity')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

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
              {COUNTS.map(([k, label, filter]) => (
                <button key={k} type="button" className="campaign-stat" title={`Show who: ${label.toLowerCase()}`} onClick={() => showActivity(filter)}>
                  <strong>{Number(p[k] ?? 0).toLocaleString()}</strong><span>{label}</span>
                </button>
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

      {sentCounts && <CampaignActivity campaignId={record.id} refreshKey={COUNTS.map(([k]) => String(p[k] ?? '')).join(',')} />}

      {editable && (
        <div className="card">
          <div className="card-head"><h3>Audience</h3></div>
          <p className="muted">The campaign goes to the contacts in its lists; dynamic lists are worked out again when it sends. Contacts who opted out of marketing email, unsubscribed from the campaign's subscription type or have no email address are always left out, and each address gets one copy.</p>
          {types && (
            <div className="campaign-type">
              <label htmlFor="campaign-type">Subscription type</label>
              <Select id="campaign-type" value={topic} onChange={setTopic}
                options={[
                  ...(topic ? [] : [{ value: '', label: 'Pick a type', disabled: true }]),
                  ...types.map((t) => ({ value: t.value, label: t.label })),
                  ...(savedTopic && !types.some((t) => t.value === savedTopic) ? [{ value: savedTopic, label: `${savedTopic} (archived)`, disabled: true }] : [])
                ]} />
              <span className="small muted">{types.find((t) => t.value === topic)?.description ?? 'What kind of email this is. The footer names it, and contacts who left it do not get it.'}</span>
            </div>
          )}
          {lists === null ? null : lists.length > 0 && (
            <ul className="campaign-lists">
              {lists.map((l) => (
                <li key={l.id}>
                  <Link to={`/objects/lists/${l.id}`} target="_blank" rel="noopener">{l.name}</Link>
                  <span className="small muted">{l.member_count.toLocaleString()} · {l.list_type}</span>
                  <button className="icon-btn" aria-label={`Remove ${l.name}`} title="Remove this list" disabled={!!busy} onClick={() => removeList(l.id)}><X size={14} /></button>
                </li>
              ))}
            </ul>
          )}
          <Select className="campaign-add-list" value="" aria-label="Add a list" search disabled={!!busy}
            onChange={(v) => v && addList(v)}
            options={[
              { value: '', label: choices.some((c) => !listIds.includes(c.value)) ? 'Add a contact list' : 'No other contact lists (make one under Marketing → Lists)' },
              ...choices.filter((c) => !listIds.includes(c.value))
            ]} />
          <div className="campaign-count">
            {countError ? <span className="error">{countError}</span>
              : count ? <span><strong>{count.n.toLocaleString()}</strong> contact{count.n === 1 ? '' : 's'} can be emailed{count.sample.length ? `, like ${count.sample.slice(0, 3).map((s) => s.email).join(', ')}` : ''}.</span>
              : <span className="muted">Add a contact list.</span>}
          </div>
          {dirty && (
            <div className="campaign-actions">
              <button className="btn" disabled={!!busy} onClick={() => setTopic(savedTopic)}>Discard</button>
              <button className="btn primary" disabled={!!busy} onClick={saveAudience}>Save subscription type</button>
            </div>
          )}
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
          {dirty && <p className="small muted">Save the subscription type before sending.</p>}
          {(status === 'scheduled' || status === 'sending') && check?.can_send && (
            <button className="btn danger-text" disabled={!!busy} onClick={cancel}><Ban size={14} /> {status === 'sending' ? 'Stop sending' : 'Cancel campaign'}</button>
          )}
        </div>
      )}
    </div>
  );
}
