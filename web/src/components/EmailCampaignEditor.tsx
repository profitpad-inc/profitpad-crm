import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Eye, Send, CalendarClock, Ban, RefreshCw, UserPlus, X } from 'lucide-react';
import { api, type CrmRecord, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { DatePicker } from './DatePicker';
import { StatusPill, type Tone } from './settings';
import { confirmDialog } from './confirm';
import { Select } from './Select';
import { CampaignActivity, FILTER_PARAM } from './CampaignActivity';
import { CampaignSendMore } from './CampaignSendMore';
import { CampaignSendTest } from './CampaignSendTest';
import { CampaignEmails, type CampaignStep } from './CampaignEmails';
import { Loading } from './Loading';
import { primaryValue } from '../lib/multi-values';
import '../email.css';
import '../lists.css';

// The middle of an email campaign's record page (api/src/email/campaigns.ts),
// in tabs (?campaign_tab=):
//   Campaign  status; who gets it (the contact lists linked to it), its emails
//             (CampaignEmails: one or more, each with A/B variants), then send
//             now or schedule. After it goes out, the counts (each opens the
//             Activity tab on those recipients) and Send to more (contacts
//             picked by hand, sent straight away: CampaignSendMore).
//   Activity  who did what (CampaignActivity), once it has gone out.
//   Preview   the email drawn for one contact (drawn on opening the tab), and
//             a test to yourself.
// The email itself is the linked email template (right column).

interface Check { ready: boolean; problems: string[]; recipients: number; can_send: boolean }
interface Preview { contact_id: string; to: string | null; subject: string; html: string; step_id?: string; variant_id?: string }
// a contact the preview can be drawn for
interface DrawFor { id: string; name: string | null; email: string | null }
interface LinkedList { id: string; name: string; member_count: number; list_type: string }
interface SubscriptionType { value: string; label: string; description: string | null }

export const TAB_PARAM = 'campaign_tab';
type CampaignTab = 'campaign' | 'activity' | 'preview';

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
// Scheduling time zone: the picked date and time are a wall clock in this zone
// (the browser's by default), turned into an exact moment before sending.
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [browserZone()];

// "2026-11-30T11:00" read as a wall clock in `zone` (an IANA name) -> Date
function zonedToDate(local: string, zone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return new Date(NaN);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  // how far the zone's clock is ahead of UTC at instant t
  const offset = (t: number) => {
    const v = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute) - t;
  };
  // twice, so a guess on the other side of a DST change settles
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t);
}

// the "Create a contact list" choice in the add-a-list picker
const NEW_LIST = '__new_list';

const TONES: Record<string, Tone> = { draft: 'off', scheduled: 'info', sending: 'pending', sent: 'on', canceled: 'warn' };

// each count, and the Activity filter that lists those recipients
const COUNTS: [string, string, string][] = [
  ['recipient_count', 'Sent to', 'all'], ['delivered_count', 'Delivered', 'delivered'], ['opened_count', 'Opened', 'opened'],
  ['clicked_count', 'Clicked', 'clicked'], ['replied_count', 'Replied', 'replied'], ['unsubscribed_count', 'Unsubscribed', 'unsubscribed'],
  ['bounced_count', 'Bounced', 'bounced'], ['complained_count', 'Marked as spam', 'complained']
];

