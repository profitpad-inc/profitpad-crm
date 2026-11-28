import type pg from 'pg';
import { pool, withTx, type Db } from '../db.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { Principal } from '../auth.js';
import type { CampaignRow, TemplateParts } from './render.js';
import { dirtyCampaigns } from './events.js';
import { EMAIL_ACTOR } from './send.js';

// The emails inside a campaign (migration 0165): email 1 goes out when the
// campaign is sent or scheduled, later ones at their own times, each to the
// contacts who got email 1 (or those of them who did not open / click an
// earlier one). Each email has one or more variants; two or more make an A/B
// test: the variants go to a test slice of the audience, and after a wait the
// one with the best click (or open) rate goes to everyone else.
//
//   step:  draft -> scheduled -> testing (A/B only) -> sending -> sent   (or canceled)
//
// Outbox rows of an A/B email wait as `held` (no variant) until the winner is
// picked; then they become `queued` with the winner. Sending itself, and the
// worker that moves steps along, is in campaigns.ts.

export const MAX_STEPS = 20;
export const MAX_VARIANTS = 5;
export const LABELS = ['A', 'B', 'C', 'D', 'E'] as const;
export const AUDIENCES = ['all', 'not_opened', 'not_clicked'] as const;
export const METRICS = ['clicks', 'opens'] as const;
export type StepAudience = (typeof AUDIENCES)[number];
export type WinMetric = (typeof METRICS)[number];

export interface VariantRow {
  id: string;
  step_id: string;
  label: string;
  template_id: string | null;
  subject: string | null;
  preheader: string | null;
  from_name: string | null;
  from_address: string | null;
}

export interface StepRow {
  id: string;
  campaign_id: string;
  position: number;
  scheduled_at: Date | null;
  audience: StepAudience;
  audience_step_id: string | null;
  status: string;
  test_percent: number;
  test_wait_minutes: number;
  win_metric: WinMetric;
  test_sent_at: Date | null;
  winner_variant_id: string | null;
  winner_picked_by: string | null;
  started_at: Date | null;
  sent_at: Date | null;
  error: string | null;
  variants: VariantRow[];
}

const ID = /^[0-9a-f]{10}$/;
const NUM = /^[1-9][0-9]{0,17}$/;
// a step that has not started can still change
export const OPEN_STEP = ['draft', 'scheduled'];
// a step the worker still has to do something with
export const LIVE_STEP = ['scheduled', 'testing', 'sending'];

const STEP_COLS = `id::text, campaign_id, position, scheduled_at, audience, audience_step_id::text, status, test_percent, test_wait_minutes,
  win_metric, test_sent_at, winner_variant_id::text, winner_picked_by, started_at, sent_at, error`;

export async function loadSteps(db: Db, campaignId: string, lock = false): Promise<StepRow[]> {
  const { rows } = await db.query(
    `select ${STEP_COLS} from auth.email_campaign_steps where campaign_id = $1 order by position${lock ? ' for update' : ''}`, [campaignId]);
  if (!rows.length) return [];
  const { rows: vs } = await db.query(
    `select id::text, step_id::text, label, template_id, subject, preheader, from_name, from_address
     from auth.email_campaign_variants where step_id = any($1::bigint[]) order by step_id, label`,
    [rows.map((r) => r.id)]
  );
  return rows.map((r) => ({ ...r, variants: vs.filter((v) => v.step_id === r.id) })) as StepRow[];
}

export async function loadStep(db: Db, campaignId: string, stepId: string, lock = false): Promise<StepRow> {
  if (!NUM.test(stepId)) throw notFound('email not found');
  const step = (await loadSteps(db, campaignId, lock)).find((s) => s.id === stepId);
  if (!step) throw notFound(`email ${stepId} is not part of campaign ${campaignId}`);
  return step;
}

// ---- pure rules (tested in email.test.ts) -----------------------------------------

// How many contacts get the test: every variant at least one, never more than
// the audience. One variant: everyone, there is no test.
export function testSize(audience: number, variants: number, percent: number): number {
  if (variants <= 1) return audience;
  return Math.min(audience, Math.max(variants, Math.ceil((audience * percent) / 100)));
}

