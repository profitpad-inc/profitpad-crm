import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Trophy, Copy } from 'lucide-react';
import { api, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { DatePicker } from './DatePicker';
import { Select } from './Select';
import { StatusPill, type Tone } from './settings';
import { confirmDialog } from './confirm';
import { Loading } from './Loading';

// The emails inside a campaign (api/src/email/steps.ts), on its Campaign tab.
// Email 1 goes out when the campaign is sent or scheduled; each later email at
// its own time, to who got email 1 (or those who didn't open / click an
// earlier one). An email with two or more variants is an A/B test: the
// variants go to a test slice, and after the wait the best one goes to the
// rest. An email that has started is read-only and shows each variant's
// results; an admin can pick a test's winner early.

export interface VariantStats {
  recipients: number; sent: number; delivered: number; opened: number; clicked: number; replied: number;
  unsubscribed: number; bounced: number; complained: number;
}
export interface CampaignVariant {
  id: string; label: string; template_id: string | null; template_name: string | null;
  subject: string | null; preheader: string | null; from_name: string | null; from_address: string | null;
  winner: boolean; stats: VariantStats;
}
export interface CampaignStep {
  id: string; position: number; status: string; scheduled_at: string | null; started_at: string | null; sent_at: string | null;
  audience: 'all' | 'not_opened' | 'not_clicked'; audience_step_id: string | null; error: string | null; held: number;
  ab_test: null | {
    test_percent: number; test_wait_minutes: number; win_metric: 'clicks' | 'opens'; test_sent_at: string | null;
    winner_variant_id: string | null; winner_picked_by: string | null; winner_due_at: string | null;
  };
  variants: CampaignVariant[];
}

// what the campaign itself says, shown as each variant's fallback
export interface CampaignDefaults { subject: string; preheader: string; from_name: string; from_address: string }

interface VariantDraft { id?: string; template_id: string; subject: string; preheader: string; from_name: string; from_address: string }
interface StepDraft {
  scheduled_at: string; audience: string; test_percent: number; test_wait_minutes: number; win_metric: 'clicks' | 'opens';
  variants: VariantDraft[];
}

const TONES: Record<string, Tone> = { draft: 'off', scheduled: 'info', testing: 'pending', sending: 'pending', sent: 'on', canceled: 'warn' };
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', scheduled: 'Scheduled', testing: 'A/B testing', sending: 'Sending', sent: 'Sent', canceled: 'Canceled' };
const OPEN = ['draft', 'scheduled'];
const LABELS = ['A', 'B', 'C', 'D', 'E'];
const PERCENTS = [5, 10, 15, 20, 25, 30, 40, 50];
const WAITS: [number, string][] = [[60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [720, '12 hours'], [1440, '1 day'], [2880, '2 days'], [4320, '3 days']];

// "2026-11-27T14:05" in local time, as DatePicker takes it
function toLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const audienceKey = (s: Pick<CampaignStep, 'audience' | 'audience_step_id'>) => (s.audience === 'all' ? 'all' : `${s.audience}:${s.audience_step_id}`);

function draftOf(s: CampaignStep): StepDraft {
  return {
    scheduled_at: toLocal(s.scheduled_at),
    audience: audienceKey(s),
    test_percent: s.ab_test?.test_percent ?? 20,
    test_wait_minutes: s.ab_test?.test_wait_minutes ?? 240,
    win_metric: s.ab_test?.win_metric ?? 'clicks',
    variants: s.variants.map((v) => ({
      id: v.id, template_id: v.template_id ?? '', subject: v.subject ?? '', preheader: v.preheader ?? '',
      from_name: v.from_name ?? '', from_address: v.from_address ?? ''
    }))
  };
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 1000) / 10}%` : '–');
const waitLabel = (m: number) => WAITS.find(([v]) => v === m)?.[1] ?? `${Math.round(m / 60)} hours`;

// how many get the test (at least one per variant), as the API works it out
export function testSize(audience: number, variants: number, percent: number): number {
  if (variants <= 1) return audience;
  return Math.min(audience, Math.max(variants, Math.ceil((audience * percent) / 100)));
}

export function CampaignEmails({ campaignId, campaignStatus, steps, defaults, audienceSize, canSend, onSaved }: {
  campaignId: string;
  campaignStatus: string;
  steps: CampaignStep[] | null;
  defaults: CampaignDefaults;
  // contacts email 1 would go to now (null while unknown)
  audienceSize: number | null;
  canSend: boolean;
  // after any change: the steps as the API answered
  onSaved: (steps: CampaignStep[]) => void;
}) {
  const { toast } = useApp();
  const [templates, setTemplates] = useState<{ value: string; label: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SearchResult>('QUERY', '/v1/objects/email_templates/search', {
      limit: 200, properties: ['name'], sorts: [{ property: 'name', direction: 'asc' }]
    }).then((r) => setTemplates(r.results.map((t) => ({ value: t.id, label: String(t.properties.name ?? 'Untitled template') }))))
      .catch(() => setTemplates([]));
  }, []);

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

  const canAdd = campaignStatus !== 'canceled' && (steps?.length ?? 0) < 20;

  const addStep = () => run('add', async () => {
    const last = steps?.at(-1);
    // a day after the email before it, as a starting point
    const base = last?.started_at ?? last?.scheduled_at;
    const at = base ? new Date(new Date(base).getTime() + 86400_000) : null;
    const body = at && at.getTime() > Date.now() ? { scheduled_at: at.toISOString() } : {};
    const r = await api<{ steps: CampaignStep[] }>('POST', `/v1/email/campaigns/${campaignId}/steps`, body);
    onSaved(r.steps);
    toast(`Email ${r.steps.length} added.`);
  });

  if (!steps) return <div className="card"><Loading /></div>;

  return (
    <div className="card campaign-emails">
      <div className="card-head">
        <h3>Emails</h3>
        <span className="push-right small muted">{steps.length === 1 ? 'One email' : `${steps.length} emails, one after another`}</span>
      </div>
      <p className="muted small">
        Email 1 goes to the campaign's lists when it is sent or scheduled. Later emails go to who got email 1, at their own time.
        Give an email two or more variants to A/B test them: the variants go to a test slice, and the best one goes to everyone else.
      </p>
      {error && <div className="error">{error}</div>}
      {steps.map((s) => (
        <StepPanel key={`${s.id}:${s.status}:${s.variants.map((v) => v.id).join(',')}`} step={s} steps={steps} campaignId={campaignId}
          campaignStatus={campaignStatus} defaults={defaults} templates={templates} audienceSize={audienceSize} canSend={canSend}
          busy={busy} run={run} onSaved={onSaved} />
      ))}
      {canAdd && (
        <div className="campaign-actions">
          <button className="btn" disabled={!!busy} onClick={addStep}><Plus size={14} /> Add another email</button>
        </div>
      )}
    </div>
  );
}

function StepPanel({ step, steps, campaignId, campaignStatus, defaults, templates, audienceSize, canSend, busy, run, onSaved }: {
  step: CampaignStep; steps: CampaignStep[]; campaignId: string; campaignStatus: string; defaults: CampaignDefaults;
  templates: { value: string; label: string }[] | null; audienceSize: number | null; canSend: boolean;
  busy: string | null; run: (label: string, fn: () => Promise<void>) => Promise<void>; onSaved: (steps: CampaignStep[]) => void;
}) {
  const { toast } = useApp();
  const saved = useMemo(() => draftOf(step), [step]);
  const [draft, setDraft] = useState<StepDraft>(saved);
  const [active, setActive] = useState(0);
  const open = OPEN.includes(step.status) && campaignStatus !== 'canceled';
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const v = draft.variants[Math.min(active, draft.variants.length - 1)];
  const ab = draft.variants.length > 1;

  const setVariant = (patch: Partial<VariantDraft>) => setDraft((d) => ({
    ...d, variants: d.variants.map((x, i) => (i === Math.min(active, d.variants.length - 1) ? { ...x, ...patch } : x))
  }));

  const addVariant = () => {
    // starts as a copy of the variant shown, so only what is being tested changes
    setDraft((d) => ({ ...d, variants: [...d.variants, { ...v, id: undefined }] }));
    setActive(draft.variants.length);
  };
  const removeVariant = () => {
    setDraft((d) => ({ ...d, variants: d.variants.filter((_, i) => i !== active) }));
    setActive(0);
  };

  const save = () => run(`save:${step.id}`, async () => {
    const [aud, ref] = draft.audience === 'all' ? ['all', null] : draft.audience.split(':');
    const body: Record<string, unknown> = {
      test_percent: draft.test_percent, test_wait_minutes: draft.test_wait_minutes, win_metric: draft.win_metric,
      variants: draft.variants.map((x) => ({
        ...(x.id ? { id: x.id } : {}), template_id: x.template_id || null, subject: x.subject || null, preheader: x.preheader || null,
        from_name: x.from_name || null, from_address: x.from_address || null
      }))
    };
    if (step.position > 1) {
      if (draft.scheduled_at) {
        const at = new Date(draft.scheduled_at);
        if (Number.isNaN(at.getTime())) throw new Error('Pick a date and time for this email.');
        body.scheduled_at = at.toISOString();
      } else body.scheduled_at = null;
      body.audience = aud;
      body.audience_step_id = ref;
    }
    const r = await api<{ steps: CampaignStep[] }>('PATCH', `/v1/email/campaigns/${campaignId}/steps/${step.id}`, body);
    onSaved(r.steps);
    toast(`Email ${step.position} saved.`);
  });

  const remove = () => run(`remove:${step.id}`, async () => {
    const ok = await confirmDialog(`Remove email ${step.position}? The emails after it move up.`, { title: 'Remove email', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    const r = await api<{ steps: CampaignStep[] }>('DELETE', `/v1/email/campaigns/${campaignId}/steps/${step.id}`);
    onSaved(r.steps);
    toast(`Email ${step.position} removed.`);
  });

  const pickWinner = (variant: CampaignVariant) => run(`winner:${step.id}`, async () => {
    const left = step.held;
    const ok = await confirmDialog(
      `Send variant ${variant.label} to the ${left.toLocaleString()} contact${left === 1 ? '' : 's'} still waiting for email ${step.position}? This ends the test and can't be undone.`,
      { title: 'Pick the winner', confirmLabel: `Send variant ${variant.label}` });
    if (!ok) return;
    const r = await api<{ steps: CampaignStep[] }>('POST', `/v1/email/campaigns/${campaignId}/steps/${step.id}/winner`, { variant_id: variant.id });
    onSaved(r.steps);
    toast(`Variant ${variant.label} is going out to the rest.`);
  });

  // when it goes out, in words
  const when = step.sent_at ? `Sent ${new Date(step.sent_at).toLocaleString()}`
    : step.started_at ? `Started ${new Date(step.started_at).toLocaleString()}`
    : step.position === 1 ? 'Goes out when the campaign is sent or scheduled'
    : step.scheduled_at ? `Goes out ${new Date(step.scheduled_at).toLocaleString()}` : 'No send time yet';

  const earlier = steps.filter((x) => x.position < step.position);
  const audienceOptions = [
    { value: 'all', label: 'Everyone who got email 1' },
    ...earlier.flatMap((x) => [
      { value: `not_opened:${x.id}`, label: `Who didn't open email ${x.position}` },
      { value: `not_clicked:${x.id}`, label: `Who didn't click in email ${x.position}` }
    ])
  ];

  const slice = step.position === 1 && audienceSize !== null && ab ? testSize(audienceSize, draft.variants.length, draft.test_percent) : null;

  return (
    <section className={`campaign-step${open ? '' : ' started'}`} aria-label={`Email ${step.position}`}>
      <div className="campaign-step-head">
        <strong>Email {step.position}</strong>
        <StatusPill tone={TONES[step.status] ?? 'off'}>{STATUS_LABEL[step.status] ?? step.status}</StatusPill>
        {step.variants.length > 1 && <span className="campaign-flag">A/B test · {step.variants.length} variants</span>}
        <span className="small muted">{when}</span>
        {open && step.position > 1 && (
          <button className="icon-btn push-right" aria-label={`Remove email ${step.position}`} title="Remove this email" disabled={!!busy} onClick={remove}><Trash2 size={14} /></button>
        )}
      </div>
      {step.error && <div className="callout warn small">This email did not go out: {step.error} Fix it and give it a new time.</div>}

      {open ? (
        <>
          {step.position > 1 && (
            <div className="field-row">
              <label className="field">
                <span>Send at</span>
                <DatePicker value={draft.scheduled_at} onChange={(x) => setDraft((d) => ({ ...d, scheduled_at: x }))} withTime noPastDays ariaLabel={`Email ${step.position} send time`} />
              </label>
              <label className="field grow">
                <span>Who gets it</span>
                <Select value={draft.audience} onChange={(x) => setDraft((d) => ({ ...d, audience: x }))} options={audienceOptions} aria-label={`Who gets email ${step.position}`} />
              </label>
            </div>
          )}

          <div className="campaign-variant-tabs" role="tablist" aria-label={`Email ${step.position} variants`}>
            {draft.variants.map((_, i) => (
              <button key={i} role="tab" aria-selected={i === active} className={`campaign-variant-tab${i === active ? ' active' : ''}`} onClick={() => setActive(i)}>
                {ab ? `Variant ${LABELS[i]}` : 'Content'}
              </button>
            ))}
            {draft.variants.length < 5 && (
              <button className="btn small" onClick={addVariant} title="Test another version of this email"><Copy size={14} /> {ab ? 'Add variant' : 'A/B test it'}</button>
            )}
            {ab && <button className="btn small danger-text" onClick={removeVariant}>Remove variant {LABELS[active]}</button>}
          </div>

          <div className="campaign-variant">
            <label className="field">
              <span>Email template</span>
              <Select value={v.template_id} search onChange={(x) => setVariant({ template_id: x })} loading={templates === null}
                aria-label="Email template"
                options={[{ value: '', label: 'The campaign\'s template (when it has one)' }, ...(templates ?? [])]} />
            </label>
            <div className="field-row">
              <label className="field grow">
                <span>Subject</span>
                <input value={v.subject} placeholder={defaults.subject || 'The template\'s subject'} onChange={(e) => setVariant({ subject: e.target.value })} />
              </label>
              <label className="field grow">
                <span>Preheader</span>
                <input value={v.preheader} placeholder={defaults.preheader || 'None'} onChange={(e) => setVariant({ preheader: e.target.value })} />
              </label>
            </div>
            <div className="field-row">
              <label className="field grow">
                <span>From name</span>
                <input value={v.from_name} placeholder={defaults.from_name || 'Settings > Email sender'} onChange={(e) => setVariant({ from_name: e.target.value })} />
              </label>
              <label className="field grow">
                <span>From address</span>
                <input type="email" value={v.from_address} placeholder={defaults.from_address || 'Settings > Email sender'} onChange={(e) => setVariant({ from_address: e.target.value })} />
              </label>
            </div>
            <p className="small muted">Empty fields use the campaign's own (shown greyed out). Subjects can use Liquid, like the template.</p>
          </div>

          {ab && (
            <div className="campaign-ab">
              <div className="field-row">
                <label className="field">
                  <span>Test slice</span>
                  <Select value={String(draft.test_percent)} onChange={(x) => setDraft((d) => ({ ...d, test_percent: Number(x) }))}
                    options={PERCENTS.map((n) => ({ value: String(n), label: `${n}%` }))} aria-label="Test slice" />
                </label>
                <label className="field">
                  <span>Then wait</span>
                  <Select value={String(draft.test_wait_minutes)} onChange={(x) => setDraft((d) => ({ ...d, test_wait_minutes: Number(x) }))}
                    options={WAITS.map(([n, l]) => ({ value: String(n), label: l }))} aria-label="Wait before picking the winner" />
                </label>
                <label className="field">
                  <span>Winner by</span>
                  <Select value={draft.win_metric} onChange={(x) => setDraft((d) => ({ ...d, win_metric: x as 'clicks' | 'opens' }))}
                    options={[{ value: 'clicks', label: 'Click rate' }, { value: 'opens', label: 'Open rate' }]} aria-label="Pick the winner by" />
                </label>
              </div>
              <p className="small muted">
                {slice !== null
                  ? `The ${draft.variants.length} variants go to ${slice.toLocaleString()} of ${audienceSize!.toLocaleString()} contacts (about ${Math.floor(slice / draft.variants.length).toLocaleString()} each). After ${waitLabel(draft.test_wait_minutes)}, the one with the best ${draft.win_metric === 'clicks' ? 'click' : 'open'} rate goes to the other ${(audienceSize! - slice).toLocaleString()}.`
                  : `The variants go to ${draft.test_percent}% of who gets this email, split evenly. After ${waitLabel(draft.test_wait_minutes)}, the one with the best ${draft.win_metric === 'clicks' ? 'click' : 'open'} rate goes to everyone else.`}
                {draft.win_metric === 'opens' ? ' Opens are a rough signal: some mail apps load images for the reader.' : ' Ties go to the better open rate, then to the earlier variant.'}
              </p>
            </div>
          )}

          <div className="campaign-actions">
            <button className="btn" disabled={!!busy || !dirty} onClick={() => { setDraft(saved); setActive(0); }}>Discard</button>
            <button className="btn primary" disabled={!!busy || !dirty} onClick={save}>{busy === `save:${step.id}` ? 'Saving…' : `Save email ${step.position}`}</button>
          </div>
        </>
      ) : (
        <StepResults step={step} canSend={canSend} busy={busy} onPick={pickWinner} />
      )}
    </section>
  );
}