export function EmailCampaignEditor({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const [params, setParams] = useSearchParams();
  const p = record.properties;
  const status = first(p.status) ?? 'draft';
  const editable = status === 'draft' || status === 'scheduled';
  const sentCounts = status === 'sending' || status === 'sent' || status === 'canceled';
  const tabs: { key: CampaignTab; label: string }[] = [
    { key: 'campaign', label: 'Campaign' },
    ...(sentCounts ? [{ key: 'activity' as const, label: 'Activity' }] : []),
    { key: 'preview', label: 'Preview' }
  ];
  const rawTab = params.get(TAB_PARAM);
  const tab: CampaignTab = tabs.find((t) => t.key === rawTab)?.key ?? 'campaign';
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
  // the campaign's emails (steps) and their variants
  const [steps, setSteps] = useState<CampaignStep[] | null>(null);
  // which email and variant the Preview tab draws ("<step id>:<variant id>", empty: email 1, A)
  const [previewOf, setPreviewOf] = useState('');
  // who the preview is drawn for: the newest 10 in the audience, or contacts
  // found by searching (any contact)
  const [recent, setRecent] = useState<DrawFor[] | null>(null);
  const [whoQuery, setWhoQuery] = useState('');
  const [found, setFound] = useState<DrawFor[] | null>(null);
  const [drawnFor, setDrawnFor] = useState<DrawFor | null>(null);
  const [when, setWhen] = useState('');
  const [zone, setZone] = useState(browserZone);
  const [sendingMore, setSendingMore] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
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
  // contact lists to pick from; looked up again when the window gets focus, so
  // a list made in another tab ("Create a contact list") shows up
  const [choicesKey, setChoicesKey] = useState(0);
  useEffect(() => {
    if (!editable) return;
    const again = () => setChoicesKey((k) => k + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [editable]);
  useEffect(() => {
    if (!editable) return;
    api<SearchResult>('QUERY', '/v1/objects/lists/search', {
      limit: 200, properties: ['name', 'member_count', 'list_type'], sorts: [{ property: 'name', direction: 'asc' }],
      filter_groups: [{ filters: [{ property: 'list_object', operator: 'in', values: ['contacts'] }] }]
    }).then((r) => setChoices(r.results.map((l) => ({
      value: l.id, label: `${String(l.properties.name ?? 'Untitled list')} (${Number(l.properties.member_count ?? 0).toLocaleString()}, ${first(l.properties.list_type) ?? 'dynamic'})`
    })))).catch(() => setChoices([]));
  }, [editable, choicesKey]);
  useEffect(() => {
    api<{ subscription_types: SubscriptionType[] }>('GET', '/v1/email/subscription-types')
      .then((r) => setTypes(r.subscription_types)).catch(() => setTypes([]));
  }, []);
  useEffect(() => { setTopic(savedTopic); }, [record.id, savedTopic]);

  const loadSteps = () => api<{ steps: CampaignStep[] }>('GET', `/v1/email/campaigns/${record.id}/steps`)
    .then((r) => setSteps(r.steps)).catch((e) => setError((e as Error).message));
  useEffect(() => { loadSteps(); }, [record.id, status, String(p.sent_at ?? '')]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // drawn for the contact given, else the one it was last drawn for, else the
  // newest in the audience
  const previewTarget = (of: string) => {
    const [step_id, variant_id] = of ? of.split(':') : [];
    return step_id ? { step_id, variant_id } : {};
  };
  const showPreview = (contactId?: string, of: string = previewOf) => run('preview', async () => {
    const cid = contactId ?? preview?.contact_id;
    setPreview(await api<Preview>('POST', `/v1/email/campaigns/${record.id}/preview`, { ...(cid ? { contact_id: cid } : {}), ...previewTarget(of) }));
  });
  const previewOptions = (steps ?? []).flatMap((st) => st.variants.map((v) => ({
    value: `${st.id}:${v.id}`,
    label: st.variants.length > 1 ? `Email ${st.position}, variant ${v.label}` : `Email ${st.position}`
  })));
  const pickPreview = (of: string) => { setPreviewOf(of); void showPreview(undefined, of); };

  const drawFor = (id: string) => {
    const c = [...(found ?? []), ...(recent ?? [])].find((x) => x.id === id);
    if (c) setDrawnFor(c);
    void showPreview(id);
  };

  const send = (scheduled: boolean) => run(scheduled ? 'schedule' : 'send', async () => {
    const at = scheduled ? zonedToDate(when, zone) : null;
    if (scheduled && (!when || Number.isNaN(at!.getTime()))) throw new Error('Pick a date and time to send it.');
    if (scheduled && at!.getTime() <= Date.now()) throw new Error('That time has already passed. Pick a later one.');
    const n = check?.recipients ?? 0;
    const more = (steps?.length ?? 1) > 1 ? ` Emails 2 to ${steps!.length} follow at their own times.` : '';
    const ab = (steps?.[0]?.variants.length ?? 1) > 1 ? ` Email 1 is an A/B test: its variants go to a test slice first, the winner to the rest.` : '';
    const ok = await confirmDialog(
      scheduled
        ? `Schedule "${String(p.name ?? 'this campaign')}" for ${at!.toLocaleString(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' })} ${zone.replace(/_/g, ' ')}${zone !== browserZone() ? ` (${at!.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} your time)` : ''}? It goes to the contacts in its lists then (${n} right now).${ab}${more}`
        : `Send "${String(p.name ?? 'this campaign')}" to ${n} contact${n === 1 ? '' : 's'} now? This can't be undone.${ab}${more}`,
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

  // each tab switch is its own history entry, so the browser's back button
  // returns to the tab you came from (a count's Activity view, back to Campaign)
  const showTab = (t: CampaignTab, filter?: string) => {
    if (t === tab && !filter) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t === 'campaign') next.delete(TAB_PARAM);
      else next.set(TAB_PARAM, t);
      if (filter === 'all') next.delete(FILTER_PARAM);
      else if (filter) next.set(FILTER_PARAM, filter);
      return next;
    });
  };

  // a count opens the Activity tab on the recipients it counts
  const showActivity = (filter: string) => showTab('activity', filter);

  // the Preview tab draws the email the first time it opens
  useEffect(() => {
    if (tab !== 'preview') return;
    if (!preview && !busy) showPreview();
    if (!recent) {
      api<{ contacts: DrawFor[] }>('GET', `/v1/email/campaigns/${record.id}/preview-contacts`)
        .then((r) => setRecent(r.contacts))
        .catch(() => setRecent([]));
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // searching for who to draw it for looks through every contact
  useEffect(() => {
    const q = whoQuery.trim();
    if (!q) {
      setFound(null);
      return;
    }
    setFound(null);
    const t = setTimeout(() => {
      api<SearchResult>('QUERY', '/v1/objects/contacts/search', { query: q, limit: 10, properties: ['name', 'email'] })
        .then((r) => setFound(r.results.map((c) => ({ id: c.id, name: String(c.properties.name ?? '') || null, email: primaryValue(c.properties.email) }))))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [whoQuery]);

  const whoLabel = (c: DrawFor) => (c.name && c.email ? `${c.name} (${c.email})` : c.name || c.email || c.id);
  const whoChoices = whoQuery.trim() ? found : recent;
  const drawnContact = preview ? [drawnFor, ...(recent ?? [])].find((c) => c?.id === preview.contact_id) : null;
  const whoFace = drawnContact ? whoLabel(drawnContact) : preview?.to ?? `contact ${preview?.contact_id}`;

  const fit = () => {
    const f = frame.current;
    if (f?.contentDocument?.body) f.style.height = `${Math.min(f.contentDocument.documentElement.scrollHeight + 8, 2400)}px`;
  };

  return (
    <div className="campaign-editor">
      <div className="tabs campaign-tabs" role="tablist" aria-label="Campaign">
        {tabs.map((t) => (
          <div key={t.key} className={`tab${tab === t.key ? ' active' : ''}`}>
            <button role="tab" aria-selected={tab === t.key} onClick={() => showTab(t.key)}>{t.label}</button>
          </div>
        ))}
      </div>

      {tab === 'campaign' && <>
      <div className="card">
        <div className="card-head">
          <h3>Campaign</h3>
          <span className="push-right"><StatusPill tone={TONES[status] ?? 'off'}>{status.replace(/^./, (c) => c.toUpperCase())}</StatusPill></span>
        </div>
        {status === 'scheduled' && p.scheduled_at ? <p className="muted">Goes out {new Date(String(p.scheduled_at)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' })}.</p> : null}
        {status === 'sending' && (() => {
          const testing = steps?.find((st) => st.status === 'testing');
          const next = steps?.find((st) => st.status === 'scheduled' && st.scheduled_at);
          return <>
            {testing && <p className="muted">Email {testing.position} is being A/B tested{testing.ab_test?.winner_due_at ? `: the winner goes out ${new Date(testing.ab_test.winner_due_at).toLocaleString()}` : ''}.</p>}
            {next && <p className="muted">Email {next.position} goes out {new Date(next.scheduled_at!).toLocaleString()}.</p>}
          </>;
        })()}
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
            onChange={(v) => {
              if (v === NEW_LIST) window.open('/objects/lists?create=1&create_list_object=contacts', '_blank', 'noopener');
              else if (v) addList(v);
            }}
            options={[
              { value: '', label: choices.some((c) => !listIds.includes(c.value)) ? 'Add a contact list' : 'No other contact lists' },
              ...choices.filter((c) => !listIds.includes(c.value)),
              { value: NEW_LIST, label: '+ Create a contact list (opens a new tab)' }
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

      <CampaignEmails campaignId={record.id} campaignStatus={status} steps={steps}
        defaults={{ subject: String(p.subject ?? ''), preheader: String(p.preheader ?? ''), from_name: String(p.from_name ?? ''), from_address: String(p.from_address ?? '') }}
        audienceSize={editable ? count?.n ?? check?.recipients ?? null : null} canSend={!!check?.can_send}
        onSaved={(st) => { setSteps(st); setPreview(null); loadCheck(); void reload(); }} />

      {(editable || status === 'sending' || status === 'sent') && (
        <div className="card">
          <div className="card-head">
            <h3>Send</h3>
            {(status === 'sending' || status === 'sent') && check?.can_send && (
              <span className="push-right"><button className="btn small" disabled={!!busy} onClick={() => setSendingMore(true)}><UserPlus size={14} /> Send to more</button></span>
            )}
          </div>
          {check && !check.can_send && <p className="muted">Only an admin signed in to the CRM can send or schedule a campaign.</p>}
          {status === 'sent' && check?.can_send && <p className="muted">Sent. Send to more sends it to contacts you pick, straight away.</p>}
          {editable && (
            <div className="campaign-send">
              <button className="btn primary" disabled={!!busy || !check?.ready || !check?.can_send || dirty} onClick={() => send(false)}>
                <Send size={14} /> {busy === 'send' ? 'Sending…' : `Send now${check?.ready ? ` to ${check.recipients.toLocaleString()}` : ''}`}
              </button>
              <span className="campaign-or muted">or</span>
              <DatePicker value={when} onChange={setWhen} withTime noPastDays ariaLabel="Send at" />
              <Select className="campaign-zone" value={zone} onChange={setZone} aria-label="Time zone"
                options={[...(ZONES.includes(zone) ? [] : [zone]), ...ZONES].map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} />
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
      </>}

      {tab === 'activity' && sentCounts && (
        <CampaignActivity campaignId={record.id} emails={steps?.length ?? 1} refreshKey={COUNTS.map(([k]) => String(p[k] ?? '')).join(',')} />
      )}

      {tab === 'preview' && (
      <div className="card">
        <div className="card-head campaign-preview-head">
          <h3>Email</h3>
          {previewOptions.length > 1 && (
            <Select value={previewOf || previewOptions[0].value} onChange={pickPreview} options={previewOptions} disabled={!!busy} aria-label="Which email to draw" />
          )}
          <span className="push-right campaign-actions">
            <button className="btn small" disabled={!!busy} onClick={() => showPreview()}><Eye size={14} /> Redraw</button>
            {editable && <button className="btn small" disabled={!!busy} onClick={() => setSendingTest(true)}><Send size={14} /> Send a test</button>}
          </span>
        </div>
        {error && <div className="error">{error}</div>}
        {preview ? (
          <>
            <div className="campaign-draw-for">
              <span className="small muted">Drawn for</span>
              <Select
                value={preview.contact_id}
                onChange={drawFor}
                options={(whoChoices ?? []).map((c) => ({ value: c.id, label: whoLabel(c) }))}
                loading={whoChoices === null}
                onSearch={setWhoQuery}
                face={whoFace}
                disabled={!!busy}
                aria-label="Draw the email for"
              />
            </div>
            <p className="small muted">Subject: <strong>{preview.subject}</strong></p>
            <iframe ref={frame} className="campaign-preview" title="Email preview" sandbox="allow-same-origin" srcDoc={preview.html} onLoad={fit} />
          </>
        ) : busy === 'preview' ? <Loading /> : (
          <p className="muted">The email is the email template linked to this campaign, drawn for a contact in the audience with the footer and unsubscribe link added.</p>
        )}
      </div>
      )}

      {sendingTest && (
        <CampaignSendTest campaignId={record.id} contactId={preview?.contact_id ?? null} {...previewTarget(previewOf)} onClose={() => setSendingTest(false)} />
      )}

      {sendingMore && (
        <CampaignSendMore campaignId={record.id} campaignName={String(p.name ?? 'this campaign')}
          onClose={() => setSendingMore(false)} onSent={reload} />
      )}
    </div>
  );
}