export interface VariantResult { id: string; label: string; sent: number; opens: number; clicks: number }

// The winning variant: the best rate on the metric, then on the other one,
// then the earlier label. A variant that went to nobody has a rate of 0.
export function pickWinner(results: VariantResult[], metric: WinMetric): VariantResult | null {
  if (!results.length) return null;
  const rate = (r: VariantResult, m: WinMetric) => (r.sent > 0 ? (m === 'clicks' ? r.clicks : r.opens) / r.sent : 0);
  const other: WinMetric = metric === 'clicks' ? 'opens' : 'clicks';
  return [...results].sort((a, b) =>
    rate(b, metric) - rate(a, metric) || rate(b, other) - rate(a, other) || a.label.localeCompare(b.label))[0];
}

// Problems with the order of the emails: later emails need a time after the
// one before (email 1's time is `firstAt`), and a follow-up condition must
// point at an earlier email. Only emails that have not started are checked.
export function stepOrderProblems(steps: Pick<StepRow, 'id' | 'position' | 'scheduled_at' | 'audience' | 'audience_step_id' | 'status' | 'started_at'>[], firstAt: Date): string[] {
  const problems: string[] = [];
  let prev: Date | null = null;
  for (const s of steps) {
    const at = s.position === 1 ? (s.started_at ?? firstAt) : (s.started_at ?? s.scheduled_at);
    if (s.position > 1 && OPEN_STEP.includes(s.status)) {
      if (!s.scheduled_at) problems.push(`Email ${s.position} needs a send time.`);
      else if (prev && s.scheduled_at.getTime() <= prev.getTime()) problems.push(`Email ${s.position} must go out after email ${s.position - 1}.`);
      if (s.audience !== 'all') {
        const ref = steps.find((x) => x.id === s.audience_step_id);
        if (!ref || ref.position >= s.position) problems.push(`Email ${s.position} can only follow up on an earlier email.`);
      }
    }
    if (at) prev = at;
  }
  return problems;
}

// ---- resolving a variant ------------------------------------------------------------

// The campaign's linked templates (crm.pc_0051), active ones.
export async function linkedTemplates(db: Db, campaignId: string): Promise<TemplateParts[]> {
  const { rows } = await db.query(
    `select t.pc_0051_id as id, t.name, t.subject, t.body
     from crm.associations_both a join crm.pc_0051 t on t.pc_0051_id = a.other_record_id and t.record_status = 'active'
     where a.object_type_id = 'pc_0058' and a.record_id = $1 and a.other_object_type_id = 'pc_0051'
     order by t.name, t.pc_0051_id`,
    [campaignId]
  );
  return rows;
}

export async function loadTemplate(db: Db, id: string): Promise<TemplateParts | null> {
  const { rows } = await db.query(
    `select pc_0051_id as id, name, subject, body from crm.pc_0051 where pc_0051_id = $1 and record_status = 'active'`, [id]);
  return rows[0] ?? null;
}

// The template a variant uses: its own, else the campaign's only linked one.
// Null with a reason when there is none to use.
export async function variantTemplate(db: Db, campaignId: string, v: VariantRow, linked?: TemplateParts[]): Promise<{ template: TemplateParts | null; problem: string | null }> {
  if (v.template_id) {
    const t = await loadTemplate(db, v.template_id);
    return t ? { template: t, problem: null } : { template: null, problem: 'its email template is archived or gone' };
  }
  const all = linked ?? await linkedTemplates(db, campaignId);
  if (all.length === 1) return { template: all[0], problem: null };
  return { template: null, problem: all.length ? 'pick its email template' : 'link an email template to the campaign' };
}

// The campaign as one variant sends it: the variant's fields, else the campaign's.
export function variantCampaign(campaign: CampaignRow, v: VariantRow | null): CampaignRow {
  if (!v) return campaign;
  const pick = (a: string | null, b: string | null) => (a && a.trim() ? a : b);
  return {
    ...campaign,
    subject: pick(v.subject, campaign.subject),
    preheader: pick(v.preheader, campaign.preheader),
    from_name: pick(v.from_name, campaign.from_name),
    from_address: pick(v.from_address, campaign.from_address)
  };
}