function StepResults({ step, canSend, busy, onPick }: {
  step: CampaignStep; canSend: boolean; busy: string | null; onPick: (v: CampaignVariant) => void;
}) {
  const ab = step.ab_test;
  const testing = step.status === 'testing';
  return (
    <>
      {ab && (
        <p className="small muted">
          A/B test: {ab.test_percent}% split across {step.variants.length} variants, winner by {ab.win_metric === 'clicks' ? 'click' : 'open'} rate
          {testing
            ? ab.winner_due_at ? `, picked ${new Date(ab.winner_due_at).toLocaleString()}.` : ', picked after the test slice is out and ' + waitLabel(ab.test_wait_minutes) + ' have passed.'
            : ab.winner_picked_by ? (ab.winner_picked_by === 'auto' ? ', picked automatically.' : ', picked by hand.') : '.'}
          {testing && step.held > 0 ? ` ${step.held.toLocaleString()} contacts are waiting for the winner.` : ''}
        </p>
      )}
      <div className="list-table-wrap campaign-variant-wrap">
        <table className="list-table campaign-variant-table">
          <thead>
            <tr>
              <th>{ab ? 'Variant' : 'Email'}</th><th>Subject</th><th className="num">Sent</th><th className="num">Delivered</th>
              <th className="num">Opened</th><th className="num">Clicked</th><th className="num">Unsubscribed</th><th className="num">Bounced</th>
              {testing && canSend && <th />}
            </tr>
          </thead>
          <tbody>
            {step.variants.map((v) => (
              <tr key={v.id}>
                <td>
                  <span className="campaign-variant-name">
                    {ab ? <span className="campaign-variant-pill">{v.label}</span> : step.position}
                    {v.winner && <span className="campaign-flag on" title="Sent to everyone else"><Trophy size={12} /> Winner</span>}
                  </span>
                  {v.template_name && <span className="small muted campaign-email">{v.template_name}</span>}
                </td>
                <td className="campaign-subject" data-label="Subject">{v.subject ?? <span className="muted">The template's</span>}</td>
                <td className="num" data-label="Sent">{v.stats.sent.toLocaleString()}</td>
                <td className="num" data-label="Delivered">{v.stats.delivered.toLocaleString()}</td>
                <td className="num" data-label="Opened">{v.stats.opened.toLocaleString()} <span className="muted small">{pct(v.stats.opened, v.stats.sent)}</span></td>
                <td className="num" data-label="Clicked">{v.stats.clicked.toLocaleString()} <span className="muted small">{pct(v.stats.clicked, v.stats.sent)}</span></td>
                <td className="num" data-label="Unsubscribed">{v.stats.unsubscribed.toLocaleString()}</td>
                <td className="num" data-label="Bounced">{v.stats.bounced.toLocaleString()}</td>
                {testing && canSend && (
                  <td><button className="btn small" disabled={!!busy} onClick={() => onPick(v)}>Pick as winner</button></td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
