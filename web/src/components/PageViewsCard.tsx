import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, MousePointerClick } from 'lucide-react';
import { api } from '../lib/api';
import { Spinner } from './Loading';

// A contact's page views (api/src/page-views.ts): pages on the websites with
// the tracking code (/p/track.js) and the CRM's landing pages, newest first.
// Views from before the contact sent a form show up too, once that browser
// sent one.

export interface PageView {
  id: string;
  viewed_at: string;
  source: 'website' | 'landing_page';
  url: string;
  host: string;
  path: string;
  title: string | null;
  referrer: string | null;
  landing_page_id: string | null;
  // campaign tags and ad click ids from the address (api/src/form-tracking.ts)
  tracking?: Record<string, string>;
}

export interface PageViews {
  results: PageView[];
  total: number;
  first_viewed_at: string | null;
}

const PAGE = 20;

const CLICK_IDS: Record<string, string> = {
  gclid: 'Google Ads', gbraid: 'Google Ads', wbraid: 'Google Ads', fbclid: 'Meta ads', msclkid: 'Microsoft Ads', ttclid: 'TikTok ads', li_fat_id: 'LinkedIn ads'
};

// "google / cpc · spring_sale · Google Ads click", or null without tags
export function campaignLine(t: Record<string, string> | undefined): string | null {
  if (!t) return null;
  const parts = [
    [t.utm_source, t.utm_medium].filter(Boolean).join(' / '),
    t.utm_campaign,
    t.utm_term,
    t.utm_content,
    ...[...new Set(Object.keys(CLICK_IDS).filter((k) => t[k]).map((k) => `${CLICK_IDS[k]} click`))]
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function tagTitle(t: Record<string, string> | undefined): string | undefined {
  return t && Object.keys(t).length ? Object.entries(t).map(([k, v]) => `${k}=${v}`).join('\n') : undefined;
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// bare: on the contact's Page views tab, where the tab already names it and counts them
export function PageViewsCard({ contactId, bare = false }: { contactId: string; bare?: boolean }) {
  const [data, setData] = useState<PageViews | null>(null);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(false);
    api<PageViews>('GET', `/v1/objects/contacts/${encodeURIComponent(contactId)}/page-views?limit=${PAGE}`)
      .then((r) => { if (live) setData(r); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [contactId]);

  async function loadMore() {
    if (!data || more) return;
    setMore(true);
    try {
      const last = data.results[data.results.length - 1];
      const r = await api<PageViews>('GET', `/v1/objects/contacts/${encodeURIComponent(contactId)}/page-views?limit=${PAGE}&before=${last.id}`);
      setData({ ...data, results: [...data.results, ...r.results] });
    } catch {
      setError(true);
    } finally {
      setMore(false);
    }
  }

  if (error && !data) return null;
  return (
    <div className="card assoc-card page-views-card">
      {!bare && (
        <div className="card-head">
          <span className="card-icon"><MousePointerClick size={15} strokeWidth={1.75} /></span>
          <h3>Page views</h3>
          {data && <span className="card-count" aria-label={`${data.total} page views`}>{data.total}</span>}
        </div>
      )}
      {!data && <div className="card-empty"><Spinner /></div>}
      {data && data.total === 0 && <div className="card-empty">No page views yet. They show up once this contact sends a form from a page with the tracking code.</div>}
      {data && data.first_viewed_at && <div className="card-row small muted">First seen {when(data.first_viewed_at)}</div>}
      {data?.results.map((v) => (
        <div key={v.id} className="card-row">
          <div className="card-row-main">
            {v.landing_page_id
              ? <Link to={`/objects/landing_pages/${v.landing_page_id}`}>{v.title || v.path}</Link>
              : <a href={v.url} target="_blank" rel="noreferrer noopener">{v.title || v.path}</a>}
            <div className="small muted page-view-where" title={v.url}>{v.host}{v.path}</div>
            <div className="small muted">
              {when(v.viewed_at)}
              {v.referrer && <> · from <span title={v.referrer}>{hostOf(v.referrer)}</span></>}
            </div>
            {campaignLine(v.tracking) && <div className="small muted page-view-campaign" title={tagTitle(v.tracking)}>{campaignLine(v.tracking)}</div>}
          </div>
        </div>
      ))}
      {data && data.results.length < data.total && (
        <div className="card-row">
          <button className="btn small ghost" onClick={loadMore} disabled={more}>{more ? <Spinner /> : 'Show more'}</button>
        </div>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---- visits on the timeline ---------------------------------------------------------

// A visit: views less than 30 minutes apart, like a HubSpot session. One entry
// on the contact's Activity tab (RecordPage's ActivityStream).
export interface Visit {
  id: string;
  // when the visit started
  at: string;
  // oldest first
  views: PageView[];
  // what the activity search looks through
  text: string;
}

const VISIT_GAP_MS = 30 * 60 * 1000;

// views newest first (as the API returns them) -> visits newest first
export function groupVisits(views: PageView[]): Visit[] {
  const visits: PageView[][] = [];
  let current: PageView[] = [];
  for (const v of [...views].reverse()) {
    const prev = current[current.length - 1];
    if (prev && Date.parse(v.viewed_at) - Date.parse(prev.viewed_at) > VISIT_GAP_MS) {
      visits.push(current);
      current = [];
    }
    current.push(v);
  }
  if (current.length) visits.push(current);
  return visits.reverse().map((list) => ({
    id: `visit-${list[0].id}`,
    at: list[0].viewed_at,
    views: list,
    text: list.map((v) => `${v.title ?? ''} ${v.host}${v.path} ${Object.values(v.tracking ?? {}).join(' ')}`).join(' ')
  }));
}

const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short' });

// One visit on the timeline: where they went and how many pages, opening to
// the list of pages.
export function VisitItem({ visit }: { visit: Visit }) {
  const [open, setOpen] = useState(false);
  const first = visit.views[0];
  const hosts = [...new Set(visit.views.map((v) => v.host))];
  const n = visit.views.length;
  const title = n === 1
    ? `Viewed ${first.title || `${first.host}${first.path}`}`
    : `Visited ${hosts.length === 1 ? hosts[0] : `${hosts.length} websites`}, ${n} pages`;
  return (
    <div className={`activity-item visit-item${open ? ' open' : ''}`} onClick={open ? undefined : () => { if (!window.getSelection()?.toString()) setOpen(true); }}>
      <span className="activity-icon"><MousePointerClick size={15} strokeWidth={1.75} /></span>
      <div className="activity-body">
        <div className="activity-head">
          <button className="activity-toggle" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
            <ChevronRight size={14} className="activity-chevron" aria-hidden="true" />
            <strong>{title}</strong>
          </button>
          <span className="activity-kind push-right">{first.source === 'landing_page' ? 'Landing page' : 'Website'}</span>
          <time className="ledger-time" dateTime={visit.at}>{timeOnly(visit.at)}</time>
        </div>
        {first.referrer && <div className="small muted">From {hostOf(first.referrer)}</div>}
        {campaignLine(first.tracking) && <div className="small muted page-view-campaign" title={tagTitle(first.tracking)}>{campaignLine(first.tracking)}</div>}
        {open && (
          <ol className="visit-pages">
            {visit.views.map((v) => (
              <li key={v.id}>
                <time className="small muted" dateTime={v.viewed_at}>{timeOnly(v.viewed_at)}</time>
                <span className="visit-page">
                  {v.landing_page_id
                    ? <Link to={`/objects/landing_pages/${v.landing_page_id}`} onClick={(e) => e.stopPropagation()}>{v.title || v.path}</Link>
                    : <a href={v.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{v.title || v.path}</a>}
                  <span className="small muted page-view-where" title={v.url}>{v.host}{v.path}</span>
                  {v !== first && campaignLine(v.tracking) && <span className="small muted page-view-campaign" title={tagTitle(v.tracking)}>{campaignLine(v.tracking)}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