const labelOf = (s: StepRow, v: VariantRow) => (s.variants.length > 1 ? `Email ${s.position}, variant ${v.label}` : `Email ${s.position}`);

// What stops one email's variants from being drawn.
export async function contentProblems(db: Db, campaign: CampaignRow, s: StepRow, linked?: TemplateParts[]): Promise<string[]> {
  if (!s.variants.length) return [`Email ${s.position} has no content.`];
  const problems: string[] = [];
  const all = linked ?? await linkedTemplates(db, campaign.id);
  for (const v of s.variants) {
    const { template, problem } = await variantTemplate(db, campaign.id, v, all);
    if (problem) { problems.push(`${labelOf(s, v)}: ${problem}.`); continue; }
    if (!template?.body?.trim()) problems.push(`${labelOf(s, v)}: its email template has no body.`);
    if (!(variantCampaign(campaign, v).subject || template?.subject)) problems.push(`${labelOf(s, v)} needs a subject (on the email, the campaign or its template).`);
  }
  return problems;
}

// What stops the emails that have not started from going out.
export async function stepProblems(db: Db, campaign: CampaignRow, steps: StepRow[], firstAt: Date, audience: number): Promise<string[]> {
  const problems: string[] = [];
  const linked = await linkedTemplates(db, campaign.id);
  for (const s of steps) {
    if (!OPEN_STEP.includes(s.status)) continue;
    problems.push(...await contentProblems(db, campaign, s, linked));
    if (s.position === 1 && s.variants.length > 1 && audience > 0 && audience <= s.variants.length) {
      problems.push(`Email 1 has ${s.variants.length} variants but only ${audience} contact${audience === 1 ? '' : 's'}: an A/B test needs more contacts than variants.`);
    }
  }
  problems.push(...stepOrderProblems(steps, firstAt));
  return problems;
}

// ---- the audience of each email ------------------------------------------------------

// SQL for who gets email 2+: contacts sent email 1 who can still be emailed,
// minus those who opened / clicked the email the condition points at.
export function followUpSql(step: StepRow, firstStepId: string, topic: string | null, params: unknown[]): string {
  params.push(firstStepId);
  let sql = `select distinct on (t.email -> 0 ->> 'value') t.pc_0010_id as contact_id, t.email -> 0 ->> 'value' as email
    from auth.email_outbox f join crm.pc_0010 t on t.pc_0010_id = f.contact_id
    where f.step_id = $${params.length} and f.status = 'sent'
      and t.record_status = 'active' and t.email -> 0 ->> 'value' is not null and t.email_opt_out is distinct from '{true}'`;
  if (topic) {
    params.push(topic);
    sql += ` and not (coalesce(t.email_unsubscribed_topics, '{}') @> array[$${params.length}]::text[])`;
  }
  if (step.audience !== 'all' && step.audience_step_id) {
    params.push(step.audience_step_id);
    const col = step.audience === 'not_opened' ? 'first_opened_at' : 'first_clicked_at';
    sql += ` and not exists (select 1 from auth.email_outbox x join crm.pc_0031 e on e.pc_0031_id = x.email_id
               where x.step_id = $${params.length} and x.contact_id = t.pc_0010_id and e.${col} is not null)`;
  }
  return `${sql} order by t.email -> 0 ->> 'value', t.created_at`;
}

