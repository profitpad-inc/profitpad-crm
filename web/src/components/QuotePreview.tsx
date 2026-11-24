import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { Loading } from './Loading';

interface QuotePreviewOut {
  template: { id: string; name: string | null } | null;
  html: string | null;
  warnings: string[];
}

// A quote's Preview tab: the quote drawn by its document template (the linked
// one, else the default), as the customer sees it on their page and in the PDF
// (GET /v1/quotes/:id/preview). Drawn again when the quote changes, or on Refresh
// (a changed line does not always touch the quote itself).
export function QuotePreview({ record }: { record: CrmRecord }) {
  const [out, setOut] = useState<QuotePreviewOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    api<QuotePreviewOut>('GET', `/v1/quotes/${record.id}/preview`)
      .then((o) => live && setOut(o))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [record.id, record.properties.updated_at, nonce]);

  // the frame grows to the drawn page, so the stream scrolls and not the frame
  const fit = () => {
    const doc = frame.current?.contentDocument;
    if (frame.current && doc?.documentElement) frame.current.style.height = `${Math.max(400, Math.min(doc.documentElement.scrollHeight, 6000))}px`;
  };

  if (!out) return error ? <div className="card"><div className="error">{error}</div></div> : <div className="card muted"><Loading /></div>;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Preview</h3>
        <span className="muted small">
          {out.template
            ? <>As the customer sees it, drawn by <Link to={`/objects/document_templates/${out.template.id}`}>{out.template.name ?? 'its template'}</Link></>
            : 'No published template can draw this quote'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn small" disabled={busy} onClick={() => setNonce((n) => n + 1)}><RefreshCw size={13} /> Refresh</button>
      </div>
      {error && <div className="error">{error}</div>}
      {out.warnings.length > 0 && <div className="callout warn small">{out.warnings.map((w) => <div key={w}>{w}</div>)}</div>}
      {out.html
        ? <iframe ref={frame} className="landing-preview quote-preview" title="Quote preview" sandbox="allow-same-origin" srcDoc={out.html} onLoad={fit} />
        : <p className="muted">Publish a quote template, or pick one in the Template card, to see the quote here.</p>}
    </div>
  );
}
