import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useUrlSearch } from '../lib/use-url-search';
import { Loading, Spinner } from './Loading';
import { Select } from './Select';

// Who did what with a sent campaign (api/src/email/activity.ts): a row per
// recipient with when it arrived, was opened, clicked and so on; a row opens
// to that recipient's events in order. The filter (?recipients=) and the
// search (?recipient_s=) live in the address, like a table's.

export const ACTIVITY_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All recipients' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'opened', label: 'Opened' },
  { value: 'clicked', label: 'Clicked' },
  { value: 'replied', label: 'Replied' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'complained', label: 'Marked as spam' },
  { value: 'not_opened', label: "Didn't open" },
  { value: 'not_clicked', label: "Didn't click" },
  { value: 'failed', label: "Couldn't be sent" }
];
export const FILTER_PARAM = 'recipients';

interface Row {
  contact_id: string; name: string | null; email: string; status: 'sent' | 'failed'; error: string | null; email_id: string | null;
  sent_at: string | null; delivered_at: string | null; opened_at: string | null; open_count: number; clicked_at: string | null; click_count: number;
  replied_at: string | null; unsubscribed_at: string | null; bounced_at: string | null; complained: boolean;
}
interface Page { results: Row[]; total: number }
interface TimelineItem { type: string; at: string; detail: string | null; machine?: boolean }

const PAGE = 50;
const EVENT_WORDS: Record<string, string> = {
  sent: 'Sent', failed: "Couldn't be sent", delivered: 'Delivered', opened: 'Opened', clicked: 'Clicked', replied: 'Replied',
  unsubscribed: 'Unsubscribed', bounced: 'Bounced', soft_bounce: 'Soft bounce (will retry)', complained: 'Marked as spam',
  suppressed: 'Stopped getting marketing email'
};

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const short = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function TimeCell({ iso, count }: { iso: string | null; count?: number }) {
  if (!iso) return <td className="muted">–</td>;
  return <td title={at(iso)}>{short(iso)}{count && count > 1 ? <span className="muted small"> ×{count}</span> : null}</td>;
}

function Flags({ r }: { r: Row }) {
  const flags = [
    r.status === 'failed' && { label: "Couldn't be sent", tone: 'warn', title: r.error ?? '' },
    r.bounced_at && { label: 'Bounced', tone: 'warn', title: at(r.bounced_at) },
    r.complained && { label: 'Spam', tone: 'warn', title: 'Marked as spam' },
    r.unsubscribed_at && { label: 'Unsubscribed', tone: 'off', title: at(r.unsubscribed_at) },
    r.replied_at && { label: 'Replied', tone: 'on', title: at(r.replied_at) }
  ].filter(Boolean) as { label: string; tone: string; title: string }[];
  return <td><div className="campaign-flags">{flags.map((f) => <span key={f.label} className={`campaign-flag ${f.tone}`} title={f.title}>{f.label}</span>)}</div></td>;
}

function Timeline({ campaignId, contactId }: { campaignId: string; contactId: string }) {
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ events: TimelineItem[] }>('GET', `/v1/email/campaigns/${campaignId}/activity/${contactId}`)
      .then((r) => live && setItems(r.events)).catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [campaignId, contactId]);
  if (error) return <div className="error">{error}</div>;
  if (!items) return <Loading inline />;
  if (!items.length) return <p className="muted small">No events yet.</p>;
  return (
    <ol className="campaign-timeline">
      {items.map((it, i) => (
        <li key={i} className={it.machine ? 'machine' : undefined}>
          <span className="campaign-timeline-when">{at(it.at)}</span>
          <span className="campaign-timeline-what">
            <strong>{EVENT_WORDS[it.type] ?? it.type}</strong>
            {it.machine && <span className="muted small"> (a security scanner, not counted)</span>}
            {it.detail && <span className="campaign-timeline-detail">{it.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function CampaignActivity({ campaignId, refreshKey }: { campaignId: string; refreshKey?: unknown }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get(FILTER_PARAM) ?? 'all';
  const filter = ACTIVITY_FILTERS.some((f) => f.value === raw) ? raw : 'all';
  const [query, setQuery, settled] = useUrlSearch('recipient_s');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const fetchPage = (offset: number) => {
    const q = new URLSearchParams({ filter, limit: String(PAGE), offset: String(offset) });
    if (settled) q.set('s', settled);
    return api<Page>('GET', `/v1/email/campaigns/${campaignId}/activity?${q}`);
  };

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    fetchPage(0).then((r) => { if (live) { setRows(r.results); setTotal(r.total); } })
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [campaignId, filter, settled, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const showMore = async () => {
    setMore(true);
    try {
      const r = await fetchPage(rows?.length ?? 0);
      setRows((x) => [...(x ?? []), ...r.results]);
      setTotal(r.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMore(false);
    }
  };

  const setFilter = (v: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v === 'all') next.delete(FILTER_PARAM);
    else next.set(FILTER_PARAM, v);
    return next;
  }, { replace: true });

  const label = ACTIVITY_FILTERS.find((f) => f.value === filter)!.label.toLowerCase();

  return (
    <div className="card campaign-activity" id="campaign-activity">
      <div className="card-head"><h3>Activity</h3></div>
      <div className="list-members-bar">
        <Select value={filter} onChange={setFilter} options={ACTIVITY_FILTERS} aria-label="Show recipients who" />
        <div className="table-search list-search">
          <Search size={15} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" aria-label="Search recipients" />
        </div>
        <span className="muted small">{rows ? `${total.toLocaleString()} ${total === 1 ? 'recipient' : 'recipients'}` : ''}</span>
      </div>
      {error ? <div className="error">{error}</div> : !rows ? <Loading /> : rows.length === 0 ? (
        <p className="muted">{settled ? `No recipients match "${settled}".` : filter === 'all' ? 'No one has been sent this campaign yet.' : `No recipients: ${label}.`}</p>
      ) : (
        <div className="list-table-wrap">
          <table className="list-table campaign-activity-table">
            <thead>
              <tr>
                <th aria-label="Events" />
                <th>Contact</th>
                <th>Delivered</th>
                <th>Opened</th>
                <th>Clicked</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.contact_id}>
                  <tr className={open === r.contact_id ? 'open' : undefined}>
                    <td className="campaign-expand">
                      <button className="icon-btn" aria-expanded={open === r.contact_id} aria-label={`Events for ${r.name ?? r.email}`}
                        onClick={() => setOpen(open === r.contact_id ? null : r.contact_id)}>
                        {open === r.contact_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="list-name">
                      <Link to={`/objects/contacts/${r.contact_id}`}>{r.name || r.email}</Link>
                      {r.name && <span className="muted small campaign-email">{r.email}</span>}
                    </td>
                    <TimeCell iso={r.delivered_at} />
                    <TimeCell iso={r.opened_at} count={r.open_count} />
                    <TimeCell iso={r.clicked_at} count={r.click_count} />
                    <Flags r={r} />
                  </tr>
                  {open === r.contact_id && (
                    <tr className="campaign-timeline-row">
                      <td />
                      <td colSpan={5}>
                        <Timeline campaignId={campaignId} contactId={r.contact_id} />
                        {r.email_id && <Link className="small" to={`/objects/emails/${r.email_id}`}>Open the email record</Link>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length < total && (
        <button className="btn small ghost list-more" disabled={more} onClick={showMore}>{more ? <Spinner /> : 'Show more'}</button>
      )}
      <p className="small muted">Only contacts you can see are listed. Opens and clicks in the first seconds after delivery are security scanners and are not counted.</p>
    </div>
  );
}