// Starts one email: fills in its variants' blank fields (so the rows record
// what went out), writes an outbox row per contact in `audienceSql` (random
// order: the first test slice spread over the variants, the rest held for the
// winner), and returns how many. Runs in the caller's transaction with the
// campaign locked.
export async function startStep(c: pg.PoolClient, campaign: CampaignRow, step: StepRow, audienceSql: string, params: unknown[],
  sender: { name: string | null; address: string | null }): Promise<number> {
  const linked = await linkedTemplates(c, campaign.id);
  for (const v of step.variants) {
    const { template } = await variantTemplate(c, campaign.id, v, linked);
    const m = variantCampaign(campaign, v);
    await c.query(
      `update auth.email_campaign_variants set template_id = coalesce(template_id, $2),
         subject = coalesce(nullif(subject, ''), $3), preheader = coalesce(nullif(preheader, ''), $4),
         from_name = coalesce(nullif(from_name, ''), $5), from_address = coalesce(nullif(from_address, ''), $6)
       where id = $1`,
      [v.id, template?.id ?? null, m.subject || template?.subject || null, m.preheader || null, m.from_name || sender.name, m.from_address || sender.address]
    );
  }
  const k = step.variants.length;
  const p = [...params];
  p.push(campaign.id); const cIdx = p.length;
  p.push(step.id); const sIdx = p.length;
  p.push(step.variants.map((v) => v.id)); const vIdx = p.length;
  p.push(k > 1 ? step.test_percent : 100); const pctIdx = p.length;
  // the slice: at least one contact per variant (testSize)
  const { rowCount } = await c.query(
    `insert into auth.email_outbox (campaign_id, step_id, contact_id, email, variant_id, status)
     select $${cIdx}, $${sIdx}::bigint, a.contact_id, a.email,
            case when a.rn <= a.slice then ($${vIdx}::bigint[])[((a.rn - 1) % ${k}) + 1] end,
            case when a.rn <= a.slice then 'queued' else 'held' end
     from (
       select a.contact_id, a.email, row_number() over (order by random()) as rn,
              least(count(*) over (), greatest(${k}, ceil(count(*) over () * $${pctIdx}::numeric / 100))) as slice
       from (${audienceSql}) a
     ) a
     on conflict do nothing`,
    p
  );
  await c.query(
    `update auth.email_campaign_steps set status = $2, started_at = now(), error = null where id = $1`,
    [step.id, k > 1 ? 'testing' : 'sending']
  );
  dirtyCampaigns.add(campaign.id);
  return rowCount ?? 0;
}

// ---- A/B results and the winner --------------------------------------------------------

export async function variantResults(db: Db, stepId: string): Promise<VariantResult[]> {
  const { rows } = await db.query(
    `select v.id::text, v.label, count(o.id) filter (where o.status = 'sent')::int as sent,
            count(e.first_opened_at)::int as opens, count(e.first_clicked_at)::int as clicks
     from auth.email_campaign_variants v
     left join auth.email_outbox o on o.variant_id = v.id and o.step_id = v.step_id
     left join crm.pc_0031 e on e.pc_0031_id = o.email_id
     where v.step_id = $1 group by v.id, v.label order by v.label`,
    [stepId]
  );
  return rows;
}

// Sends the held rows of a testing step with `variantId`. Caller holds the
// campaign lock.
export async function releaseWinner(c: pg.PoolClient, step: StepRow, variantId: string, by: string): Promise<number> {
  await c.query(
    `update auth.email_campaign_steps set winner_variant_id = $2, winner_picked_by = $3, status = 'sending' where id = $1`,
    [step.id, variantId, by]);
  const { rowCount } = await c.query(
    `update auth.email_outbox set status = 'queued', variant_id = $2 where step_id = $1 and status = 'held'`, [step.id, variantId]);
  dirtyCampaigns.add(step.campaign_id);
  return rowCount ?? 0;
}

// An admin picks the winner before the wait is over.
export async function pickWinnerNow(campaignId: string, stepId: string, variantId: string, p: Principal): Promise<{ winner: string; queued: number }> {
  if (!NUM.test(variantId)) throw badRequest('variant_id must be a variant of this email');
  return withTx({ principal: p, source: 'email_campaign' }, async (c) => {
    await c.query('select 1 from crm.pc_0058 where pc_0058_id = $1 for update', [campaignId]);
    const step = await loadStep(c, campaignId, stepId, true);
    if (step.status !== 'testing') throw badRequest(step.winner_variant_id ? 'This email already has its winner.' : 'This email is not being tested.');
    const v = step.variants.find((x) => x.id === variantId);
    if (!v) throw badRequest('variant_id must be a variant of this email');
    const queued = await releaseWinner(c, step, v.id, p.userId ?? 'user');
    return { winner: v.label, queued };
  });
}

