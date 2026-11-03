import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, Globe } from 'lucide-react';
import { API_BASE, api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { StatusPill } from './settings';

// Record page card for quotes, invoices, forms and booking pages: Publish
// (quote to Sent, invoice to Open, form and booking page to Published, making
// the link if there is none), the customer-facing link (/p/quote/#key,
// /p/invoice/#key, /p/form/#key, /p/book/#key), plus the embed snippet for
// forms and booking pages. Each can also have an address the user picks
// (slug, /p/book/#intro-call), used in its link and snippet.
const PUBLISHED: Record<string, string> = { quotes: 'sent', invoices: 'open', forms: 'published', booking_pages: 'published' };
const PATH: Record<string, string> = { quotes: 'quote', invoices: 'invoice', forms: 'form', booking_pages: 'book' };
const SLUG_EXAMPLE: Record<string, string> = { quotes: 'acme-roof-quote', invoices: 'acme-invoice-1042', forms: 'contact-us', booking_pages: 'intro-call' };

export function PublicLinkCard({ object, record, onChanged }: {
  object: 'quotes' | 'invoices' | 'forms' | 'booking_pages'; record: CrmRecord; onChanged: (r: CrmRecord) => void;
}) {
  const { me, toast } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const savedSlug = typeof record.properties.slug === 'string' ? record.properties.slug : '';
  const [slug, setSlug] = useState(savedSlug);
  useEffect(() => setSlug(savedSlug), [savedSlug]);
  const publicKey = typeof record.properties.public_key === 'string' ? record.properties.public_key : null;
  // what goes after the # in links and snippets: the slug when there is one
  const key = savedSlug || publicKey;
  const status = Array.isArray(record.properties.status) ? record.properties.status[0] : record.properties.status;
  const isQuote = object === 'quotes';
  const isInvoice = object === 'invoices';
  // quotes and invoices: a link for one customer, no embed snippet
  const isDoc = isQuote || isInvoice;
  const isBooking = object === 'booking_pages';
  const pageUrl = key ? `${window.location.origin}/p/${PATH[object]}/#${key}` : null;
  const kind = isQuote ? 'quote' : isInvoice ? 'invoice' : isBooking ? 'booking page' : 'form';
  const isDraft = !status || status === 'draft';
  const [busy, setBusy] = useState(false);
  const snippet = key && !isDoc
    ? `<div data-pcrm-${isBooking ? 'booking' : 'form'}="${key}"></div>\n<script src="${window.location.origin}/p/embed.js" async></script>`
    : null;

  async function saveSlug() {
    setError(null);
    try {
      onChanged(await api<CrmRecord>('PATCH', `/v1/objects/${object}/${record.id}`, { properties: { slug: slug.trim().toLowerCase() || null } }));
      toast(slug.trim() ? 'Address saved' : 'Address removed');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function generate() {
    if (publicKey && !confirm(isDoc || isBooking
      ? 'Make a new link? The current link stops working for anyone who has it.'
      : 'Make a new key? Websites that embed this form stop working until their snippet is updated.')) return;
    setError(null);
    try {
      const res = await api<{ public_key: string }>('POST', `/v1/objects/${object}/${record.id}/public-link`);
      onChanged({ ...record, properties: { ...record.properties, public_key: res.public_key } });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // makes the link first when there is none, then sets the published status
  async function publish() {
    setError(null);
    setBusy(true);
    try {
      let props = record.properties;
      if (!publicKey && !savedSlug) {
        const res = await api<{ public_key: string }>('POST', `/v1/objects/${object}/${record.id}/public-link`);
        props = { ...props, public_key: res.public_key };
        onChanged({ ...record, properties: props });
      }
      onChanged(await api<CrmRecord>('PATCH', `/v1/objects/${object}/${record.id}`, { properties: { status: PUBLISHED[object] } }));
      toast(isQuote ? 'Quote sent' : isInvoice ? 'Invoice opened' : `${isBooking ? 'Booking page' : 'Form'} published`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError('Could not copy; select the text and copy it instead.');
    }
  }

  // drafts get the Publish button; other statuses that hide the page (void, archived, ...) say so
  const live = isQuote ? !isDraft : isInvoice ? status === 'open' || status === 'paid' : status === 'published';
  const hint = isDraft
    ? `Customers can open the link once the ${kind} is published.`
    : !live ? `Customers cannot open the link while the ${kind} is ${String(status).replace(/_/g, ' ')}.` : null;

  return (
    <div className="card public-link">
      <div className="card-head">
        <span className="card-icon"><Globe size={15} strokeWidth={1.75} /></span>
        <h3>{isDoc ? 'Customer link' : isBooking ? 'Booking link' : 'Public form'}</h3>
        <span className="push-right">
          <StatusPill tone={isDraft ? 'off' : live ? 'on' : 'warn'}>{isDraft ? 'Draft' : live ? 'Live' : 'Hidden'}</StatusPill>
        </span>
      </div>
      {isDraft && (
        <div className="public-link-publish">
          <span className="small">{`Publish so customers can open the ${kind}.`}</span>
          <button className="btn primary small" onClick={publish} disabled={busy}>{busy ? 'Publishing…' : 'Publish'}</button>
        </div>
      )}
      <label className="field">
        <span>Page address</span>
        <div className="public-link-row slug">
          <span className="public-link-prefix">/p/{PATH[object]}/#</span>
          <input value={slug} placeholder={SLUG_EXAMPLE[object]} maxLength={60} aria-label="Page address"
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            onKeyDown={(e) => e.key === 'Enter' && slug !== savedSlug && saveSlug()} />
          {slug !== savedSlug && <button className="btn small" onClick={saveSlug}>Save</button>}
        </div>
        {isDoc && <div className="small muted">Optional. Anyone who knows or guesses this address can open the {kind}; leave it empty to share only the random link.</div>}
      </label>
      {!key && <div className="muted small">{isDoc ? `No link yet. Publish, or make one to share this ${kind} with the customer.` : isBooking ? 'No link yet. Publish, or make one to share this booking page.' : 'No key yet. Publish, or make one to host or embed this form.'}</div>}
      {pageUrl && (
        <div className="public-link-row url">
          <input readOnly value={pageUrl} onFocus={(e) => e.target.select()} aria-label="Link" />
          <button className="icon-btn" onClick={() => copy(pageUrl, 'link')} aria-label="Copy link"><Copy size={15} /></button>
          <a className="icon-btn" href={pageUrl} target="_blank" rel="noreferrer" aria-label="Open link"><ExternalLink size={15} /></a>
        </div>
      )}
      {snippet && (
        <>
          <div className="public-link-label">Embed on a website</div>
          <textarea readOnly className="public-link-snippet" value={snippet} rows={3} onFocus={(e) => e.target.select()} aria-label="Embed snippet" />
          <div className="small muted">
            The website must be listed under {me.is_admin ? <Link to="/settings/embed-domains">Embed domains</Link> : 'Embed domains'} in Settings.
          </div>
        </>
      )}
      {hint && <div className="small muted">{hint}</div>}
      {error && <div className="error">{error}</div>}
      <div className="public-link-actions">
        {!savedSlug && (
          <button className="btn small" onClick={generate}>{publicKey ? (isDoc || isBooking ? 'New link' : 'New key') : (isDoc || isBooking ? 'Make link' : 'Make key')}</button>
        )}
        {snippet && <button className="btn small" onClick={() => copy(snippet, 'snippet')}>Copy snippet</button>}
        {key && isQuote && status && status !== 'draft' && <a className="btn small" href={`${API_BASE}/v1/public/quotes/${encodeURIComponent(key)}/pdf`}>PDF</a>}
        {copied && <span className="small muted" role="status">Copied</span>}
      </div>
    </div>
  );
}
