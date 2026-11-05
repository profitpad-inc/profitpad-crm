import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Archive, ArrowRight, AtSign, ChevronDown, ChevronLeft, ChevronRight, Copy, EllipsisVertical, ExternalLink, History, Inbox, KeyRound, Link2, Lock, MessageSquare, Pencil, Plus, Unlink, X } from 'lucide-react';
import { fileInfo } from '../lib/files';
import { api, ApiError, getSchema, type CrmRecord, type ObjectDef, type Property, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { displayName, displayValue, formatValue, initials, nameProperties, objectIcon, recordName } from '../lib/display';
import { Menu, PropertyInput, fromInput, isEditable, toInput } from '../components/ui';
import { useAddressGroups, withAddressesTogether } from '../components/AddressInput';
import { PublicLinkCard } from '../components/PublicLinkCard';
import { QuoteTemplateCard } from '../components/QuoteTemplateCard';
import { QuoteSigningCard } from '../components/QuoteSigningCard';
import { PaymentConfirmCard } from '../components/PaymentConfirmCard';
import { FormBuilder } from '../components/FormBuilder';
import { BookingPageEditor } from '../components/BookingPageEditor';
import { FileCard } from '../components/FileCard';
import { ViewCode } from '../components/ViewCode';
import { DocumentTemplateEditor } from '../components/DocumentTemplateEditor';
import { EmailCampaignEditor } from '../components/EmailCampaignEditor';
import { EmailTracking } from '../components/EmailTracking';
import { ViewIconAvatar } from '../components/IconPicker';
import { FileField } from '../components/FileField';
import { HtmlEditorModal, HtmlValue } from '../components/HtmlEditor';
import { AMOUNT_PARENTS, money, offerAmountUpdates, parentTotals, parentsOfLines, setParentAmount, type ParentTotals } from '../lib/lines';
import { LineItemsEditor, type LineTarget } from '../components/LineItemsEditor';
import { CreateRecordModal } from '../components/CreateRecordModal';
import { COMMENT_TARGETS, Comments } from '../components/Comments';
import { ActivityComposer, COMPOSE_OBJECTS, COMPOSE_VERB, type ComposeObject } from '../components/ActivityComposer';
import type { Attachable, Recipient } from '../components/EmailComposer';
// the rich text editor is big: loaded when someone writes an email
const EmailComposer = lazy(() => import('../components/EmailComposer').then((m) => ({ default: m.EmailComposer })));
import { loadCanSend, type SendStatus } from '../lib/mailbox';
import { SnippetRecordProvider, TextArea } from '../lib/snippets';
import { MentionText } from '../components/MentionText';
import { MENTION_TOKEN, encodeMentions, mentionsAsText, type MentionUser } from '../lib/text-complete';
import { EmptyState, StatusPill, TableSkeleton, type Tone } from '../components/settings';
import { Select } from '../components/Select';
import { ShowMore } from '../components/ShowMore';
import '../record.css';
import { confirmDialog, alertDialog } from '../components/confirm';
import { LiveContext, bumpVersions, useLiveRecords, useLiveStamp, useLiveVersion, type LiveEvents } from '../lib/live';

interface Link_ {
  association_id: string;
  label_id: string;
  label: string | null;
  object_type_id: string;
  record_id: string;
}

interface Associated {
  object: string;
  records: { record: CrmRecord; labels: (string | null)[] }[];
}

const ACTIVITY_OBJECTS = ['calls', 'emails', 'notes', 'tasks', 'form_submissions'] as const;
const DEFAULT_CARDS = ['contacts', 'companies', 'deals', 'tickets'];
// objects whose pages show other cards by default
const DEFAULT_CARDS_FOR: Record<string, string[]> = {
  forms: ['form_submissions'],
  booking_pages: ['calls'],
  // its email; the emails it sent are counted, not listed
  email_campaigns: ['email_templates'],
  deals: [...DEFAULT_CARDS, 'lines', 'quotes', 'invoices'],
  // the parent has its own card (LineParentCard)
  lines: ['products'],
  invoices: [...DEFAULT_CARDS, 'lines', 'payments'],
  carts: [...DEFAULT_CARDS, 'lines'],
  quotes: [...DEFAULT_CARDS, 'lines', 'payments'],
  orders: [...DEFAULT_CARDS, 'lines']
};
const ACTIVITY_PROPS: Record<string, string[]> = {
  calls: ['name', 'call_type', 'direction', 'status', 'started_at', 'duration_seconds', 'body', 'created_at'],
  emails: ['name', 'subject', 'body', 'direction', 'status', 'from_address', 'to_addresses', 'cc_addresses', 'sent_at', 'scheduled_at', 'created_at',
    'stream', 'delivered_at', 'first_opened_at', 'open_count', 'first_clicked_at', 'click_count', 'replied_at'],
  // to suggest as recipients and attachments when writing an email
  contacts: ['email'],
  files: ['size_bytes'],
  notes: ['name', 'body', 'created_at'],
  tasks: ['name', 'task_type', 'status', 'priority', 'due_at', 'body', 'created_at'],
  form_submissions: ['name', 'submitted_at', 'summary', 'submission_values', 'created_at'],
  // not activities, but read along: quote responses show in the stream, lines in their card
  quotes: ['status', 'responded_at', 'responder_name', 'responder_email', 'decline_reason',
    'customer_signed_at', 'requires_countersign', 'countersigned_at', 'countersigner_name'],
  lines: ['quantity', 'amount']
};
// Read along with linked quotes and invoices so their card rows can offer the customer's link.
const LINK_PROPS: Record<string, string[]> = { quotes: ['status', 'public_key', 'slug'], invoices: ['status', 'public_key', 'slug'] };
// The statuses the customer's page opens for (api/src/routes/public.ts loadPublicQuote / loadPublicInvoice).
const LIVE: Record<string, { path: string; statuses: string[] }> = {
  quotes: { path: 'quote', statuses: ['sent', 'pending_countersign', 'accepted', 'rejected', 'expired'] },
  invoices: { path: 'invoice', statuses: ['open', 'paid'] }
};

// The customer's link to a published quote or invoice, else null.
function publishedUrl(object: string, r: CrmRecord): string | null {
  const live = LIVE[object];
  if (!live) return null;
  const status = Array.isArray(r.properties.status) ? r.properties.status[0] : r.properties.status;
  const key = (typeof r.properties.slug === 'string' && r.properties.slug) || (typeof r.properties.public_key === 'string' && r.properties.public_key);
  return key && live.statuses.includes(String(status)) ? `${window.location.origin}/p/${live.path}/#${key}` : null;
}

// Shown elsewhere on the page (builder, answers, link and signing cards) rather than as raw values
const HIDDEN_PROPS: Record<string, string[]> = {
  forms: ['definition', 'public_key', 'slug'],
  quotes: ['public_key', 'slug', 'signing_fields', 'signed_fields', 'customer_signature', 'countersigner_signature'],
  invoices: ['public_key', 'slug'],
  form_submissions: ['summary', 'submission_values'],
  booking_pages: ['public_key', 'slug', 'availability', 'timezone', 'form_before_id', 'form_after_id', 'duration_minutes', 'duration_options'],
  files: ['public_token', 'storage_key'],
  views: ['icon', 'draft_source', 'draft_queries', 'source', 'queries'],
  email_campaigns: ['audience'],
  emails: ['reply_token']
};
// An accepted quote is locked (migration 0073; the database refuses changes):
// these properties and its line items. A line on one is locked as a whole.
const ACCEPTED_QUOTE_LOCKED = ['amount', 'currency', 'expiration_date', 'responded_at', 'customer_signed_at'];
type RecordLock = { props: string[] | 'all'; reason: string };
const isAcceptedQuote = (r: CrmRecord) => {
  const s = r.properties.status;
  return (Array.isArray(s) ? s[0] : s) === 'accepted';
};
function recordLock(object: string, record: CrmRecord, associated: Associated[]): RecordLock | null {
  if (object === 'quotes' && isAcceptedQuote(record)) return { props: ACCEPTED_QUOTE_LOCKED, reason: 'Locked because the quote is accepted' };
  if (object === 'lines' && associated.some((a) => a.object === 'quotes' && a.records.some((r) => isAcceptedQuote(r.record)))) {
    return { props: 'all', reason: 'Locked because it is on an accepted quote' };
  }
  return null;
}

// Every active record linked to one record, grouped by object, with the
// name properties (and, for activities, the stream's properties).
async function loadLinked(object: string, id: string, codeToName: Map<string, string>): Promise<Associated[]> {
  const res = await api<{ results: Link_[] }>('GET', `/v1/objects/${object}/${id}/associations`);
  const byObject = new Map<string, Map<string, (string | null)[]>>();
  for (const l of res.results) {
    const name = codeToName.get(l.object_type_id);
    // comments show in their own thread (components/Comments.tsx), not as links
    if (!name || name === 'comments') continue;
    const m = byObject.get(name) ?? new Map();
    m.set(l.record_id, [...(m.get(l.record_id) ?? []), l.label]);
    byObject.set(name, m);
  }
  const groups = await Promise.all(
    [...byObject].map(async ([name, ids]) => {
      // an object the role cannot read is left out, not the whole list
      try {
        const s = await getSchema(name);
        const wanted = new Set([...nameProperties(s.properties), ...(ACTIVITY_PROPS[name] ?? []), ...(LINK_PROPS[name] ?? [])]);
        const props = s.properties.filter((p) => wanted.has(p.api_name)).map((p) => p.api_name);
        const all = [...ids.keys()];
        const records: CrmRecord[] = [];
        for (let i = 0; i < all.length; i += 100) {
          const r = await api<{ results: CrmRecord[] }>('POST', `/v1/objects/${name}/batch/read`, { ids: all.slice(i, i + 100), properties: props });
          records.push(...r.results);
        }
        return { object: name, records: records.filter((r) => r.record_status === 'active').map((r) => ({ record: r, labels: ids.get(r.requested_id ?? r.id) ?? [] })) };
      } catch {
        return null;
      }
    })
  );
  return groups.filter((g): g is Associated => g !== null);
}

// Where the back link goes when the record was opened from somewhere other
// than its object's table (a custom view): navigation state, kept for this
// record while its own address changes (tabs).
export interface RecordBack {
  back: { to: string; label: string };
}

export function RecordPage() {
  const { object = '', id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const backFor = useRef<{ record: string; back: RecordBack['back'] } | null>(null);
  const given = (location.state as RecordBack | null)?.back;
  if (given && typeof given.to === 'string' && given.to.startsWith('/')) backFor.current = { record: `${object}/${id}`, back: given };
  const back = backFor.current?.record === `${object}/${id}` ? backFor.current.back : null;
  const { objects, objectByName, toast, me } = useApp();
  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [record, setRecord] = useState<CrmRecord | null>(null);
  const [associated, setAssociated] = useState<Associated[]>([]);
  const [error, setError] = useState<string | null>(null);
  // set when the user may not open this record but was @mentioned on it: the
  // activities they were tagged in (or this record, when it is one of them)
  const [mentioned, setMentioned] = useState<{ object: string; id: string }[] | null>(null);
  // bumped when a save changes a line's amount, so its parent can be offered the new total
  const [lineSaves, setLineSaves] = useState(0);
  // live updates (lib/live.ts): how often each watched record changed, the
  // properties that just changed (they flash), who changed each, and whether
  // the record went away while it was open (who changed it shows as a toast)
  const [versions, setVersions] = useState<Map<string, number>>(new Map());
  const [stamp, setStamp] = useState(0);
  const [flash, setFlash] = useState<Set<string> | null>(null);
  const [changedBy, setChangedBy] = useState<Record<string, string | null>>({});
  const [gone, setGone] = useState(false);
  const recordRef = useRef<CrmRecord | null>(null);
  recordRef.current = record;
  // the activity being written in the stream (the name card's buttons and each tab's own);
  // key changes on every ask so the box takes focus again
  // mode send: writing an email to send (EmailComposer) rather than logging one
  const [compose, setCompose] = useState<{ object: ComposeObject; key: number; mode?: 'send' } | null>(null);
  const [canSend, setCanSend] = useState(false);
  useEffect(() => { void loadCanSend().then(setCanSend); }, []);
  // whether the open composer has unsaved text
  const composeDirty = useRef(false);
  const onComposeDirty = useCallback((d: boolean) => { composeDirty.current = d; }, []);

  const labelOf = useCallback((o: string) => objectByName.get(o)?.label_singular ?? o, [objectByName]);
  const codeToName = useMemo(() => new Map(objects.map((o) => [o.object_type_id, o.api_name])), [objects]);

  // whether the links have come back once (the stream pins an opened activity it cannot list)
  const [linksLoaded, setLinksLoaded] = useState(false);
  const loadAssociations = useCallback(async () => {
    setAssociated(await loadLinked(object, id, codeToName));
    setLinksLoaded(true);
  }, [object, id, codeToName]);


  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    setError(null);
    setMentioned(null);
    setLinksLoaded(false);
    setVersions(new Map());
    setFlash(null);
    setChangedBy({});
    setGone(false);
    Promise.all([getSchema(object), api<CrmRecord>('GET', `/v1/objects/${object}/${id}`)])
      .then(([s, r]) => {
        if (cancelled) return;
        setSchema(s);
        // open only through an @mention: the activity alone, nothing around it
        if (r.via_mention) { setMentioned([{ object, id: r.id }]); return; }
        setRecord(r);
        if (r.id !== id) navigate(`/objects/${object}/${r.id}${window.location.search}`, { replace: true }); // merged id
      })
      .catch(async (err) => {
        if (cancelled) return;
        // no access: the activities on it the user was tagged in, if any
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          const m = await api<{ results: { object: string; id: string }[] }>('GET', `/v1/objects/${object}/${id}/mentioned`).catch(() => null);
          if (cancelled) return;
          if (m && m.results.length > 0) { setMentioned(m.results); return; }
        }
        setError((err as Error).message);
      });
    // users have no association cards or activity stream
    if (object !== 'users') loadAssociations().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [object, id, navigate, loadAssociations]);

  // a Stripe payment whose webhook went missing shows up once someone opens the record
  useEffect(() => {
    if (object !== 'quotes' && object !== 'invoices') return;
    let cancelled = false;
    api<{ changed: boolean }>('POST', `/v1/objects/${object}/${id}/check-payments`)
      .then(async ({ changed }) => {
        if (!changed || cancelled) return;
        await loadAssociations();
        const r = await api<CrmRecord>('GET', `/v1/objects/${object}/${id}`);
        if (!cancelled) setRecord(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [object, id, loadAssociations]);

  // after a card changes this record too (adding a line can update the deal amount)
  const refresh = async () => {
    await loadAssociations();
    setRecord(await api<CrmRecord>('GET', `/v1/objects/${object}/${id}`));
  };

  function saved(r: CrmRecord) {
    if (object === 'lines' && String(r.properties.amount ?? '') !== String(record?.properties.amount ?? '')) setLineSaves((n) => n + 1);
    setRecord(r);
  }

  async function archive() {
    if (!(await confirmDialog('You can restore it from the recycle bin later.', { title: 'Move this record to the recycle bin?', confirmLabel: 'Move to recycle bin', danger: true }))) return;
    // a line's deal, quote, ... is offered its new total once the line is gone
    const parents = object === 'lines' ? await parentsOfLines([id]).catch(() => []) : [];
    await api('DELETE', `/v1/objects/${object}/${id}`);
    await offerAmountUpdates(parents, labelOf).catch(() => 0);
    navigate(`/objects/${object}`);
  }

  async function restore() {
    setRecord(await api<CrmRecord>('POST', `/v1/objects/${object}/${id}/restore`));
    toast('Restored');
  }

  // admins only: wipes every value and the history, keeping only the id
  async function removeForGood() {
    if (!(await confirmDialog('Every value, link and change history is erased for good. This cannot be undone.', { title: 'Permanently delete this record?', confirmLabel: 'Delete permanently', danger: true }))) return;
    await api('POST', `/v1/objects/${object}/${id}/permanently-delete`, { confirm: id });
    toast('Permanently deleted');
    navigate(`/objects/${object}?status=archived`);
  }

  // Live updates: this record and everything linked to it (activities
  // included, so their edits and comments show). Another person's change
  // flashes the changed properties and names them; a value being edited here
  // is never replaced (PropertyList says it changed instead).
  const recordId_ = record?.id;
  // An activity opened from a link (?pc_0032=<id>) is watched too: the stream
  // may not list it (an @mention opened it), and then it is pinned above.
  const openedActivity = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return ACTIVITY_OBJECTS.flatMap((o) => {
      const code = objectByName.get(o)?.object_type_id;
      const rid = code ? params.get(code) : null;
      return rid ? [`${o}:${rid}`] : [];
    });
  }, [location.search, objectByName]);
  const watch = useMemo(() => {
    if (!recordId_) return [];
    const keys = [`${object}:${recordId_}`, ...openedActivity, ...associated.flatMap((a) => a.records.map((r) => `${a.object}:${r.record.id}`))];
    return [...new Set(keys)].slice(0, 200);
  }, [object, recordId_, associated, openedActivity]);
  const onLive = useCallback(async (events: LiveEvents) => {
    setVersions((prev) => bumpVersions(prev, events, watch));
    setStamp((n) => n + 1);
    if (object !== 'users') loadAssociations().catch(() => undefined);
    const mine = events === 'all' ? [] : events.filter((e) => e.object === object && e.id === id);
    if (events !== 'all' && mine.length === 0) return;
    let r: CrmRecord;
    try {
      r = await api<CrmRecord>('GET', `/v1/objects/${object}/${id}`);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) setGone(true);
      return;
    }
    // no longer readable through the role (only an @mention left)
    if (r.via_mention) { setGone(true); return; }
    // merged into another record
    if (r.id !== id) { navigate(`/objects/${object}/${r.id}${window.location.search}`, { replace: true }); return; }
    setGone(false);
    const before = recordRef.current;
    const keys = before
      ? Object.keys({ ...before.properties, ...r.properties }).filter((k) => JSON.stringify(before.properties[k] ?? null) !== JSON.stringify(r.properties[k] ?? null))
      : [];
    const others = mine.filter((e) => !e.self);
    if (keys.length && (others.length || events === 'all')) {
      setFlash(new Set(keys));
      const person = others.find((e) => e.by?.name)?.by?.name ?? null;
      setChangedBy((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [k, person])) }));
      // people only: calculations follow other changes and need no note
      const people = [...new Set(others.filter((e) => e.by?.name && !e.by.actor.startsWith('system:')).map((e) => e.by!.name!))];
      if (people.length) {
        const more = people.length - 1;
        toast(`Updated by ${people[0]}${more ? ` and ${more} other${more > 1 ? 's' : ''}` : ''}`);
      }
    }
    setRecord(r);
  }, [object, id, watch, loadAssociations, navigate, toast]);
  useLiveRecords(watch, (events) => void onLive(events));
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2400);
    return () => window.clearTimeout(t);
  }, [flash]);
  const live = useMemo(() => ({ versions, stamp }), [versions, stamp]);

  // whether the user on a user record is a Super Admin (from their roles), for "Sign in as"
  const [userSuperAdmin, setUserSuperAdmin] = useState<{ id: string; admin: boolean } | null>(null);

  if (mentioned) return <MentionedOnly object={object} id={id} items={mentioned} back={back} />;
  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!schema || !record) return <RecordSkeleton />;
  const name = recordName(record);
  const subtitle = ['email', 'domain', 'job_title'].map((k) => record.properties[k]).find((v) => typeof v === 'string' && v) as string | undefined;
  const linksTo = objectByName.get(object)?.links_to ?? [];
  // every object that can hold line items (custom ones too) shows the card
  const lineCard = object !== 'products' && object !== 'lines' && linksTo.includes('lines') ? ['lines'] : [];
  const cards = [...new Set([...(DEFAULT_CARDS_FOR[object] ?? DEFAULT_CARDS).filter((o) => o !== object && objectByName.has(o) && linksTo.includes(o)), ...lineCard, ...associated.map((a) => a.object)])]
    // a form lists its submissions and a booking page its meetings as a card; elsewhere they are activities
    .filter((o) => !(ACTIVITY_OBJECTS as readonly string[]).includes(o) || (object === 'forms' && o === 'form_submissions') || (object === 'booking_pages' && o === 'calls') || object === 'comments')
    // comments show in the thread on the record they are on
    .filter((o) => o !== 'comments')
    .filter((o) => object !== 'lines' || o === 'products')
    // a quote's template is picked in its Template card
    .filter((o) => o !== 'document_templates');
  const lineCount = associated.find((a) => a.object === 'lines')?.records.length ?? 0;
  const isUser = object === 'users';
  // an accepted or signed quote is archived by Super Admins only (migration 0084; the API refuses others)
  const quoteStatus = Array.isArray(record.properties.status) ? record.properties.status[0] : record.properties.status;
  const archiveLocked = object === 'quotes' && !me?.is_admin
    && (quoteStatus === 'accepted' || quoteStatus === 'pending_countersign' || !!record.properties.customer_signed_at);
  // the Standard quote template came with the CRM: it can be archived, never deleted (migration 0080)
  const builtIn = object === 'document_templates' && String(Array.isArray(record.properties.is_builtin) ? record.properties.is_builtin[0] : record.properties.is_builtin) === 'true';
  // "Sign in as": Super Admins, on another active user who is not a Super Admin
  // (the API checks all of this again)
  const canSignInAs = isUser && me?.is_admin && !me.signed_in_as_by && record.record_status === 'active'
    && record.id !== me.user?.id && userSuperAdmin?.id === record.id && !userSuperAdmin.admin;
  const recordId = record.id;
  async function signInAs() {
    if (!(await confirmDialog('Until you go back to your own account you will see and do everything as them, with their permissions, and every change is recorded as theirs.', { title: `Sign in as ${name}?`, confirmLabel: 'Sign in as them' }))) return;
    try {
      await api('POST', `/v1/users/${recordId}/sign-in-as`);
      // a full load, so the menu, objects and views are theirs
      window.location.assign('/');
    } catch (err) {
      await alertDialog((err as Error).message, { title: 'Could not sign in as this user' });
    }
  }
  // views link to nothing, so they have no association cards: no right column.
  // Document templates use the room for their code and preview (the quotes
  // using a template show it on their own pages).
  const noRight = isUser || object === 'views' || object === 'document_templates';
  // the pages with an activity stream get the name card's Call, Email, Note and Task buttons
  const hasStream = !isUser && !['forms', 'booking_pages', 'form_submissions'].includes(object);
  const composable = hasStream && record.record_status !== 'archived'
    ? COMPOSE_OBJECTS.filter((o) => objectByName.has(o) && linksTo.includes(o)) : [];
  // opens the box on that activity's tab; a draft of another kind is only thrown away once confirmed
  async function startCompose(o: ComposeObject, mode?: 'send') {
    if (compose && (compose.object !== o || compose.mode !== mode) && composeDirty.current) {
      const was = (objectByName.get(compose.object)?.label_singular ?? compose.object).toLowerCase();
      if (!(await confirmDialog(`Your ${was} is not saved. Starting a ${(objectByName.get(o)?.label_singular ?? o).toLowerCase()} throws it away.`,
        { title: `Discard this ${was}?`, confirmLabel: 'Discard', danger: true }))) return;
    }
    if (compose?.object !== o || compose.mode !== mode) composeDirty.current = false;
    setCompose({ object: o, key: Date.now(), mode });
    const next = new URLSearchParams(location.search);
    next.set('tab', o);
    navigate({ search: `?${next.toString()}` }, { replace: true });
  }
  // calls, emails, notes, tasks, submissions, participations and occurrences carry a comment thread
  const commentThread = COMMENT_TARGETS.includes(object) && (
    <div className="card record-comments">
      <Comments object={object} id={record.id} readOnly={record.record_status === 'archived'} highlight={new URLSearchParams(location.search).get('comment')} />
    </div>
  );
  const streamProps = { linksLoaded, object, id, record, associated, onChanged: loadAssociations, schema, compose, onComposeDirty, canSend, onCompose: (o: ComposeObject | null, mode?: 'send') => { if (o) void startCompose(o, mode); else { composeDirty.current = false; setCompose(null); } } };

  return (
    <LiveContext.Provider value={live}>
    <SnippetRecordProvider object={object} id={id}>
    <div className={`record-page${noRight ? ' two-col' : ''}`}>
      <aside className="record-left">
        <div className="record-head">
          <div className="record-head-bar">
            <Link to={back?.to ?? `/objects/${object}`} className="back">
              <ChevronLeft size={16} /> {back?.label ?? schema.label_plural}
            </Link>
            <Menu
              align="right"
              trigger={(toggle) => (
                <button className="icon-btn" onClick={toggle} aria-label="Record actions">
                  <EllipsisVertical size={18} />
                </button>
              )}
            >
              {(close) => (
                record.record_status === 'archived'
                  ? (
                    <>
                      <button onClick={() => { close(); restore(); }}>Restore</button>
                      {me?.is_admin && !builtIn && <button className="danger" onClick={() => { close(); removeForGood(); }}>Delete permanently</button>}
                    </>
                  )
                  : (
                    <>
                      {canSignInAs && <button onClick={() => { close(); signInAs(); }}>Sign in as {name}</button>}
                      {archiveLocked
                        ? <button disabled title="Only a Super Admin can archive an accepted or signed quote">Archive (Super Admin only)</button>
                        : <button className="danger" onClick={() => { close(); archive(); }}>Archive</button>}
                    </>
                  )
              )}
            </Menu>
          </div>
          {record.record_status === 'archived' && (
            <div className="record-archived" role="status">
              <Archive size={15} strokeWidth={1.75} aria-hidden />
              <span>This record is archived (in the recycle bin).</span>
              {schema.permissions.delete && (
                <div className="record-archived-actions">
                  <button className="btn small" onClick={restore}>Restore</button>
                  {me?.is_admin && !builtIn && <button className="btn small danger-text" onClick={removeForGood}>Delete permanently</button>}
                </div>
              )}
            </div>
          )}
          {gone && (
            <div className="record-archived" role="status">
              <Archive size={15} strokeWidth={1.75} aria-hidden />
              <span>This record was deleted, or you can no longer see it. The page shows it as it was.</span>
            </div>
          )}
          <div className="record-identity">
            {object === 'views' ? <ViewIconAvatar record={record} onChanged={setRecord} /> : <span className="record-avatar">{initials(name)}</span>}
            <div className="record-title">
              <h1>{name}</h1>
              {subtitle && subtitle !== name && <div className="record-subtitle">{subtitle}</div>}
            </div>
          </div>
          {composable.length > 0 && (
            <div className="record-quick-actions">
              {composable.map((o) => {
                const Icon = objectIcon(o);
                const label = objectByName.get(o)?.label_singular ?? o;
                // with a mailbox, Email writes one to send (logging stays on the Emails tab)
                const send = o === 'emails' && canSend;
                const verb = send ? 'Write' : COMPOSE_VERB[o];
                return (
                  <button key={o} onClick={() => void startCompose(o, send ? 'send' : undefined)} aria-label={`${verb} ${label.toLowerCase()}`} title={`${verb} ${label.toLowerCase()}`}>
                    <span className="quick-icon"><Icon size={16} strokeWidth={1.75} /></span>
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {isUser && <UserRoles userId={record.id} onLoaded={(roles) => setUserSuperAdmin({ id: record.id, admin: roles.some((r) => r.is_admin) })} />}
        <PropertyList schema={schema} record={record} lock={recordLock(object, record, associated)} onSaved={saved} flash={flash} changedBy={changedBy} />
      </aside>

      {isUser ? (
        <section className="record-middle">
          <UserHistory object={object} id={record.id} schema={schema} />
        </section>
      ) : (
        <>
          <section className="record-middle">
            {object === 'forms' ? (
              <FormBuilder record={record} onSaved={setRecord} />
            ) : object === 'booking_pages' ? (
              <BookingPageEditor record={record} onSaved={setRecord} />
            ) : object === 'form_submissions' ? (
              <>
                <SubmissionAnswers record={record} />
                {commentThread}
              </>
            ) : object === 'email_campaigns' ? (
              record.record_status === 'archived'
                ? <div className="card muted">Archived campaigns are not sent. Restore this campaign to work on it.</div>
                : <EmailCampaignEditor record={record} onChanged={setRecord} />
            ) : object === 'document_templates' ? (
              <>
                {record.record_status === 'archived'
                  ? <div className="card muted">Archived templates are not used. Restore this template to see its code.</div>
                  : <DocumentTemplateEditor record={record} onChanged={setRecord} />}
                <ActivityStream {...streamProps} />
              </>
            ) : object === 'views' ? (
              <>
                {record.record_status === 'archived'
                  ? <div className="card muted">Archived views do not open. Restore this view to see its code.</div>
                  : <ViewCode record={record} onChanged={setRecord} />}
                <ActivityStream {...streamProps} />
              </>
            ) : (
              <>
                {commentThread}
                <ActivityStream {...streamProps} />
              </>
            )}
          </section>

          {!noRight && <aside className="record-right">
            {(object === 'quotes' || object === 'invoices' || object === 'forms' || object === 'booking_pages') && <PublicLinkCard object={object} record={record} onChanged={setRecord} />}
            {object === 'payments' && <PaymentConfirmCard record={record} onChanged={setRecord} />}
            {object === 'quotes' && <QuoteTemplateCard quoteId={record.id} canEdit={schema.permissions.edit && record.can_edit !== false} />}
            {object === 'quotes' && <QuoteSigningCard record={record} onChanged={setRecord} />}
            {object === 'files' && <FileCard record={record} />}
            {object === 'lines' && <LineParentCard selfId={id} associated={associated} saves={lineSaves} onChanged={loadAssociations} />}
            {cards.map((o) => (
              <AssociationCard key={o} self={object} selfId={id} selfRecord={record} other={o} items={associated.find((a) => a.object === o)?.records ?? []} lineCount={lineCount} linked={associated} onChanged={refresh} />
            ))}
          </aside>}
        </>
      )}
    </div>
    </SnippetRecordProvider>
    </LiveContext.Provider>
  );
}

const isHtml = (p: Property) => p.type === 'text' && p.options.display === 'html';
const isCode = (p: Property) => p.type === 'text' && p.options.display === 'code';

// A left-side value: code in a grey monospace box, anything else as text;
// both cut to six lines with Show more when longer.
function propValue(p: Property, value: unknown): ReactNode {
  if (isCode(p) && typeof value === 'string' && value) return <ShowMore as="pre" className="prop-code">{value}</ShowMore>;
  const shown = displayValue(p, value);
  if (!shown) return <span className="muted empty-value">--</span>;
  return <ShowMore as="div">{shown}</ShowMore>;
}

const HTML_HINTS: Record<string, string> = {
  'users.email_signature': 'Added to the end of emails this user sends. Images must be public links: upload one to CRM files (its public link is turned on), choose a CRM file, or use a public web address. Scripts and forms are removed on save.'
};

// flash: properties someone else just changed; changedBy: who changed each (live updates)
function PropertyList({ schema, record, lock, onSaved, flash = null, changedBy = {} }: {
  schema: ObjectDef; record: CrmRecord; lock: RecordLock | null; onSaved: (r: CrmRecord) => void;
  flash?: Set<string> | null; changedBy?: Record<string, string | null>;
}) {
  const { toast } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // the value when editing started: if it changes underneath (someone else
  // saved it), the box keeps what is being typed and says so
  const startValue = useRef('null');
  // false when the editor reopens after a refused save: it shows the text
  // without taking focus back from wherever the user went
  const [focusEditor, setFocusEditor] = useState(true);
  // a refused save, shown under that property; failed: the value refused
  const [error, setError] = useState<{ property: string; message: string; failed: string } | null>(null);
  // collapsed sections; System starts closed
  const [closed, setClosed] = useState<Record<string, boolean>>({ system: true });
  // an HTML property (display "html": email signatures, template bodies) open
  // in the editor with its preview
  const [htmlEditing, setHtmlEditing] = useState<Property | null>(null);
  const addressGroups = useAddressGroups(schema.api_name);
  const shown = schema.properties.filter((p) => p.record_status === 'active' && !['object_type_id', 'merged_ids', ...(HIDDEN_PROPS[schema.api_name] ?? [])].includes(p.api_name));
  // each address group's properties together, in order (Settings → Address autocomplete)
  const main = withAddressesTogether(shown.filter((p) => !p.is_base || p.api_name === 'name'), addressGroups);
  const system = shown.filter((p) => p.is_base && p.api_name !== 'name');
  // without edit access (the role, or this record only through a read-only
  // sharing rule) every property is locked, like a calculation; a save's
  // reply has no can_edit, which counts as editable
  const canEdit = schema.permissions.edit && record.can_edit !== false;
  const locked = (p: Property) => !!lock && (lock.props === 'all' || lock.props.includes(p.api_name));
  const editable = (p: Property) => canEdit && isEditable(p) && !locked(p);

  function start(p: Property) {
    if (!editable(p)) return;
    if (isHtml(p)) {
      setHtmlEditing(p);
      return;
    }
    setEditing(p.api_name);
    setFocusEditor(true);
    startValue.current = JSON.stringify(record.properties[p.api_name] ?? null);
    // after a refused save, carry on from the refused text
    setDraft(error?.property === p.api_name ? error.failed : toInput(p, record.properties[p.api_name]));
    if (error?.property !== p.api_name) setError(null);
  }

  // A refused value stays in the box with the reason under it; it is not
  // saved, and leaving it unchanged does not try again.
  async function commit(p: Property, final?: string) {
    if (editing !== p.api_name) return;
    const text = final ?? draft;
    const value = fromInput(p, text);
    const before = JSON.stringify(record.properties[p.api_name] ?? null);
    setEditing(null);
    // unchanged here: nothing to save (and never put back a value someone else just changed)
    if (JSON.stringify(value) === before || JSON.stringify(value) === startValue.current) {
      setError(null);
      return;
    }
    if (error?.property === p.api_name && error.failed === text) {
      setEditing(p.api_name);
      setFocusEditor(false);
      return;
    }
    try {
      onSaved(await api<CrmRecord>('PATCH', `/v1/objects/${schema.api_name}/${record.id}`, { properties: { [p.api_name]: value } }));
      setError(null);
      toast('Saved');
    } catch (err) {
      // the message names the property; under the field that is redundant
      const raw = (err as Error).message;
      const message = raw.startsWith(`${p.label}: `) ? raw.slice(p.label.length + 2) : raw;
      setError({ property: p.api_name, message, failed: text });
      setDraft(text);
      setEditing(p.api_name);
      setFocusEditor(false);
    }
  }

  // A picked address (Settings → Address autocomplete): the street and the
  // rest of its group are saved together.
  async function fill(p: Property, values: Record<string, string>) {
    if (editing !== p.api_name) return;
    setEditing(null);
    const properties: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(values)) {
      const prop = schema.properties.find((x) => x.api_name === name);
      if (!prop || !editable(prop)) continue;
      const v = fromInput(prop, text);
      if (JSON.stringify(v) !== JSON.stringify(record.properties[name] ?? null)) properties[name] = v;
    }
    if (Object.keys(properties).length === 0) {
      setError(null);
      return;
    }
    try {
      onSaved(await api<CrmRecord>('PATCH', `/v1/objects/${schema.api_name}/${record.id}`, { properties }));
      setError(null);
      toast('Address saved');
    } catch (err) {
      const text = values[p.api_name] ?? '';
      setError({ property: p.api_name, message: (err as Error).message, failed: text });
      setDraft(text);
      setEditing(p.api_name);
      setFocusEditor(false);
    }
  }

  const section = (key: string, title: string, props: Property[]) => {
    const open = !closed[key];
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <section className={`prop-section ${key}`}>
        <button className="prop-section-head" aria-expanded={open} onClick={() => setClosed((c) => ({ ...c, [key]: open }))}>
          <Chevron size={16} />
          <h3>{title}</h3>
          {key === 'main' && !canEdit && <span className="push-right"><StatusPill tone="off">View only</StatusPill></span>}
          {key === 'main' && canEdit && lock?.props === 'all' && <span className="push-right" title={lock.reason}><StatusPill tone="off">Locked</StatusPill></span>}
          {!open && <span className="prop-section-count">{props.length}</span>}
        </button>
        {open && <div className="prop-section-body">{props.map((p) => row(p, key === 'main' && canEdit))}</div>}
      </section>
    );
  };

  // showLock: mark properties nobody can edit here (calculations, read-only),
  // in the main section only; System is all set by the CRM
  const row = (p: Property, showLock: boolean) => (
    <div key={p.api_name} className={`prop-row${editable(p) ? ' editable' : ''}${editing === p.api_name ? ' editing' : ''}${isHtml(p) ? ' html' : ''}${flash?.has(p.api_name) && editing !== p.api_name ? ' live-changed' : ''}`} onClick={() => editing !== p.api_name && start(p)}>
      <div className="prop-label">
        <span>{p.label}</span>
        {editable(p) && editing !== p.api_name && <Pencil className="prop-hint" size={12} aria-hidden />}
        {showLock && !editable(p) && p.type !== 'file' && (
          locked(p)
            ? <span className="prop-lock" title={lock!.reason}><Lock size={12} aria-label={lock!.reason} /></span>
            : <Lock className="prop-lock" size={12} aria-label="Read only" />
        )}
      </div>
      {editing === p.api_name ? (
        <div className="prop-edit" onClick={(e) => e.stopPropagation()}>
          <PropertyInput property={p} object={schema.api_name} value={draft} onChange={setDraft} autoFocus={focusEditor} onCommit={(v) => commit(p, v)} onFill={(values) => fill(p, values)} />
          {p.type === 'dropdown' && p.options.single_value !== true && (
            <button className="btn small" onClick={() => commit(p)}>Save</button>
          )}
        </div>
      ) : p.type === 'file' ? (
        <div className="prop-value">
          <FileField object={schema.api_name} record={record} property={p} canEdit={canEdit && p.record_status === 'active' && !p.read_only} onSaved={onSaved} />
        </div>
      ) : isHtml(p) && typeof record.properties[p.api_name] === 'string' && record.properties[p.api_name] ? (
        <div className="prop-value">
          <HtmlValue html={record.properties[p.api_name] as string} title={p.label} onEdit={editable(p) ? () => start(p) : undefined} />
        </div>
      ) : (
        <div className="prop-value">{propValue(p, record.properties[p.api_name])}</div>
      )}
      {editing === p.api_name && JSON.stringify(record.properties[p.api_name] ?? null) !== startValue.current && (
        <div className="prop-conflict" role="status">
          {changedBy[p.api_name] ?? 'Someone else'} changed this to {displayValue(p, record.properties[p.api_name]) || 'nothing'} while you were editing. Saving replaces it.
        </div>
      )}
      {error?.property === p.api_name && <div className="error prop-error" role="alert">{error.message}</div>}
    </div>
  );

  return (
    <div className="props">
      {section('main', `About this ${schema.label_singular.toLowerCase()}`, main)}
      {section('system', 'System', system)}
      {htmlEditing && (
        <HtmlEditorModal
          title={`Edit ${htmlEditing.label.toLowerCase()}`}
          value={typeof record.properties[htmlEditing.api_name] === 'string' ? record.properties[htmlEditing.api_name] as string : ''}
          hint={HTML_HINTS[`${schema.api_name}.${htmlEditing.api_name}`]}
          onClose={() => setHtmlEditing(null)}
          onSave={async (html) => {
            onSaved(await api<CrmRecord>('PATCH', `/v1/objects/${schema.api_name}/${record.id}`, { properties: { [htmlEditing.api_name]: html.trim() ? html : null } }));
            setHtmlEditing(null);
            toast('Saved');
          }}
        />
      )}
    </div>
  );
}

type Tab = 'activity' | (typeof ACTIVITY_OBJECTS)[number] | 'changes';

type HistoryVia = 'crm_ui' | 'api' | 'mcp' | 'calculation' | 'other';

interface HistoryRow {
  property: string;
  old_value: unknown;
  new_value: unknown;
  changed_at: string;
  changed_by: string;
  source: string;
  via: HistoryVia;
  changed_by_name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
}

interface HistoryFacets {
  properties: string[];
  changed_by: { changed_by: string; name: string | null }[];
  via: HistoryVia[];
}

const TASK_TONES: Record<string, Tone> = { not_started: 'off', in_progress: 'info', waiting: 'pending', completed: 'on' };

const VIA_LABELS: Record<HistoryVia, string> = { crm_ui: 'CRM UI', api: 'API', mcp: 'MCP', calculation: 'Calculation', other: 'Other' };

function activityTime(object: string, r: CrmRecord): string {
  const p = r.properties;
  const t = object === 'calls' ? p.started_at : object === 'emails' ? p.sent_at : object === 'tasks' ? p.due_at : object === 'form_submissions' ? p.submitted_at : null;
  return String(t ?? p.created_at ?? '');
}

// What the activity search looks through: title, body, people and answers.
function searchText(object: string, r: CrmRecord): string {
  const p = r.properties;
  const answers = object === 'form_submissions' ? answersOf(r).map((a) => `${a.label} ${a.value}`).join(' ') : '';
  return [p.name, p.subject, mentionsAsText(plain(p.body)), p.from_address, p.to_addresses, p.responder_name, p.responder_email, answers]
    .filter((v) => v !== null && v !== undefined).map(String).join(' ');
}

function plain(text: unknown): string {
  if (typeof text !== 'string') return '';
  // email bodies are HTML; show text only (never inject it as markup)
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// The tab is in ?tab= and an opened activity in ?pc_<object code>=<record id>,
// so a copied link brings back both.
function activitySearch(params: URLSearchParams, tab: Tab, open: { code: string; id: string } | null, codes: string[]): string {
  const next = new URLSearchParams(params);
  if (tab === 'activity') next.delete('tab');
  else next.set('tab', tab);
  for (const c of codes) next.delete(c);
  if (open) next.set(open.code, open.id);
  const q = next.toString();
  return q ? `?${q}` : '';
}

function ActivityStream({ linksLoaded, object, id, record, associated, onChanged, schema, compose, onCompose, onComposeDirty, canSend }: {
  linksLoaded: boolean; object: string; id: string; record: CrmRecord; associated: Associated[]; onChanged: () => Promise<void>; schema: ObjectDef;
  compose: { object: ComposeObject; key: number; mode?: 'send' } | null; onCompose: (o: ComposeObject | null, mode?: 'send') => void; onComposeDirty: (dirty: boolean) => void;
  canSend: boolean;
}) {
  const { objectByName, toast } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const liveStamp = useLiveStamp();
  const linksTo = objectByName.get(object)?.links_to ?? [];
  const tabs: Tab[] = ['activity', ...ACTIVITY_OBJECTS.filter((o) => objectByName.has(o) && linksTo.includes(o)), 'changes'];
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = tabParam && tabs.includes(tabParam) ? tabParam : 'activity';
  const codeOf = (o: string) => objectByName.get(o)?.object_type_id ?? '';
  const codes = ACTIVITY_OBJECTS.map(codeOf).filter(Boolean);
  const opened = ACTIVITY_OBJECTS.map((o) => ({ object: o, id: codeOf(o) ? params.get(codeOf(o)) : null })).find((x) => x.id) as { object: string; id: string } | undefined;
  const searchFor = (t: Tab, o: string | null, rid?: string) => activitySearch(params, t, o ? { code: codeOf(o), id: rid ?? '' } : null, codes);
  const go = (search: string) => navigate({ search }, { replace: true });
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [days, setDays] = useState('');

  // A customer accepting, signing or declining a quote (on the quote's page
  // and on the pages of records linked to it), taken from the quote's
  // responded_* values, or customer_signed_at while it awaits a countersignature.
  const quotes = [
    ...(object === 'quotes' ? [record] : []),
    ...(associated.find((a) => a.object === 'quotes')?.records.map((r) => r.record) ?? [])
  ];
  const quoteEvents = tab !== 'activity' ? [] : quotes.flatMap((q) => {
    const status = String(q.properties.status);
    const at = status === 'pending_countersign' ? q.properties.customer_signed_at : ['accepted', 'rejected'].includes(status) ? q.properties.responded_at : null;
    return typeof at === 'string' ? [{ object: 'quotes', record: q, at, quoteResponse: true }] : [];
  });

  const allItems = [
    ...associated
      .filter((a) => (ACTIVITY_OBJECTS as readonly string[]).includes(a.object) && (tab === 'activity' || tab === a.object))
      .flatMap((a) => a.records.map((r) => ({ object: a.object, record: r.record, at: activityTime(a.object, r.record), quoteResponse: false }))),
    ...quoteEvents
  ].sort((x, y) => y.at.localeCompare(x.at));

  // the type filter is for the Activity tab; the other tabs are one type already
  const kindFilter = tab === 'activity' ? kind : '';
  const filtered = !!(search.trim() || kindFilter || days);
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const since = days ? Date.now() - Number(days) * 86400000 : null;
  const items = allItems.filter((x) => {
    if (kindFilter && (x.quoteResponse ? 'quotes' : x.object) !== kindFilter) return false;
    if (since !== null && !(x.at && localDate(x.at).getTime() >= since)) return false;
    if (words.length === 0) return true;
    const text = searchText(x.object, x.record).toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const kinds = [...new Set(allItems.map((x) => (x.quoteResponse ? 'quotes' : x.object)))];
  const clearFilters = () => { setSearch(''); setKind(''); setDays(''); };

  // each call, email, note and task tab has its own button; the box shows on that tab only
  const composeTab = (COMPOSE_OBJECTS as readonly string[]).includes(tab) && record.record_status !== 'archived' ? tab as ComposeObject : null;
  const composing = !!composeTab && compose?.object === composeTab;
  const createButton = composeTab && !composing && (
    <span className="activity-create">
      {composeTab === 'emails' && canSend && (
        <button className="btn small" onClick={() => onCompose('emails', 'send')}><Plus size={14} /> Write email</button>
      )}
      <button className="btn small" onClick={() => onCompose(composeTab)}>
        <Plus size={14} /> {COMPOSE_VERB[composeTab]} {(objectByName.get(composeTab)?.label_singular ?? composeTab).toLowerCase()}
      </button>
    </span>
  );
  // who to suggest in To, Cc and Bcc, and which files to offer as attachments
  const contactOf = (r: CrmRecord): Recipient | null => {
    const email = typeof r.properties.email === 'string' ? r.properties.email.trim().toLowerCase() : '';
    return email ? { email, name: displayName(r.properties, r.id) || null } : null;
  };
  const pageContact = object === 'contacts' ? contactOf(record) : null;
  const recipients = [
    ...(pageContact ? [pageContact] : []),
    ...(associated.find((a) => a.object === 'contacts')?.records.map((r) => contactOf(r.record)) ?? [])
  ].filter((c, i, all): c is Recipient => !!c && all.findIndex((x) => x?.email === c.email) === i);
  const attachable: Attachable[] = (associated.find((a) => a.object === 'files')?.records ?? []).map((r) => ({
    id: r.record.id, name: displayName(r.record.properties, r.record.id), size_bytes: typeof r.record.properties.size_bytes === 'number' ? r.record.properties.size_bytes : null
  }));

  const countOf = (o: string) => associated.find((a) => a.object === o)?.records.length ?? 0;

  // comments on each listed activity, for the count on collapsed entries
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const activityIds = associated
    .filter((a) => (ACTIVITY_OBJECTS as readonly string[]).includes(a.object) && COMMENT_TARGETS.includes(a.object))
    .map((a) => `${a.object}:${a.records.map((r) => r.record.id).join(',')}`).join('|');
  useEffect(() => {
    let cancelled = false;
    const next: Record<string, number> = {};
    Promise.all(activityIds.split('|').filter(Boolean).map(async (part) => {
      const [o, list] = part.split(':') as [string, string];
      const ids = list.split(',').filter(Boolean);
      for (let i = 0; i < ids.length; i += 100) {
        const r = await api<{ counts: Record<string, number> }>('POST', '/v1/comments/counts', { object: o, ids: ids.slice(i, i + 100) });
        for (const [rid, n] of Object.entries(r.counts)) next[`${o}-${rid}`] = n;
      }
    }))
      .then(() => { if (!cancelled) setCommentCounts(next); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [activityIds, liveStamp]);

  // a link to an activity scrolls to it once it has loaded
  const scrolledTo = useRef<string | null>(null);
  const openedKey = opened ? `${opened.object}-${opened.id}` : null;
  const openedListed = items.some((x) => !x.quoteResponse && `${x.object}-${x.record.id}` === openedKey);
  // a linked activity the stream cannot list (the role cannot read it, but an
  // @mention opens it): shown on its own above the stream, on the Activity tab
  // and its own type's tab only (checked against every linked activity, not
  // just this tab's, so a listed note is not pinned on the Tasks tab)
  const openedHidden = !!opened && linksLoaded && (tab === 'activity' || tab === opened.object)
    && !associated.some((a) => a.object === opened.object && a.records.some((r) => r.record.id === opened.id));
  useEffect(() => {
    if (!openedKey || !openedListed || scrolledTo.current === openedKey) return;
    scrolledTo.current = openedKey;
    document.getElementById(`activity-${openedKey}`)?.scrollIntoView({ block: 'center' });
  }, [openedKey, openedListed]);

  // a copied link opens the activity in its own tab, whichever tab it was copied from
  async function copyLink(o: string, rid: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}${searchFor(o as Tab, o, rid)}`);
      toast('Link copied');
    } catch {
      toast('Could not copy the link');
    }
  }

  return (
    <div className="activity">
      <div className="tabs">
        {tabs.map((t) => (
          <div key={t} className={`tab${tab === t ? ' active' : ''}`}>
            <button onClick={() => go(searchFor(t, opened?.object ?? null, opened?.id))}>
              {t === 'activity' ? 'Activity' : t === 'changes' ? 'Changes' : objectByName.get(t)?.label_plural}
              {t !== 'activity' && t !== 'changes' && countOf(t) > 0 && <span className="tab-count">{countOf(t)}</span>}
            </button>
          </div>
        ))}
      </div>
      {/* kept (hidden) on the other tabs, so a draft survives a look around */}
      {compose && record.record_status !== 'archived' && (compose.mode === 'send' ? (
        <Suspense fallback={<div className="composer email-composer muted small" hidden={!composing}>Opening the email…</div>}>
          <EmailComposer key="send" hidden={!composing} page={{ object, id }} pageLabel={schema.label_singular} focusKey={compose.key} onDirty={onComposeDirty}
            recipients={recipients} prefill={pageContact ? [pageContact.email] : []} attachable={attachable}
            onSent={async () => { onCompose(null); await onChanged(); }} onCancel={() => onCompose(null)} />
        </Suspense>
      ) : (
        <ActivityComposer key={compose.object} hidden={!composing} object={compose.object} page={{ object, id }} pageLabel={schema.label_singular} focusKey={compose.key} onDirty={onComposeDirty}
          onSaved={async () => { onCompose(null); await onChanged(); }} onCancel={() => onCompose(null)} />
      ))}
      {openedHidden && opened && tab !== 'changes' && (
        <MentionedActivity object={opened.object} id={opened.id} highlight={params.get('comment')} quiet pinned />
      )}
      {tab === 'changes' ? (
        <ChangeHistory object={object} id={id} schema={schema} />
      ) : (
        <div className="timeline">
          {allItems.length === 0 && createButton && <div className="field-row history-filters">{createButton}</div>}
          {allItems.length > 0 && (
            <div className="field-row history-filters">
              <input type="search" className="activity-search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search activity" />
              {tab === 'activity' && kinds.length > 1 && (
                <Select value={kind} onChange={(v) => setKind(v)} aria-label="Type">
                  <option value="">Every type</option>
                  {kinds.map((k) => <option key={k} value={k}>{k === 'quotes' ? 'Quote responses' : objectByName.get(k)?.label_plural ?? k}</option>)}
                </Select>
              )}
              <Select value={days} onChange={(v) => setDays(v)} aria-label="Time">
                <option value="">Any time</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="365">Last 12 months</option>
              </Select>
              {filtered && <button className="btn small" onClick={clearFilters}>Clear</button>}
              {createButton}
            </div>
          )}
          {items.length === 0 && filtered && allItems.length > 0 && (
            <EmptyState icon={<Inbox size={18} />} title="Nothing matches these filters" action={<button className="btn small" onClick={clearFilters}>Clear filters</button>}>
              Try other words, another type or a longer time.
            </EmptyState>
          )}
          {/* under a pinned activity the big empty state would contradict it */}
          {allItems.length === 0 && openedHidden && (
            <p className="stream-none-else">
              {tab === 'activity'
                ? `No other activity on this ${schema.label_singular.toLowerCase()} that you can see.`
                : `No other ${(objectByName.get(tab)?.label_plural ?? '').toLowerCase()} on this ${schema.label_singular.toLowerCase()} that you can see.`}
            </p>
          )}
          {allItems.length === 0 && !openedHidden && (
            <EmptyState icon={<Inbox size={18} />} title={tab === 'activity' ? 'No activity yet' : `No ${(objectByName.get(tab)?.label_plural ?? '').toLowerCase()} yet`}>
              {tab === 'activity'
                ? `Calls, emails, notes and tasks linked to this ${schema.label_singular.toLowerCase()} show here, newest first.`
                : `${objectByName.get(tab)?.label_plural} linked to this ${schema.label_singular.toLowerCase()} show here.`}
            </EmptyState>
          )}
          {byDay(items, (x) => x.at).map(({ day, rows }) => (
            <LedgerDay key={day} day={day}>
          {rows.map(({ object: o, record: r, at, quoteResponse }) => {
            const Icon = objectIcon(o);
            const p = r.properties;
            if (quoteResponse) {
              const pending = p.status === 'pending_countersign';
              const accepted = pending || p.status === 'accepted';
              const verb = pending ? 'signed' : accepted ? 'accepted' : 'declined';
              const amount = p.amount === null || p.amount === undefined || p.amount === '' ? null
                : Number(p.amount).toLocaleString(undefined, { style: 'currency', currency: typeof p.currency === 'string' && p.currency ? p.currency : 'USD' });
              return (
                <Link key={`quote-response-${r.id}`} to={`/objects/quotes/${r.id}`} className="activity-item">
                  <span className={`activity-icon${accepted ? ' good' : ' bad'}`}><Icon size={15} strokeWidth={1.75} /></span>
                  <div className="activity-body">
                    <div className="activity-head">
                      <strong>Quote {verb}</strong>
                      {amount && <span className={accepted ? 'money push-right' : 'num push-right muted'}>{amount}</span>}
                      <time className="ledger-time" dateTime={at}>{timeOf(at)}</time>
                    </div>
                    <div className="activity-text">
                      {recordName(r)} {verb} by {String(p.responder_name ?? 'the customer')}
                      {p.responder_email ? ` (${String(p.responder_email)})` : ''}
                    </div>
                    {pending ? <div className="small muted">Awaiting countersignature</div> : null}
                    {!pending && accepted && p.countersigner_name ? <div className="small muted">Countersigned by {String(p.countersigner_name)}</div> : null}
                    {!accepted && p.decline_reason ? <div className="small muted">Reason: {String(p.decline_reason)}</div> : null}
                  </div>
                </Link>
              );
            }
            const title = o === 'emails' ? (p.subject as string) || 'Email' : o === 'notes' ? 'Note' : displayName(p, r.id);
            const body = plain(o === 'tasks' ? p.body : p.body);
            const key = `${o}-${r.id}`;
            const open = openedKey === key;
            const toggle = () => go(open ? searchFor(tab, null) : searchFor(tab, o, r.id));
            return (
              // collapsed, the whole entry opens it (unless text is being selected); open, only the head closes it
              <div key={key} id={`activity-${key}`} className={`activity-item${open ? ' open' : ''}`}
                onClick={open ? undefined : () => { if (!window.getSelection()?.toString()) toggle(); }}>
                <span className="activity-icon"><Icon size={15} strokeWidth={1.75} /></span>
                <div className="activity-body">
                  <div className="activity-head">
                    <button className="activity-toggle" aria-expanded={open} onClick={(e) => { e.stopPropagation(); toggle(); }}>
                      <ChevronRight size={14} className="activity-chevron" aria-hidden="true" />
                      <strong>{title}</strong>
                    </button>
                    {open ? (
                      <span className="activity-actions push-right">
                        <button className="btn small" onClick={() => copyLink(o, r.id)}><Link2 size={14} /> Copy link</button>
                        <Link className="btn small" to={`/objects/${o}/${r.id}`} aria-label={`Open ${(objectByName.get(o)?.label_singular ?? o).toLowerCase()}`}>
                          <span className="btn-label">Open</span> <ArrowRight size={14} />
                        </Link>
                      </span>
                    ) : (
                      <span className="activity-kind push-right">
                        {(commentCounts[key] ?? 0) > 0 && (
                          <span className="activity-comment-count" title={`${commentCounts[key]} comment${commentCounts[key] === 1 ? '' : 's'}`}>
                            <MessageSquare size={12} strokeWidth={1.75} aria-hidden /> {commentCounts[key]}
                          </span>
                        )}
                        {' '}{objectByName.get(o)?.label_singular}
                      </span>
                    )}
                    {at && <time className="ledger-time" dateTime={at}>{open ? when(at) : timeOf(at)}</time>}
                  </div>
                  {open ? (
                    <ActivityExpanded object={o} id={r.id} initial={r} page={{ object, id }} onPageLinkChanged={onChanged}
                      onCommentCount={(n) => setCommentCounts((m) => ({ ...m, [key]: n }))} highlightComment={params.get('comment')} />
                  ) : (
                    <>
                      {o === 'tasks' && p.status ? <div className="activity-status"><StatusPill tone={TASK_TONES[String(p.status)] ?? 'off'}>{String(p.status).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}</StatusPill></div> : null}
                      {o === 'emails' && EMAIL_SEND_STATES.includes(String(p.status)) && <EmailSendState emailId={r.id} status={String(p.status)} scheduledAt={p.scheduled_at as string | null} onChanged={onChanged} />}
                      {body && <div className="activity-text"><MentionText text={body.length > 400 ? `${body.slice(0, 400)}…` : body} /></div>}
                      {o === 'form_submissions' && <Answers record={r} limit={6} />}
                      {o === 'emails' && <EmailTracking p={p} />}
                    </>
                  )}
                </div>
              </div>
            );
          })}
            </LedgerDay>
          ))}
        </div>
      )}
    </div>
  );
}

// A record the user may not open, reached through an @mention: only its ID
// and the activities they were tagged in (a note's body or a comment), each
// with its comments. Nothing else about the record, and no links from the
// activities to other records (the API opens the activities alone).
function MentionedOnly({ object, id, items, back }: { object: string; id: string; items: { object: string; id: string }[]; back: RecordBack['back'] | null }) {
  const { objectByName } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const label = objectByName.get(object)?.label_singular ?? object;
  const self = items.length === 1 && items[0]!.object === object && items[0]!.id === id;
  const lower = label.toLowerCase();
  // live updates for the tagged activities and their comments
  const [versions, setVersions] = useState<Map<string, number>>(new Map());
  const [stamp, setStamp] = useState(0);
  const watch = useMemo(() => items.map((it) => `${it.object}:${it.id}`), [items]);
  useLiveRecords(watch, (events) => {
    setVersions((prev) => bumpVersions(prev, events, watch));
    setStamp((n) => n + 1);
  });
  const live = useMemo(() => ({ versions, stamp }), [versions, stamp]);
  return (
    <LiveContext.Provider value={live}>
    <div className="record-mentioned">
      {back
        ? <Link to={back.to} className="back"><ChevronLeft size={16} /> {back.label}</Link>
        : <button className="back link-btn" onClick={() => navigate(-1)}><ChevronLeft size={16} /> Back</button>}
      <div className="record-mentioned-head">
        <span className="record-avatar" aria-hidden><Lock size={18} strokeWidth={1.75} /></span>
        <div>
          <h1>{label} {id}</h1>
          <p className="muted">
            {self
              ? `You were tagged in this ${lower}, so you can see it and its comments, though your role does not give you access.`
              : `You don't have access to this ${lower}. You were tagged in ${items.length === 1 ? 'the activity' : 'the activities'} below, so you can see ${items.length === 1 ? 'it' : 'them'} and the comments.`}
          </p>
        </div>
      </div>
      {items.map((it) => <MentionedActivity key={`${it.object}-${it.id}`} object={it.object} id={it.id} highlight={params.get('comment')} />)}
    </div>
    </LiveContext.Provider>
  );
}

// quiet: shows nothing when it cannot be read (a stale link on a page the user can open).
// pinned: shown above a record's stream that cannot list it, with a line saying why.
function MentionedActivity({ object, id, highlight, quiet = false, pinned = false }: { object: string; id: string; highlight: string | null; quiet?: boolean; pinned?: boolean }) {
  const { objectByName } = useApp();
  const [record, setRecord] = useState<CrmRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useLiveVersion(object, id);
  useEffect(() => {
    let cancelled = false;
    api<CrmRecord>('GET', `/v1/objects/${object}/${id}`)
      .then((r) => !cancelled && setRecord(r))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => { cancelled = true; };
  }, [object, id, version]);
  if (error) return quiet ? null : <div className="error">{error}</div>;
  if (!record) return quiet ? null : <div className="card muted small">Loading…</div>;
  const Icon = objectIcon(object);
  const p = record.properties;
  const title = object === 'emails' ? (p.subject as string) || 'Email' : object === 'notes' ? 'Note' : displayName(p, record.id);
  const at = activityTime(object, record);
  const kindLabel = (objectByName.get(object)?.label_singular ?? object).toLowerCase();
  const card = (
    <div className="activity-item open mentioned-activity">
      <span className="activity-icon"><Icon size={15} strokeWidth={1.75} /></span>
      <div className="activity-body">
        <div className="activity-head">
          <strong>{title}</strong>
          <span className="activity-kind push-right">{objectByName.get(object)?.label_singular ?? object}</span>
          {at && <time className="ledger-time" dateTime={at}>{when(at)}</time>}
        </div>
        <ActivityExpanded object={object} id={record.id} initial={record} page={{ object, id: record.id }} onPageLinkChanged={async () => undefined}
          highlightComment={highlight} restricted />
      </div>
    </div>
  );
  if (!pinned) return card;
  return (
    <div className="pinned-activity">
      <div className="pinned-activity-why">
        <AtSign size={13} strokeWidth={2} aria-hidden />
        {record.via_mention ? `You were tagged in this ${kindLabel}` : `Opened from a link`}
      </div>
      {card}
    </div>
  );
}

// An email sent from a mailbox that has not simply gone out: scheduled (with
// Cancel), sending, failed (with the reason and Send again) or cancelled.
const EMAIL_SEND_STATES = ['scheduled', 'sending', 'failed', 'cancelled'];
const EMAIL_SEND_TONES: Record<string, Tone> = { scheduled: 'pending', sending: 'info', failed: 'failed', cancelled: 'off' };

function EmailSendState({ emailId, status, scheduledAt, onChanged }: { emailId: string; status: string; scheduledAt: string | null; onChanged: () => Promise<void> }) {
  const { toast } = useApp();
  const [info, setInfo] = useState<SendStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (status !== 'failed' && status !== 'scheduled') return;
    let cancelled = false;
    api<SendStatus>('GET', `/v1/mailboxes/sends/${emailId}`).then((s) => !cancelled && setInfo(s)).catch(() => undefined);
    return () => { cancelled = true; };
  }, [emailId, status]);

  async function act(action: 'cancel' | 'retry') {
    if (action === 'cancel' && !(await confirmDialog('The email will not be sent. It stays on the record as cancelled.', { title: 'Cancel this scheduled email?', confirmLabel: 'Cancel email', cancelLabel: 'Keep it', danger: true }))) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; error?: string | null }>('POST', `/v1/mailboxes/sends/${emailId}/${action}`);
      toast(action === 'cancel' ? 'Email cancelled' : r.ok ? 'Email sent' : `Not sent: ${r.error ?? 'the provider refused it'}`);
      await onChanged();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const label = status === 'scheduled' && scheduledAt ? `Scheduled for ${new Date(scheduledAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : status.replace(/^./, (c) => c.toUpperCase());
  return (
    <div className="activity-status email-send-state" onClick={(e) => e.stopPropagation()}>
      <StatusPill tone={EMAIL_SEND_TONES[status] ?? 'off'}>{label}</StatusPill>
      {status === 'scheduled' && info?.next_attempt_at && <span className="small muted">Retrying after a problem: {info.last_error}</span>}
      {status === 'failed' && info?.last_error && <span className="small muted">{info.last_error}</span>}
      {info?.can_manage && status === 'scheduled' && <button className="btn small" disabled={busy} onClick={() => act('cancel')}>Cancel</button>}
      {info?.can_manage && status === 'failed' && <button className="btn small" disabled={busy} onClick={() => act('retry')}>{busy ? 'Sending…' : 'Send again'}</button>}
    </div>
  );
}

const DETAIL_SKIP = new Set(['name', 'subject', 'body', 'summary', 'submission_values', 'created_at']);

// Email and note bodies are HTML from outside: render them in a sandboxed
// frame with scripts, forms and plugins off. allow-same-origin (without
// allow-scripts) only lets this page read the frame's height.
function HtmlBody({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const fit = () => {
    const doc = frame.current?.contentDocument;
    if (doc) setHeight(Math.max(40, doc.documentElement.scrollHeight));
  };
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    html, body { margin: 0; } body { padding: 14px 16px; font: 14px/1.55 Inter, system-ui, sans-serif; color: #1f2328; background: #fff; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; } table { max-width: 100%; } pre { white-space: pre-wrap; }
  </style></head><body>${html}</body></html>`;
  return (
    <iframe ref={frame} className="activity-html" title="Message body" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc} style={{ height }} onLoad={fit} />
  );
}

// An activity opened in place in the stream: the whole body, its fields and
// what it is linked to.
function ActivityExpanded({ object, id, initial, page, onPageLinkChanged, onCommentCount, highlightComment, restricted = false }: {
  object: string; id: string; initial: CrmRecord; page: { object: string; id: string }; onPageLinkChanged: () => Promise<void>;
  onCommentCount?: (n: number) => void; highlightComment?: string | null;
  // opened through an @mention (MentionedOnly): no links to other records
  restricted?: boolean;
}) {
  const [record, setRecord] = useState<CrmRecord>(initial);
  const [props, setProps] = useState<Property[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const version = useLiveVersion(object, id);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getSchema(object), api<CrmRecord>('GET', `/v1/objects/${object}/${id}`)])
      .then(([s, r]) => {
        if (cancelled) return;
        setProps(s.properties);
        setCanEdit(s.permissions.edit && r.can_edit !== false && r.record_status !== 'archived');
        setRecord(r);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [object, id, version]);

  const p = record.properties;
  const body = typeof p.body === 'string' ? p.body.trim() : '';
  const fields = (ACTIVITY_PROPS[object] ?? [])
    .filter((name) => !DETAIL_SKIP.has(name))
    .map((name) => props.find((x) => x.api_name === name))
    .filter((x): x is Property => !!x);
  const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  // a plain-text body (notes, call notes, task notes) is edited in place; HTML
  // bodies (emails from outside) are not
  const bodyProp = props.find((x) => x.api_name === 'body');
  const isHtmlBody = /<[a-z][\s\S]*>/i.test(body);
  const bodyEditable = canEdit && !!bodyProp && isEditable(bodyProp) && !isHtmlBody && object !== 'form_submissions';
  const [editing, setEditing] = useState(false);

  async function saveBody(text: string) {
    const r = await api<CrmRecord>('PATCH', `/v1/objects/${object}/${id}`, { properties: { body: text || null } });
    setRecord((old) => ({ ...old, ...r, properties: { ...old.properties, ...r.properties } }));
    setEditing(false);
    // the stream's collapsed excerpt reads the page's copy
    await onPageLinkChanged();
  }

  return (
    <div className="activity-expanded">
      {error && <div className="error">{error}</div>}
      {object === 'form_submissions' ? (
        <Answers record={record} />
      ) : editing ? (
        <BodyEditor initial={body} mentions={object === 'notes'} placeholder={object === 'calls' ? 'Call notes…' : object === 'notes' ? 'Write a note…' : 'Notes…'}
          onSave={saveBody} onCancel={() => setEditing(false)} />
      ) : body ? (
        isHtmlBody ? <HtmlBody html={mentionsAsText(body)} />
          : bodyEditable ? (
            <div className="activity-plain editable" role="button" tabIndex={0} title="Click to edit"
              onClick={() => { if (!window.getSelection()?.toString()) setEditing(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); setEditing(true); } }}>
              <MentionText text={body} />
            </div>
          ) : <div className="activity-plain"><MentionText text={body} /></div>
      ) : bodyEditable ? (
        <button className="btn small" onClick={() => setEditing(true)}><Pencil size={13} /> {object === 'calls' ? 'Add call notes' : 'Add notes'}</button>
      ) : (
        <div className="muted small">{object === 'calls' ? 'No call notes' : 'No body'}</div>
      )}
      {fields.length > 0 && (
        <dl className="activity-fields">
          {fields.map((f) => (
            <div key={f.api_name}>
              <dt>{f.label}</dt>
              <dd>{empty(p[f.api_name]) ? <span className="muted">--</span> : displayValue(f, p[f.api_name])}</dd>
            </div>
          ))}
        </dl>
      )}
      {COMMENT_TARGETS.includes(object) && (
        <Comments object={object} id={id} readOnly={record.record_status === 'archived'} onCount={onCommentCount} highlight={highlightComment} />
      )}
      {!restricted && (
        <div className="activity-foot">
          <ActivityLinks object={object} id={id} page={page} onPageLinkChanged={onPageLinkChanged} />
        </div>
      )}
    </div>
  );
}

// An activity's body edited in place: grows with the text, @mentions on notes
// (the ones already in the body are kept), Cmd/Ctrl+Enter saves, Escape cancels.
function BodyEditor({ initial, mentions, placeholder, onSave, onCancel }: {
  initial: string; mentions: boolean; placeholder: string; onSave: (text: string) => Promise<void>; onCancel: () => void;
}) {
  const [text, setText] = useState(() => mentionsAsText(initial));
  const [mentioned, setMentioned] = useState<MentionUser[]>(() => [...initial.matchAll(MENTION_TOKEN)].map((m) => ({ name: m[1]!, id: m[2]! })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const changed = text.trim() !== mentionsAsText(initial).trim();

  async function save() {
    if (saving) return;
    if (!changed) { onCancel(); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(mentions ? encodeMentions(text.trim(), mentioned) : text.trim());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  async function cancel() {
    if (changed && !(await confirmDialog('Your changes are not saved.', { title: 'Discard your changes?', confirmLabel: 'Discard', danger: true }))) return;
    onCancel();
  }

  return (
    <div className="activity-body-edit" onClick={(e) => e.stopPropagation()}>
      <TextArea ref={box} grow rows={3} value={text} placeholder={placeholder} aria-label="Body" onChange={(e) => setText(e.target.value)}
        onMention={mentions ? (u) => setMentioned((m) => [...m, u]) : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          else if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); cancel(); }
        }} />
      {error && <div className="error">{error}</div>}
      <div className="activity-body-edit-foot">
        <button className="btn small" onClick={cancel} disabled={saving}>Cancel</button>
        <button className="btn primary small" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

// "N associations": a popover listing every record the activity is linked to.
// Selected shows the current links; each object searches its records, and a
// checkbox links or unlinks one. Links the system makes cannot be changed here.
function ActivityLinks({ object, id, page, onPageLinkChanged }: { object: string; id: string; page: { object: string; id: string }; onPageLinkChanged: () => Promise<void> }) {
  const { objects, objectByName } = useApp();
  const codeToName = useMemo(() => new Map(objects.map((o) => [o.object_type_id, o.api_name])), [objects]);
  const [groups, setGroups] = useState<Associated[] | null>(null);
  const [open, setOpen] = useState(false);
  const [only, setOnly] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CrmRecord[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => loadLinked(object, id, codeToName).then(setGroups), [object, id, codeToName]);
  useEffect(() => {
    reload().catch(() => setGroups([]));
  }, [reload]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // an object picked on the left: search its records
  useEffect(() => {
    setResults(null);
    if (!open || !only) return;
    let cancelled = false;
    const h = setTimeout(async () => {
      try {
        const s = await getSchema(only);
        const res = await api<SearchResult>('POST', `/v1/objects/${only}/search`, { query: search.trim() || undefined, limit: 20, properties: nameProperties(s.properties) });
        if (!cancelled) setResults(res.results);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [open, only, search]);

  const meta = objectByName.get(object);
  const systemLinks = meta?.system_links ?? [];
  const linkable = (meta?.links_to ?? [])
    .filter((o) => objectByName.has(o) && o !== 'comments')
    .map((o) => ({ object: o, label: objectByName.get(o)?.label_plural ?? o }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const linked = (o: string) => groups?.find((g) => g.object === o)?.records.map((r) => r.record) ?? [];
  const total = (groups ?? []).reduce((n, g) => n + g.records.length, 0);
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const secondary = (r: CrmRecord) => {
    const v = r.properties.email ?? r.properties.domain;
    return typeof v === 'string' && v && v !== recordName(r) ? v : null;
  };
  const matches = (r: CrmRecord) => words.every((w) => `${recordName(r)} ${secondary(r) ?? ''}`.toLowerCase().includes(w));

  // Selected: the current links by object. An object: its linked records that
  // match first, then search results not yet linked.
  const shown = only
    ? [{
        object: only,
        label: objectByName.get(only)?.label_plural ?? only,
        records: [...linked(only).filter(matches), ...(results ?? []).filter((r) => !linked(only).some((l) => l.id === r.id) && !(only === object && r.id === id))]
      }]
    : linkable
        .map((l) => ({ ...l, records: linked(l.object).filter(matches) }))
        .filter((g) => g.records.length > 0);

  async function toggle(other: string, targetId: string, isLinked: boolean) {
    const key = `${other}-${targetId}`;
    setBusy(key);
    setError(null);
    try {
      await api(isLinked ? 'DELETE' : 'PUT', `/v1/objects/${object}/${id}/associations/${other}/${targetId}`, isLinked ? undefined : {});
      await reload();
      // the stream on this page lists the activity only while it links here
      if (other === page.object && targetId === page.id) await onPageLinkChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (groups === null) return <span className="muted small">Loading associations…</span>;
  return (
    <div className="activity-links" ref={ref}>
      <button className="activity-links-trigger" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {total} association{total === 1 ? '' : 's'} <ChevronDown size={14} />
      </button>
      {open && (
        <div className="activity-links-pop" role="dialog" aria-label="Associations">
          <nav className="activity-links-nav">
            <button className={only === '' ? 'active' : ''} onClick={() => setOnly('')}><span>Selected</span><span className="num">{total}</span></button>
            {linkable.map((l) => (
              <button key={l.object} className={only === l.object ? 'active' : ''} onClick={() => setOnly(l.object)}>
                <span>{l.label}</span><span className="num">{linked(l.object).length}</span>
              </button>
            ))}
          </nav>
          <div className="activity-links-list">
            <input type="search" placeholder={only ? `Search ${(objectByName.get(only)?.label_plural ?? only).toLowerCase()}` : 'Search current associations'}
              value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search associations" autoFocus />
            {error && <div className="error">{error}</div>}
            {only && results === null && <TableSkeleton rows={3} />}
            {shown.length === 0 || (only && results !== null && shown[0].records.length === 0) ? (
              <div className="muted small">{!only && total === 0 && !words.length ? 'Not linked to anything yet. Pick an object to link one.' : 'No matches.'}</div>
            ) : shown.map((g) => {
              const editable = !systemLinks.includes(g.object);
              return (
                <div key={g.object} className="activity-links-group">
                  <div className="activity-links-head">{g.label}</div>
                  {g.records.map((r) => {
                    const isLinked = linked(g.object).some((l) => l.id === r.id);
                    return (
                      <div key={r.id} className="activity-links-row">
                        <input type="checkbox" checked={isLinked} disabled={!editable || busy === `${g.object}-${r.id}`}
                          onChange={() => toggle(g.object, r.id, isLinked)}
                          aria-label={`${isLinked ? 'Unlink' : 'Link'} ${recordName(r)}`}
                          title={editable ? undefined : 'Set by the system'} />
                        <Link to={`/objects/${g.object}/${r.id}`}>{recordName(r)}</Link>
                        {secondary(r) && <span className="muted small">{secondary(r)}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Date-only values (YYYY-MM-DD) have no time and count as that local day.
const localDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
const timeOf = (iso: string) => (iso.length === 10 ? '' : localDate(iso).toLocaleTimeString(undefined, { timeStyle: 'short' }));

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}

// Groups rows (already sorted newest first) under day headings.
function byDay<T>(rows: T[], at: (row: T) => string | null | undefined): { day: string; rows: T[] }[] {
  const groups: { day: string; rows: T[] }[] = [];
  for (const row of rows) {
    const iso = at(row);
    const day = iso ? dayLabel(localDate(iso)) : 'Undated';
    if (groups.at(-1)?.day === day) groups.at(-1)!.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

function LedgerDay({ day, children }: { day: string; children: ReactNode }) {
  return (
    <>
      <div className="ledger-day">{day}</div>
      <div className="ledger-entries">{children}</div>
    </>
  );
}

// ISO 8601 in the viewer's time zone, with its offset (2026-11-03T14:05:09-08:00),
// so the time matches the day heading above it.
function isoLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${offset >= 0 ? '+' : '-'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

// What an association history value holds (meta.record_history, property 'association').
interface LinkValue {
  label_id: string;
  record_id: string;
  association_id: string;
  object_type_id: string;
}

const isLinkValue = (v: unknown): v is LinkValue =>
  !!v && typeof v === 'object' && typeof (v as LinkValue).record_id === 'string' && typeof (v as LinkValue).object_type_id === 'string';

// One entry on the Changes tab: a property change, or links (or unlinks) to
// one object made together by one actor in the same second.
type ChangeEntry =
  | { kind: 'property'; row: HistoryRow }
  | { kind: 'link'; row: HistoryRow; linked: boolean; objectType: string; links: LinkValue[] };

function changeEntries(rows: HistoryRow[]): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const row of rows) {
    const value = row.new_value ?? row.old_value;
    if (row.property !== 'association' || !isLinkValue(value)) {
      out.push({ kind: 'property', row });
      continue;
    }
    const linked = row.old_value === null;
    const prev = out.at(-1);
    if (prev?.kind === 'link' && prev.linked === linked && prev.objectType === value.object_type_id && prev.row.changed_by === row.changed_by &&
      prev.row.via === row.via && prev.row.changed_at.slice(0, 19) === row.changed_at.slice(0, 19)) prev.links.push(value);
    else out.push({ kind: 'link', row, linked, objectType: value.object_type_id, links: [value] });
  }
  return out;
}

// Entries made in the same second by the same actor, the same way, share one
// who-how-when line.
function changeBatches(entries: ChangeEntry[]): ChangeEntry[][] {
  const out: ChangeEntry[][] = [];
  for (const e of entries) {
    const first = out.at(-1)?.[0].row;
    const h = e.row;
    if (first && first.changed_at.slice(0, 19) === h.changed_at.slice(0, 19) && first.changed_by === h.changed_by &&
      first.via === h.via && first.source === h.source && first.api_key_id === h.api_key_id) out.at(-1)!.push(e);
    else out.push([e]);
  }
  return out;
}

// A value as the property shows it elsewhere; JSON only for shapes no property type explains.
function historyValue(p: Property | undefined, value: unknown): ReactNode {
  if (p) {
    const shown = displayValue(p, value);
    if (shown !== '') return shown;
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return JSON.stringify(value);
}

// Who made a change: the user's or API key's name, the raw actor on hover.
function actorName(h: HistoryRow): { name: string; key: boolean } {
  if (h.changed_by_name) return { name: h.changed_by_name, key: false };
  if (h.api_key_name) return { name: h.api_key_name, key: true };
  return { name: h.changed_by ?? 'Unknown', key: false };
}

function ChangeHistory({ object, id, schema }: { object: string; id: string; schema: ObjectDef }) {
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [facets, setFacets] = useState<HistoryFacets | null>(null);
  const [property, setProperty] = useState('');
  const [changedBy, setChangedBy] = useState('');
  const [via, setVia] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { objects } = useApp();
  const byCode = useMemo(() => new Map(objects.map((o) => [o.object_type_id, o])), [objects]);
  // linked records' names (code:id) and association label names, filled in after the history loads
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [labels, setLabels] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    api<{ results: { id: string; label: string | null }[] }>('GET', `/v1/association-labels?object=${object}`)
      .then((r) => setLabels(new Map(r.results.map((l) => [l.id, l.label]))))
      .catch(() => undefined);
  }, [object]);

  useEffect(() => {
    if (!history) return;
    const wanted = new Map<string, Set<string>>();
    for (const h of history) {
      for (const v of [h.old_value, h.new_value]) {
        if (h.property === 'association' && isLinkValue(v) && !names.has(`${v.object_type_id}:${v.record_id}`)) {
          wanted.set(v.object_type_id, (wanted.get(v.object_type_id) ?? new Set()).add(v.record_id));
        }
      }
    }
    if (!wanted.size) return;
    let live = true;
    Promise.all([...wanted].map(async ([code, ids]) => {
      const name = byCode.get(code)?.api_name;
      if (!name) return [];
      const s = await getSchema(name);
      const r = await api<{ results: CrmRecord[] }>('POST', `/v1/objects/${name}/batch/read`, { ids: [...ids].slice(0, 100), properties: nameProperties(s.properties) });
      return r.results.map((rec) => [`${code}:${rec.requested_id ?? rec.id}`, recordName(rec)] as const);
    })).then((found) => {
      if (live) setNames((m) => new Map([...m, ...found.flat()]));
    }).catch(() => undefined);
    return () => { live = false; };
    // names is read only to skip records already known
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, byCode]);

  useEffect(() => {
    setProperty('');
    setChangedBy('');
    setVia('');
  }, [object, id]);

  // a live change loads it again in place; other changes start from empty
  const version = useLiveVersion(object, id);
  const shownFor = useRef('');
  useEffect(() => {
    const key = [object, id, property, changedBy, via].join('|');
    if (shownFor.current !== key) setHistory(null);
    shownFor.current = key;
    setError(null);
    let cancelled = false;
    const q = new URLSearchParams({ limit: '200' });
    if (property) q.set('property', property);
    if (changedBy) q.set('changed_by', changedBy);
    if (via) q.set('via', via);
    api<{ results: HistoryRow[]; facets: HistoryFacets }>('GET', `/v1/objects/${object}/${id}/history?${q}`)
      .then((r) => { if (!cancelled) { setHistory(r.results); setFacets(r.facets); } })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => { cancelled = true; };
  }, [object, id, property, changedBy, via, version]);

  const propLabel = (name: string) => (name === 'association' ? 'Association' : schema.properties.find((p) => p.api_name === name)?.label ?? (name === 'merged_into_id' ? 'Merged into' : name));
  // associations, then merges (on the record kept and the one merged away), then the rest A to Z
  const propRank = (name: string) => (name === 'association' ? 0 : name === 'merged_ids' || name === 'merged_into_id' ? 1 : 2);
  const filtered = !!(property || changedBy || via);
  return (
    <div className="timeline">
      {facets && (
        <div className="field-row history-filters">
          <Select value={property} onChange={(v) => setProperty(v)} aria-label="Property or association">
            <option value="">Every property and association</option>
            {[...facets.properties].sort((a, b) => propRank(a) - propRank(b) || propLabel(a).localeCompare(propLabel(b))).map((name) => <option key={name} value={name}>{propLabel(name)}</option>)}
          </Select>
          <Select value={changedBy} onChange={(v) => setChangedBy(v)} aria-label="Changed by">
            <option value="">Anyone</option>
            {facets.changed_by.map((c) => <option key={c.changed_by} value={c.changed_by}>{c.name ? `${c.name} (${c.changed_by})` : c.changed_by}</option>)}
          </Select>
          <Select value={via} onChange={(v) => setVia(v)} aria-label="Made through">
            <option value="">Any way</option>
            {facets.via.map((v) => <option key={v} value={v}>{VIA_LABELS[v]}</option>)}
          </Select>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {history === null && !error && <TableSkeleton rows={4} />}
      {history?.length === 0 && (
        <EmptyState
          icon={<History size={18} />}
          title={filtered ? 'No changes match these filters' : 'No changes recorded'}
          action={filtered ? <button className="btn small" onClick={() => { setProperty(''); setChangedBy(''); setVia(''); }}>Clear filters</button> : undefined}
        >
          {filtered ? 'Try another property, person or way.' : 'Edits to properties and associations show here, with who made them and how.'}
        </EmptyState>
      )}
      {history && byDay(changeBatches(changeEntries(history)), (b) => b[0].row.changed_at).map(({ day, rows: batches }) => (
        <LedgerDay key={day} day={day}>
          {batches.map((batch, bi) => {
            const h = batch[0].row;
            const actor = actorName(h);
            return (
              <div key={bi} className="change-batch">
                <div className="change-batch-head">
                  <span className={`change-avatar${actor.key ? ' key' : ''}`} aria-hidden="true">
                    {actor.key ? <KeyRound size={13} /> : initials(actor.name)}
                  </span>
                  <div className="change-meta">
                    <span className="change-actor" title={h.api_key_id ? `${h.changed_by}, API key ${h.api_key_id}` : h.changed_by}>{actor.name}</span>
                    <span className="change-tag">{VIA_LABELS[h.via]}</span>
                    {h.source !== h.via && h.source !== 'api' && <span className="change-tag">{h.source}</span>}
                  </div>
                  <time className="ledger-time" dateTime={h.changed_at}>{isoLocal(h.changed_at)}</time>
                </div>
                <div className="change-batch-items">
                  {batch.map((e, i) => {
                    if (e.kind === 'link') {
                      const other = byCode.get(e.objectType);
                      const n = e.links.length;
                      const noun = n === 1 ? other?.label_singular ?? 'Record' : `${n} ${(other?.label_plural ?? 'records').toLowerCase()}`;
                      const Icon = e.linked ? Link2 : Unlink;
                      return (
                        <div key={i} className={`ledger-entry link-change${e.linked ? '' : ' unlinked'}`}>
                          <span className="change-dot link-dot" aria-hidden="true"><Icon size={12} /></span>
                          <div className="change-body">
                            <strong className="change-what">{noun} {e.linked ? 'associated' : 'disassociated'}</strong>
                            <ul className="change-links">
                              {e.links.map((l) => {
                                const name = names.get(`${l.object_type_id}:${l.record_id}`);
                                const label = labels.get(l.label_id);
                                return (
                                  <li key={l.association_id}>
                                    {other ? (
                                      <Link to={`/objects/${other.api_name}/${l.record_id}`} className={name ? undefined : 'muted'}>{name ?? `${other.label_singular} ${l.record_id}`}</Link>
                                    ) : <span className="muted">{l.record_id}</span>}
                                    {label && <span className="change-tag">{label}</span>}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        </div>
                      );
                    }
                    const r = e.row;
                    const prop = schema.properties.find((p) => p.api_name === r.property);
                    return (
                      <div key={i} className="ledger-entry">
                        <span className="change-dot" aria-hidden="true" />
                        <div className="change-body">
                          <strong className="change-what">{propLabel(r.property)}</strong>
                          <div className="change-values">
                            {r.old_value === null ? <span className="change-value old none">Empty</span> : <ShowMore className="change-value old">{historyValue(prop, r.old_value)}</ShowMore>}
                            <ArrowRight size={13} className="change-arrow" aria-label="to" />
                            {r.new_value === null ? <span className="change-value none">Empty</span> : <ShowMore className="change-value">{historyValue(prop, r.new_value)}</ShowMore>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </LedgerDay>
      ))}
    </div>
  );
}

// Shown while the record loads: the three columns' shapes, so nothing jumps.
function RecordSkeleton() {
  return (
    <div className="record-page record-skeleton" aria-busy="true" aria-label="Loading record">
      <aside className="record-left">
        <div className="record-head skeleton-block tall" />
        <div className="prop-section skeleton-block" />
      </aside>
      <section className="record-middle"><TableSkeleton rows={4} /></section>
      <aside className="record-right">
        <div className="card skeleton-block" />
        <div className="card skeleton-block" />
      </aside>
    </div>
  );
}

// ---- users ----------------------------------------------------------------

// ids are bigints, which the API sends as strings
interface UserRole {
  assignment_id: string;
  role_id: string;
  name: string;
  is_admin: boolean;
  // set when the role comes from one of the user's teams
  team_id: string | null;
}

function UserRoles({ userId, onLoaded }: { userId: string; onLoaded?: (roles: UserRole[]) => void }) {
  const { me } = useApp();
  const [roles, setRoles] = useState<UserRole[] | null>(null);
  const [allRoles, setAllRoles] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ results: UserRole[] }>('GET', `/v1/users/${userId}/roles`);
    setRoles(r.results);
    onLoaded?.(r.results);
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    if (me.is_admin) api<{ results: { id: string; name: string }[] }>('GET', '/v1/roles').then((r) => setAllRoles(r.results)).catch(() => undefined);
  }, [load, me.is_admin]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const available = allRoles.filter((r) => !roles?.some((x) => x.role_id === r.id && !x.team_id));
  return (
    <div className="props user-roles">
      <h3>
        Roles
        {me.is_admin && <Link to="/settings/roles" className="small push-right">Manage roles</Link>}
      </h3>
      {error && <div className="error">{error}</div>}
      <div className="role-chips">
        {roles?.length === 0 && <span className="muted small">No role: this user can sign in but sees nothing.</span>}
        {roles?.map((r) => (
          <span key={`${r.assignment_id}`} className={`role-chip${r.is_admin ? ' admin' : ''}${r.team_id ? ' via-team' : ''}`}>
            {r.name}
            {r.team_id ? (
              <Link to={`/objects/teams/${r.team_id}`} className="muted">&nbsp;via team</Link>
            ) : me.is_admin ? (
              <button className="icon-btn" aria-label={`Remove ${r.name}`} onClick={() => run(() => api('DELETE', `/v1/roles/${r.role_id}/assignments/${r.assignment_id}`))}>
                <X size={12} />
              </button>
            ) : null}
          </span>
        ))}
        {me.is_admin && available.length > 0 && (
          <Select className="role-add" value="" aria-label="Add a role" onChange={(v) => run(() => api('POST', `/v1/roles/${v}/assignments`, { user_id: userId }))}>
            <option value="">Add role…</option>
            {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}
      </div>
    </div>
  );
}

interface SignIns {
  identities: { provider: string; email: string | null; created_at: string; last_login_at: string | null }[];
  sessions: { id: string; created_at: string; expires_at: string; revoked_at: string | null; ip: string | null; user_agent: string | null; status: 'active' | 'signed_out' | 'expired'; current: boolean }[];
}

const PROVIDERS: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', magic_link: 'Email link', passkey: 'Passkey' };
const SESSION_STATUS: Record<SignIns['sessions'][number]['status'], string> = { active: 'Signed in', signed_out: 'Signed out', expired: 'Expired' };

// "Chrome on macOS" from a user agent string
function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

function SignInHistory({ id }: { id: string }) {
  const { me, toast } = useApp();
  const [data, setData] = useState<SignIns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => api<SignIns>('GET', `/v1/users/${id}/sign-ins`).then(setData).catch((e) => setError((e as Error).message)), [id]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // only the user themself and admins may end sessions
  const canEnd = me.is_admin || me.user?.id === id;
  async function end(fn: () => Promise<unknown>, message: string) {
    setActionError(null);
    try {
      await fn();
      toast(message);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!data) return <TableSkeleton rows={4} />;
  const active = data.sessions.filter((s) => s.status === 'active');
  const others = active.filter((s) => !s.current);
  return (
    <div className="timeline">
      {canEnd && active.length > 0 && (
        <div className="session-actions">
          {others.length > 0 && active.length > others.length && (
            <button className="btn" onClick={() => end(() => api('POST', `/v1/users/${id}/sessions/revoke`, { keep_current: true }), 'Signed out of the other sessions')}>
              Sign out other sessions
            </button>
          )}
          <button className="btn" onClick={() => end(() => api('POST', `/v1/users/${id}/sessions/revoke`, {}), 'Signed out everywhere')}>
            Sign out everywhere
          </button>
        </div>
      )}
      {actionError && <div className="error">{actionError}</div>}
      {data.identities.length === 0 ? (
        <EmptyState compact title="No sign-in method linked yet">The user is linked the first time they sign in.</EmptyState>
      ) : (
        data.identities.map((i) => (
          <div key={`${i.provider}-${i.created_at}`} className="change">
            <div className="change-head">
              <strong>{PROVIDERS[i.provider] ?? i.provider} account{i.email ? `: ${i.email}` : ''}</strong>
              <span className="muted small">linked {when(i.created_at)}</span>
            </div>
            <div className="small muted">{i.last_login_at ? `Last sign-in ${when(i.last_login_at)}` : 'Never signed in'}</div>
          </div>
        ))
      )}
      {data.sessions.length === 0 && data.identities.length > 0 && <div className="muted">No sessions recorded.</div>}
      {data.sessions.map((s) => (
        <div key={s.id} className="change">
          <div className="change-head">
            <strong>{device(s.user_agent)}</strong>
            <span className="muted small">{when(s.created_at)}{s.ip ? `, ${s.ip}` : ''}</span>
          </div>
          <div className="small session-line">
            <StatusPill tone={s.status === 'active' ? 'on' : 'off'}>{SESSION_STATUS[s.status]}{s.current ? ' (this browser)' : ''}</StatusPill>
            <span className="muted">
              {s.status === 'active' && `Until ${when(s.expires_at)}`}
              {s.status === 'signed_out' && s.revoked_at && when(s.revoked_at)}
              {s.status === 'expired' && when(s.expires_at)}
            </span>
            {canEnd && s.status === 'active' && !s.current && (
              <button className="btn small session-end" onClick={() => end(() => api('DELETE', `/v1/users/${id}/sessions/${s.id}`), 'Session ended')}>
                Sign out
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function UserHistory({ object, id, schema }: { object: string; id: string; schema: ObjectDef }) {
  const [tab, setTab] = useState<'sign-ins' | 'changes'>('sign-ins');
  return (
    <div className="activity">
      <div className="tabs">
        {(['sign-ins', 'changes'] as const).map((t) => (
          <div key={t} className={`tab${tab === t ? ' active' : ''}`}>
            <button onClick={() => setTab(t)}>{t === 'sign-ins' ? 'Sign-in history' : 'Changes'}</button>
          </div>
        ))}
      </div>
      {tab === 'sign-ins' ? <SignInHistory id={id} /> : <ChangeHistory object={object} id={id} schema={schema} />}
    </div>
  );
}

function AssociationCard({ self, selfId, selfRecord, other, items, lineCount, linked, onChanged }: {
  self: string; selfId: string; selfRecord: CrmRecord; other: string; items: { record: CrmRecord; labels: (string | null)[] }[]; lineCount: number;
  // everything the page's record is linked to (a deal's companies and contacts, offered to a new quote)
  linked: Associated[];
  onChanged: () => Promise<void>;
}) {
  const { objectByName } = useApp();
  const navigate = useNavigate();
  const meta = objectByName.get(other);
  const [adding, setAdding] = useState(false);
  // the add-line dialog, or the create dialog for a quote or invoice made from a deal
  const [dialog, setDialog] = useState<'line' | 'create' | null>(null);
  // the line and field to highlight when the dialog is opened from a row
  const [lineTarget, setLineTarget] = useState<LineTarget | undefined>(undefined);
  const [createSchema, setCreateSchema] = useState<ObjectDef | null>(null);
  // linked files' public links (only files whose public link is on)
  const [fileUrls, setFileUrls] = useState<Map<string, string>>(() => new Map());
  const fileIds = other === 'files' ? items.map((i) => i.record.id).join(',') : '';
  useEffect(() => {
    if (!fileIds) { setFileUrls(new Map()); return; }
    let live = true;
    fileInfo(fileIds.split(',')).then((list) => {
      if (live) setFileUrls(new Map(list.filter((f) => f.public_url).map((f) => [f.id, f.public_url!])));
    }).catch(() => { /* rows just show no link icons */ });
    return () => { live = false; };
  }, [fileIds]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CrmRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [otherSchema, setOtherSchema] = useState<ObjectDef | null>(null);

  useEffect(() => {
    if (other === 'lines') getSchema(other).then(setOtherSchema).catch(() => undefined);
  }, [other]);

  useEffect(() => {
    if (!adding) return;
    const h = setTimeout(async () => {
      try {
        const s = await getSchema(other);
        const res = await api<SearchResult>('POST', `/v1/objects/${other}/search`, { query: q.trim() || undefined, limit: 8, properties: nameProperties(s.properties) });
        setResults(res.results.filter((r) => !items.some((i) => i.record.id === r.id) && !(other === self && r.id === selfId)));
      } catch (err) {
        setError((err as Error).message);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [adding, q, other, items, self, selfId]);

  async function link(targetId: string) {
    setError(null);
    try {
      await api('PUT', `/v1/objects/${self}/${selfId}/associations/${other}/${targetId}`, {});
      setAdding(false);
      setQ('');
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function unlink(targetId: string) {
    if (!(await confirmDialog('The records stay; only the link between them is removed.', { title: 'Remove this association?', confirmLabel: 'Remove', danger: true }))) return;
    await api('DELETE', `/v1/objects/${self}/${selfId}/associations/${other}/${targetId}`);
    // removing a line from a deal, quote, ... offers the new total as its amount
    if (other === 'lines' && AMOUNT_PARENTS.includes(self)) {
      await offerAmountUpdates([{ object: self, id: selfId }], (o) => objectByName.get(o)?.label_singular ?? o).catch(() => 0);
    }
    await onChanged();
  }

  async function openCreate() {
    setError(null);
    try {
      setCreateSchema(await getSchema(other));
      setDialog('create');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function openLines(target?: LineTarget) {
    setLineTarget(target);
    setDialog('line');
  }

  if (!meta) return null;
  const Icon = objectIcon(other);
  // links the system makes (a form and its submissions) cannot be added or removed here
  // an accepted quote's lines are locked (migration 0073)
  const linesLocked = self === 'quotes' && other === 'lines' && isAcceptedQuote(selfRecord);
  const editable = !(objectByName.get(self)?.system_links ?? []).includes(other) && !linesLocked;
  // new lines are made here (product or custom), not picked; a product's lines are made on their parent
  const newLines = other === 'lines' && self !== 'products';
  // a line has one product
  const full = self === 'lines' && items.length > 0;
  // the + offers a new record or an existing one; files are uploaded on their own page and lines have their own dialog
  const canCreate = other !== 'files' && other !== 'lines';
  // a quote or invoice made from a deal copies its lines, amount and currency, then opens
  const fromDeal = self === 'deals' && (other === 'quotes' || other === 'invoices');
  const label = meta.label_singular.toLowerCase();
  return (
    <div className="card assoc-card">
      <div className="card-head">
        <span className="card-icon"><Icon size={15} strokeWidth={1.75} /></span>
        <h3>{meta.label_plural}</h3>
        <span className="card-count" aria-label={`${items.length} linked`}>{items.length}</span>
        {editable && !full && !(other === 'lines' && self === 'products') && (
          canCreate && !adding ? (
            <Menu
              align="right"
              trigger={(toggle) => (
                <button className="icon-btn push-right" onClick={toggle} aria-label={`Add ${label}`}>
                  <Plus size={16} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <button onClick={() => { close(); openCreate(); }}>Create {label}</button>
                  <button onClick={() => { close(); setAdding(true); }}>Link an existing {label}</button>
                </>
              )}
            </Menu>
          ) : (
            <button className="icon-btn push-right" onClick={() => (newLines ? openLines() : setAdding((v) => !v))} aria-label={`Add ${label}`}>
              {adding ? <X size={16} /> : <Plus size={16} />}
            </button>
          )
        )}
      </div>
      {linesLocked && <div className="card-empty card-locked"><Lock size={12} aria-hidden /> Locked because the quote is accepted.</div>}
      {dialog === 'line' && (
        <LineItemsEditor
          parent={{ object: self, id: selfId }}
          target={lineTarget}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); onChanged(); }}
        />
      )}
      {dialog === 'create' && createSchema && (
        <CreateRecordModal
          object={createSchema}
          associations={[{ object: self, id: selfId }]}
          copyLines={fromDeal ? { object: self, id: selfId, count: lineCount, label: (objectByName.get(self)?.label_singular ?? self).toLowerCase() } : undefined}
          copyLinks={fromDeal ? {
            label: (objectByName.get(self)?.label_singular ?? self).toLowerCase(),
            groups: ['companies', 'contacts']
              .filter((o) => objectByName.get(other)?.links_to.includes(o))
              .map((o) => ({
                object: o,
                singular: (objectByName.get(o)?.label_singular ?? o).toLowerCase(),
                plural: (objectByName.get(o)?.label_plural ?? o).toLowerCase(),
                records: (linked.find((g) => g.object === o)?.records ?? []).map((x) => ({ id: x.record.id, name: recordName(x.record) }))
              }))
              .filter((g) => g.records.length > 0)
          } : undefined}
          startWith={fromDeal ? {
            amount: selfRecord.properties.amount,
            currency: Array.isArray(selfRecord.properties.currency) ? selfRecord.properties.currency[0] : selfRecord.properties.currency
          } : undefined}
          onClose={() => { setDialog(null); onChanged(); }}
          onCreated={(r) => {
            if (fromDeal) navigate(`/objects/${other}/${r.id}`);
            else { setDialog(null); onChanged(); }
          }}
        />
      )}
      {adding && (
        <div className="card-add">
          <input autoFocus placeholder={`Search ${meta.label_plural.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} />
          {results.map((r) => (
            <button key={r.id} className="card-pick" onClick={() => link(r.id)}>{recordName(r)}</button>
          ))}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {items.length === 0 && !adding && (
        <div className="card-empty">
          No {meta.label_plural.toLowerCase()} yet.
          {editable && !(other === 'lines' && self === 'products') && <> Use <Plus size={12} aria-label="the add button" /> to {newLines ? 'add one' : canCreate ? 'create or link one' : 'link one'}.</>}
        </div>
      )}
      {items.map(({ record, labels }) => (
        <div key={record.id} className="card-row">
          <div className="card-row-main">
            {/* a deal's (quote's, ...) lines open the line items dialog on that line, not the line's page */}
            {newLines && editable
              ? <button className="link-btn" onClick={() => openLines({ lineId: record.id, field: 'product' })}>{recordName(record)}</button>
              : <Link to={`/objects/${other}/${record.id}`}>{recordName(record)}</Link>}
            {labels.some(Boolean) && <div className="small muted">{labels.filter(Boolean).join(', ')}</div>}
          </div>
          {(fileUrls.get(record.id) ?? publishedUrl(other, record)) && (
            <PublishedLinkIcons url={(fileUrls.get(record.id) ?? publishedUrl(other, record))!} />
          )}
          {other === 'lines' && (
            <LineFigures record={record} schema={otherSchema} onQty={newLines && editable ? () => openLines({ lineId: record.id, field: 'qty' }) : undefined} />
          )}
          {editable && (
            <button className="icon-btn push-right faint-btn" onClick={() => unlink(record.id)} aria-label="Remove association">
              <X size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// Copy and open icons for a published quote's, invoice's or file's public link.
function PublishedLinkIcons({ url }: { url: string }) {
  const { toast } = useApp();
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast('Could not copy the link');
    }
  }
  return (
    <span className="card-row-links">
      <button className="icon-btn" onClick={copy} aria-label="Copy link" title="Copy link"><Copy size={14} /></button>
      <a className="icon-btn" href={url} target="_blank" rel="noreferrer" aria-label="Open published version" title="Open published version"><ExternalLink size={14} /></a>
    </span>
  );
}

// ---- line items ---------------------------------------------------------------------

// The record a line belongs to (a deal, quote, invoice, ...): at most one. A
// line without one can be given one here.
// After a save that changes the line's amount (saves goes up), a deal parent
// (deal, quote, invoice, cart, order) is offered its new line items total as
// its amount.
function LineParentCard({ selfId, associated, saves, onChanged }: { selfId: string; associated: Associated[]; saves: number; onChanged: () => Promise<void> }) {
  const { objectByName } = useApp();
  const parentObjects = (objectByName.get('lines')?.links_to ?? []).filter((o) => o !== 'products' && objectByName.has(o));
  const parent = associated.filter((a) => parentObjects.includes(a.object)).flatMap((a) => a.records.map((r) => ({ object: a.object, record: r.record })))[0];
  const [target, setTarget] = useState(parentObjects.includes('deals') ? 'deals' : parentObjects[0] ?? '');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CrmRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<ParentTotals | null>(null);
  const amountParent = parent && AMOUNT_PARENTS.includes(parent.object) ? parent : null;
  const parentObject = amountParent?.object ?? null;
  const parentId = amountParent?.record.id ?? null;
  const label = (o: string) => (objectByName.get(o)?.label_singular ?? o).toLowerCase();

  useEffect(() => {
    setOffer(null);
    if (!saves || !parentObject || !parentId) return;
    let cancelled = false;
    parentTotals(parentObject, parentId).then((t) => !cancelled && t.total !== t.amount && setOffer(t)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [saves, parentObject, parentId]);

  async function updateDeal() {
    if (!parentId || !offer) return;
    setError(null);
    try {
      await setParentAmount(offer.object, parentId, offer.total);
      setOffer(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    if (parent || !target) return;
    const h = setTimeout(async () => {
      try {
        const s = await getSchema(target);
        const res = await api<SearchResult>('POST', `/v1/objects/${target}/search`, { query: q.trim() || undefined, limit: 8, properties: nameProperties(s.properties) });
        setResults(res.results);
      } catch (err) {
        setError((err as Error).message);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [parent, target, q]);

  async function link(targetId: string) {
    setError(null);
    try {
      await api('PUT', `/v1/objects/lines/${selfId}/associations/${target}/${targetId}`, {});
      setQ('');
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function unlink() {
    if (!parent || !(await confirmDialog('Only the link is removed.', { title: `Remove this line item from its ${objectByName.get(parent.object)?.label_singular.toLowerCase()}?`, confirmLabel: 'Remove', danger: true }))) return;
    await api('DELETE', `/v1/objects/lines/${selfId}/associations/${parent.object}/${parent.record.id}`);
    await onChanged();
  }

  const Icon = parent ? objectIcon(parent.object) : Plus;
  return (
    <div className="card assoc-card">
      <div className="card-head">
        <span className="card-icon"><Icon size={15} strokeWidth={1.75} /></span>
        <h3>Belongs to</h3>
      </div>
      {error && <div className="error">{error}</div>}
      {offer && (
        <div className="line-deal-offer callout">
          <div className="small">The {label(offer.object)}'s line items now total {money(offer.total, offer.currency)}; its amount is {money(offer.amount, offer.currency)}.</div>
          <div className="public-link-actions">
            <button className="btn primary small" onClick={updateDeal}>Update {label(offer.object)} amount</button>
            <button className="btn small" onClick={() => setOffer(null)}>Keep</button>
          </div>
        </div>
      )}
      {parent ? (
        <div className="card-row">
          <div className="card-row-main">
            <Link to={`/objects/${parent.object}/${parent.record.id}`}>{recordName(parent.record)}</Link>
            <div className="small muted">{objectByName.get(parent.object)?.label_singular}</div>
          </div>
          <button className="icon-btn push-right faint-btn" onClick={unlink} aria-label="Remove from parent">
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="card-add">
          <div className="card-empty">Not on any record yet. Pick one to add this line item to.</div>
          <Select
            value={target}
            search
            aria-label="Kind of record"
            options={parentObjects.map((o) => ({ value: o, label: objectByName.get(o)?.label_singular ?? o }))}
            onChange={(v) => { setTarget(v); setQ(''); }}
          />
          <input placeholder={`Search ${(objectByName.get(target)?.label_plural ?? '').toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} />
          {results.map((r) => (
            <button key={r.id} className="card-pick" onClick={() => link(r.id)}>{recordName(r)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- form submissions -------------------------------------------------------------

interface Answer {
  name: string;
  label: string;
  value: string;
  property?: string;
  hidden?: boolean;
}

// A submission's answers: the summary saved with it (labels as asked), or for
// older submissions the raw values with their keys.
function answersOf(record: CrmRecord): Answer[] {
  const p = record.properties;
  try {
    if (typeof p.summary === 'string') return JSON.parse(p.summary) as Answer[];
    if (typeof p.submission_values === 'string') {
      const values = JSON.parse(p.submission_values) as Record<string, unknown>;
      return Object.entries(values).map(([name, v]) => ({
        name,
        label: name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        value: v === true ? 'Yes' : v === false ? 'No' : Array.isArray(v) ? v.join(', ') : String(v)
      }));
    }
  } catch {
    // not JSON: nothing to show
  }
  return [];
}

function Answers({ record, limit }: { record: CrmRecord; limit?: number }) {
  const all = answersOf(record).filter((a) => !a.hidden);
  const shown = limit ? all.slice(0, limit) : all;
  if (shown.length === 0) return null;
  return (
    <dl className="answers compact">
      {shown.map((a) => (
        <div key={a.name}><dt>{a.label}</dt><dd>{a.value}</dd></div>
      ))}
      {limit && all.length > limit && <div className="muted small">and {all.length - limit} more</div>}
    </dl>
  );
}

function SubmissionAnswers({ record }: { record: CrmRecord }) {
  const answers = answersOf(record);
  const p = record.properties;
  const page = typeof p.page_url === 'string' ? p.page_url : null;
  return (
    <div className="submission">
      <h2>Answers</h2>
      <div className="muted small">
        {typeof p.submitted_at === 'string' && when(p.submitted_at)}
        {page && <>{typeof p.submitted_at === 'string' ? ', from ' : 'From '}<a href={page} target="_blank" rel="noreferrer">{page.replace(/^https?:\/\//, '')}</a></>}
      </div>
      {answers.length === 0 ? <EmptyState compact title="No answers recorded" /> : (
        <dl className="answers">
          {answers.map((a) => (
            <div key={a.name}>
              <dt>
                {a.label}
                {a.property && <span className="fb-tag">{a.property.startsWith('contacts.') ? 'Contact' : 'Ticket'} property</span>}
                {a.hidden && <span className="fb-tag">Set by the form</span>}
              </dt>
              <dd>{a.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// Quantity and extended amount on a line item card row: "x2   $24.68".
function LineFigures({ record, schema, onQty }: { record: CrmRecord; schema: ObjectDef | null; onQty?: () => void }) {
  const qty = record.properties.quantity;
  const amount = record.properties.amount;
  const amountProp = schema?.properties.find((p) => p.api_name === 'amount');
  const amountText = amount === null || amount === undefined || amount === ''
    ? ''
    : amountProp
      ? formatValue(amountProp, amount)
      : Number(amount).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  return (
    <div className="line-figures">
      {qty !== null && qty !== undefined && qty !== '' && (onQty
        ? <button className="link-btn muted line-qty" onClick={onQty} title="Edit quantity">x{Number(qty).toLocaleString()}</button>
        : <span className="muted">x{Number(qty).toLocaleString()}</span>)}
      {amountText && <span>{amountText}</span>}
    </div>
  );
}