// Testing steps whose wait is over get their winner (the worker, every tick).
export async function pickDueWinners(log: { info: (o: unknown, m: string) => void }): Promise<void> {
  const { rows } = await pool.query(
    `select s.id::text, s.campaign_id from auth.email_campaign_steps s join crm.pc_0058 k on k.pc_0058_id = s.campaign_id
     where s.status = 'testing' and s.test_sent_at is not null
       and s.test_sent_at + make_interval(mins => s.test_wait_minutes) <= now() and k.status <@ '{sending}'`
  );
  for (const r of rows) {
    await withTx({ ...EMAIL_ACTOR, source: 'email_campaign' }, async (c) => {
      await c.query('select 1 from crm.pc_0058 where pc_0058_id = $1 for update', [r.campaign_id]);
      const step = await loadStep(c, r.campaign_id, r.id, true);
      if (step.status !== 'testing') return;
      const win = pickWinner(await variantResults(c, step.id), step.win_metric);
      if (!win) return;
      const queued = await releaseWinner(c, step, win.id, 'auto');
      log.info({ campaign: r.campaign_id, step: step.position, winner: win.label, queued }, 'email campaign A/B winner picked');
    });
  }
}

// ---- stats ------------------------------------------------------------------------

export interface VariantStats {
  recipients: number; sent: number; delivered: number; opened: number; clicked: number; replied: number;
  unsubscribed: number; bounced: number; complained: number; held: number;
}

// Per variant of every email of a campaign.
export async function stepStats(campaignId: string): Promise<Map<string, VariantStats>> {
  const { rows } = await pool.query(
    `select o.variant_id::text as variant_id,
       count(*) filter (where o.status in ('queued', 'sent'))::int as recipients,
       count(*) filter (where o.status = 'sent')::int as sent,
       count(e.delivered_at)::int as delivered, count(e.first_opened_at)::int as opened, count(e.first_clicked_at)::int as clicked,
       count(e.replied_at)::int as replied, count(o.unsubscribed_at)::int as unsubscribed, count(e.bounced_at)::int as bounced,
       count(*) filter (where e.status <@ '{complained}')::int as complained
     from auth.email_outbox o left join crm.pc_0031 e on e.pc_0031_id = o.email_id
     where o.campaign_id = $1 and o.variant_id is not null
     group by o.variant_id`,
    [campaignId]
  );
  const out = new Map<string, VariantStats>();
  for (const r of rows) out.set(r.variant_id, { ...r, held: 0 });
  return out;
}

async function heldCounts(campaignId: string): Promise<Map<string, number>> {
  const { rows } = await pool.query(
    `select step_id::text, count(*)::int as n from auth.email_outbox where campaign_id = $1 and status = 'held' group by step_id`, [campaignId]);
  return new Map(rows.map((r) => [r.step_id as string, r.n as number]));
}

// The campaign's emails as the CRM and the MCP show them.
export async function stepsOut(campaignId: string) {
  const [steps, stats, held, linked] = await Promise.all([
    loadSteps(pool, campaignId), stepStats(campaignId), heldCounts(campaignId), linkedTemplates(pool, campaignId)
  ]);
  const names = new Map<string, string | null>(linked.map((t) => [t.id, t.name]));
  const missing = [...new Set(steps.flatMap((s) => s.variants.map((v) => v.template_id)).filter((t): t is string => !!t && !names.has(t)))];
  if (missing.length) {
    const { rows } = await pool.query('select pc_0051_id as id, name from crm.pc_0051 where pc_0051_id = any($1)', [missing]);
    for (const r of rows) names.set(r.id, r.name);
  }
  const empty: VariantStats = { recipients: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, unsubscribed: 0, bounced: 0, complained: 0, held: 0 };
  return steps.map((s) => ({
    id: s.id, position: s.position, status: s.status, scheduled_at: s.scheduled_at, started_at: s.started_at, sent_at: s.sent_at,
    audience: s.audience, audience_step_id: s.audience_step_id, error: s.error,
    ab_test: s.variants.length > 1
      ? { test_percent: s.test_percent, test_wait_minutes: s.test_wait_minutes, win_metric: s.win_metric, test_sent_at: s.test_sent_at,
          winner_variant_id: s.winner_variant_id, winner_picked_by: s.winner_picked_by,
          winner_due_at: s.test_sent_at ? new Date(new Date(s.test_sent_at).getTime() + s.test_wait_minutes * 60_000) : null }
      : null,
    held: held.get(s.id) ?? 0,
    variants: s.variants.map((v) => ({
      id: v.id, label: v.label, template_id: v.template_id, template_name: v.template_id ? names.get(v.template_id) ?? null : null,
      subject: v.subject, preheader: v.preheader, from_name: v.from_name, from_address: v.from_address,
      winner: s.winner_variant_id === v.id, stats: stats.get(v.id) ?? empty
    }))
  }));
}

