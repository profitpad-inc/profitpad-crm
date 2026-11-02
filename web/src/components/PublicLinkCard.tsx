import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, Globe } from 'lucide-react';
import { API_BASE, api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';

// Record page card for quotes, forms and booking pages: the customer-facing
// link (/p/quote/#key, /p/form/#key, /p/book/#key), plus the embed snippet
// for forms and booking pages. A booking page can also have an address the
// user picks (slug, /p/book/#intro-call), used in its link and snippet.
export function PublicLinkCard({ object, record, onChanged }: {
  object: 'quotes' | 'forms' | 'booking_pages'; record: CrmRecord; onChanged: (r: CrmRecord) => void;
}) {
  const { me, toast } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const savedSlug = typeof record.properties.slug === 'string' ? record.properties.slug : '';
  const [slug, setSlug] = useState(savedSlug);
  useEffect(() => setSlug(savedSlug), [savedSlug]);
  const publicKey = typeof record.properties.public_key === 'string' ? record.properties.public_key : null;
  // what goes after the # in links and snippets: the slug when there is one
  const key = (object === 'booking_pages' && savedSlug) || publicKey;
  const status = Array.isArray(record.properties.status) ? record.properties.status[0] : record.properties.status;
  const isQuote = object === 'quotes';
  const isBooking = object === 'booking_pages';
  const pageUrl = key ? `${window.location.origin}/p/${isQuote ? 'quote' : isBooking ? 'book' : 'form'}/#${key}` : null;
  const snippet = key && !isQuote
    ? `<div data-pcrm-${isBooking ? 'booking' : 'form'}="${key}"></div>\n<script src="${window.location.origin}/p/embed.js" async></script>`
    : null;

  async function saveSlug() {
    setError(null);
    try {
      onChanged(await api<CrmRecord>('PATCH', `/v1/objects/booking_pages/${record.id}`, { properties: { slug: slug.trim().toLowerCase() || null } }));
      toast(slug.trim() ? 'Address saved' : 'Address removed');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function generate() {
    if (publicKey && !confirm(isQuote || isBooking
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

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError('Could not copy; select the text and copy it instead.');
    }
  }

  const hint = isQuote
    ? status === 'draft' || !status ? 'Customers can open the link once the quote status is Sent.' : null
    : status !== 'published' ? `The ${isBooking ? 'booking page' : 'form'} works once its status is Published.` : null;

  return (
    <div className="card public-link">
      <div className="card-head">
        <Globe size={16} strokeWidth={1.75} />
        <h3>{isQuote ? 'Customer link' : isBooking ? 'Booking link' : 'Public form'}</h3>
      </div>
      {isBooking && (
        <label className="field">
          <span>Page address</span>
          <div className="public-link-row">
            <span className="muted small">/p/book/#</span>
            <input value={slug} placeholder="intro-call" maxLength={60} aria-label="Page address"
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              onKeyDown={(e) => e.key === 'Enter' && slug !== savedSlug && saveSlug()} />
            {slug !== savedSlug && <button className="btn small" onClick={saveSlug}>Save</button>}
          </div>
        </label>
      )}
      {!key && <div className="muted small">{isQuote ? 'No link yet. Make one to share this quote with the customer.' : isBooking ? 'No link yet. Make one to share this booking page.' : 'No key yet. Make one to host or embed this form.'}</div>}
      {pageUrl && (
        <div className="public-link-row">
          <input readOnly value={pageUrl} onFocus={(e) => e.target.select()} aria-label="Link" />
          <button className="icon-btn" onClick={() => copy(pageUrl, 'link')} aria-label="Copy link"><Copy size={15} /></button>
          <a className="icon-btn" href={pageUrl} target="_blank" rel="noreferrer" aria-label="Open link"><ExternalLink size={15} /></a>
        </div>
      )}
      {snippet && (
        <>
          <div className="small muted">Embed on a website</div>
          <textarea readOnly className="public-link-snippet" value={snippet} rows={3} onFocus={(e) => e.target.select()} aria-label="Embed snippet" />
          <div className="small muted">
            The website must be listed in {me.is_admin ? <Link to="/settings/forms">Settings → Forms</Link> : 'Settings → Forms'}.
          </div>
        </>
      )}
      {hint && key && <div className="small muted">{hint}</div>}
      {error && <div className="error">{error}</div>}
      <div className="public-link-actions">
        {!(isBooking && savedSlug) && (
          <button className="btn small" onClick={generate}>{publicKey ? (isQuote || isBooking ? 'New link' : 'New key') : (isQuote || isBooking ? 'Make link' : 'Make key')}</button>
        )}
        {snippet && <button className="btn small" onClick={() => copy(snippet, 'snippet')}>Copy snippet</button>}
        {key && isQuote && status && status !== 'draft' && <a className="btn small" href={`${API_BASE}/v1/public/quotes/${encodeURIComponent(key)}/pdf`}>PDF</a>}
        {copied && <span className="small muted">Copied</span>}
      </div>
    </div>
  );
}