// ---- editing ------------------------------------------------------------------------

export interface VariantInput {
  id?: unknown; template_id?: unknown; subject?: unknown; preheader?: unknown; from_name?: unknown; from_address?: unknown;
}
export interface StepInput {
  scheduled_at?: unknown; audience?: unknown; audience_step_id?: unknown;
  test_percent?: unknown; test_wait_minutes?: unknown; win_metric?: unknown; variants?: unknown;
}

const text = (v: unknown, max: number, name: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw badRequest(`${name} must be text`, { property: name });
  const t = v.trim();
  if (t.length > max) throw badRequest(`${name} is longer than ${max} characters`, { property: name });
  return t || null;
};

const int = (v: unknown, min: number, max: number, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`, { property: name });
  return n;
};

export function checkFromAddress(v: string | null): string | null {
  if (!v) return null;
  const a = v.toLowerCase();
  if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(a)) throw badRequest(`"${a}" is not an email address`, { property: 'from_address' });
  return a;
}

function variantInputs(raw: unknown): (Omit<VariantRow, 'step_id' | 'label' | 'id'> & { id: string | null })[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_VARIANTS) throw badRequest(`variants must be a list of 1 to ${MAX_VARIANTS} variants`, { property: 'variants' });
  return raw.map((r: VariantInput) => {
    if (!r || typeof r !== 'object') throw badRequest('each variant must be an object', { property: 'variants' });
    const id = r.id === undefined || r.id === null ? null : String(r.id);
    if (id !== null && !NUM.test(id)) throw badRequest('variant id must be an id from this email', { property: 'variants' });
    const template = r.template_id === undefined || r.template_id === null || r.template_id === '' ? null : String(r.template_id);
    if (template !== null && !ID.test(template)) throw badRequest('template_id must be an email template id', { property: 'template_id' });
    return {
      id, template_id: template,
      subject: text(r.subject, 1000, 'subject'), preheader: text(r.preheader, 1000, 'preheader'),
      from_name: text(r.from_name, 200, 'from_name'), from_address: checkFromAddress(text(r.from_address, 320, 'from_address'))
    };
  });
}

async function lockCampaignStatus(c: pg.PoolClient, campaignId: string): Promise<string> {
  const { rows } = await c.query(
    `select status[1] as status from crm.pc_0058 where pc_0058_id = $1 and record_status = 'active' for update`, [campaignId]);
  if (!rows[0]) throw new ApiError(404, `email campaign ${campaignId} not found`, 'not_found');
  return rows[0].status ?? 'draft';
}

// Writes a step's settings and variants. A new step is added at the end.
// Steps that started can't change; email 1's time is set by Send / Schedule.
// On a campaign that is already going out, a later email with a time is
// scheduled at once (and a sent campaign goes back to sending).
export async function saveStep(campaignId: string, stepId: string | null, input: StepInput, p: Principal) {
  if (!ID.test(campaignId)) throw notFound('not found');
  return withTx({ principal: p, source: 'email_campaign' }, async (c) => {
    const status = await lockCampaignStatus(c, campaignId);
    if (status === 'canceled') throw badRequest('This campaign was canceled: its emails can no longer change.');
    const steps = await loadSteps(c, campaignId, true);
    let step: StepRow | undefined;
    if (stepId) {
      step = steps.find((s) => s.id === stepId);
      if (!step) throw notFound(`email ${stepId} is not part of campaign ${campaignId}`);
      if (!OPEN_STEP.includes(step.status)) throw badRequest(`Email ${step.position} is ${step.status}: it can no longer change.`);
    } else {
      if (steps.length >= MAX_STEPS) throw badRequest(`A campaign has at most ${MAX_STEPS} emails.`);
      if (status === 'sent' && input.scheduled_at === undefined) throw badRequest('Give the new email a send time.');
      const { rows } = await c.query(
        `insert into auth.email_campaign_steps (campaign_id, position) values ($1, $2) returning id::text`,
        [campaignId, (steps.at(-1)?.position ?? 0) + 1]);
      const { rows: v } = await c.query(`insert into auth.email_campaign_variants (step_id, label) values ($1, 'A') returning id::text`, [rows[0].id]);
      step = { id: rows[0].id, position: (steps.at(-1)?.position ?? 0) + 1, status: 'draft', scheduled_at: null, audience: 'all', audience_step_id: null,
        test_percent: 20, test_wait_minutes: 240, win_metric: 'clicks', test_sent_at: null, winner_variant_id: null, winner_picked_by: null,
        started_at: null, sent_at: null, error: null, campaign_id: campaignId,
        variants: [{ id: v[0].id, step_id: rows[0].id, label: 'A', template_id: null, subject: null, preheader: null, from_name: null, from_address: null }] };
      steps.push(step);
    }

    const sets: string[] = [];
    const vals: unknown[] = [step.id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (input.scheduled_at !== undefined) {
      if (step.position === 1) throw badRequest('Email 1 goes out when the campaign is sent or scheduled: use Send now or Schedule.', { property: 'scheduled_at' });
      let at: Date | null = null;
      if (input.scheduled_at !== null && input.scheduled_at !== '') {
        at = new Date(String(input.scheduled_at));
        if (Number.isNaN(at.getTime())) throw badRequest('scheduled_at must be a date and time', { property: 'scheduled_at' });
        if (at.getTime() > Date.now() + 365 * 86400_000) throw badRequest('Emails can be scheduled up to a year ahead.', { property: 'scheduled_at' });
      }
      set('scheduled_at', at);
      step.scheduled_at = at;
    }
    if (input.audience !== undefined || input.audience_step_id !== undefined) {
      const audience = (input.audience ?? step.audience) as StepAudience;
      if (!AUDIENCES.includes(audience)) throw badRequest(`audience must be one of ${AUDIENCES.join(', ')}`, { property: 'audience' });
      if (step.position === 1 && audience !== 'all') throw badRequest('Email 1 goes to the campaign\'s lists.', { property: 'audience' });
      let ref: string | null = null;
      if (audience !== 'all') {
        ref = input.audience_step_id === undefined ? step.audience_step_id : input.audience_step_id === null ? null : String(input.audience_step_id);
        const target = steps.find((s) => s.id === ref);
        if (!target || target.position >= step.position) throw badRequest('audience_step_id must be an earlier email of this campaign', { property: 'audience_step_id' });
      }
      set('audience', audience);
      set('audience_step_id', ref);
      step.audience = audience;
      step.audience_step_id = ref;
    }
    if (input.test_percent !== undefined) set('test_percent', int(input.test_percent, 5, 50, 'test_percent'));
    if (input.test_wait_minutes !== undefined) set('test_wait_minutes', int(input.test_wait_minutes, 60, 4320, 'test_wait_minutes'));
    if (input.win_metric !== undefined) {
      if (!METRICS.includes(input.win_metric as WinMetric)) throw badRequest(`win_metric must be ${METRICS.join(' or ')}`, { property: 'win_metric' });
      set('win_metric', input.win_metric);
    }

    if (input.variants !== undefined) {
      const vs = variantInputs(input.variants);
      // Linking another template would leave "the campaign's template" with
      // two to choose from: variants that use it are pinned to it first.
      const linked = await linkedTemplates(c, campaignId);
      if (linked.length === 1 && vs.some((v) => v.template_id && v.template_id !== linked[0].id)) {
        for (const v of vs) if (!v.template_id) v.template_id = linked[0].id;
        await c.query(
          `update auth.email_campaign_variants v set template_id = $2
           from auth.email_campaign_steps s
           where s.id = v.step_id and s.campaign_id = $1 and s.status in ('draft', 'scheduled') and v.template_id is null`,
          [campaignId, linked[0].id]);
      }
      const keep = new Set(vs.map((v) => v.id).filter(Boolean));
      for (const id of keep) if (!step.variants.some((v) => v.id === id)) throw badRequest(`variant ${id} is not part of email ${step.position}`, { property: 'variants' });
      await c.query(`delete from auth.email_campaign_variants where step_id = $1 and not (id = any($2::bigint[]))`, [step.id, [...keep]]);
      // labels follow the order given (A, B, C...); the unique key is checked at commit
      await c.query('set constraints all deferred');
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        const args = [LABELS[i], v.template_id, v.subject, v.preheader, v.from_name, v.from_address];
        if (v.id) {
          await c.query(
            `update auth.email_campaign_variants set label = $2, template_id = $3, subject = $4, preheader = $5, from_name = $6, from_address = $7 where id = $1`,
            [v.id, ...args]);
        } else {
          await c.query(
            `insert into auth.email_campaign_variants (step_id, label, template_id, subject, preheader, from_name, from_address) values ($1, $2, $3, $4, $5, $6, $7)`,
            [step.id, ...args]);
        }
        // the template shows in the campaign's right column
        if (v.template_id) {
          if (!(await loadTemplate(c, v.template_id))) throw badRequest(`email template ${v.template_id} not found`, { property: 'template_id' });
          await c.query(`select meta.associate('email_campaigns', $1, 'email_templates', $2)`, [campaignId, v.template_id]);
        }
      }
    }
    if (sets.length) await c.query(`update auth.email_campaign_steps set ${sets.join(', ')} where id = $1`, vals);

    // a later email added to (or changed on) a campaign that is scheduled or going out
    if (step.position > 1 && (status === 'sending' || status === 'sent' || status === 'scheduled')) {
      const want = step.scheduled_at ? 'scheduled' : 'draft';
      if (want === 'scheduled') {
        if (status !== 'scheduled' && step.scheduled_at!.getTime() < Date.now() - 60_000) throw badRequest('Pick a time from now on.', { property: 'scheduled_at' });
        const first = steps.find((s) => s.position === 1)!;
        const mine = stepOrderProblems(steps, first.scheduled_at ?? new Date()).filter((x) => x.startsWith(`Email ${step!.position} `));
        if (mine.length) throw badRequest(mine[0], { property: 'scheduled_at' });
      }
      await c.query(`update auth.email_campaign_steps set status = $2, error = null where id = $1`, [step.id, want]);
      if (want === 'scheduled' && status === 'sent') {
        await c.query(`update crm.pc_0058 set status = '{sending}' where pc_0058_id = $1`, [campaignId]);
      }
    }
    return { id: step.id };
  });
}

// Removes an email that has not started; the ones after it move up.
export async function removeStep(campaignId: string, stepId: string, p: Principal): Promise<{ removed: number }> {
  if (!ID.test(campaignId)) throw notFound('not found');
  return withTx({ principal: p, source: 'email_campaign' }, async (c) => {
    await lockCampaignStatus(c, campaignId);
    const steps = await loadSteps(c, campaignId, true);
    const step = steps.find((s) => s.id === stepId);
    if (!step) throw notFound(`email ${stepId} is not part of campaign ${campaignId}`);
    if (step.position === 1) throw badRequest('Email 1 can\'t be removed: a campaign always has one email.');
    if (!OPEN_STEP.includes(step.status)) throw badRequest(`Email ${step.position} is ${step.status}: it can no longer be removed.`);
    const dep = steps.find((s) => s.audience_step_id === step.id);
    if (dep) throw badRequest(`Email ${dep.position} follows up on email ${step.position}: change who email ${dep.position} goes to first.`);
    await c.query('set constraints all deferred');
    await c.query('delete from auth.email_campaign_steps where id = $1', [step.id]);
    await c.query('update auth.email_campaign_steps set position = position - 1 where campaign_id = $1 and position > $2', [campaignId, step.position]);
    return { removed: step.position };
  });
}
