import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { Loading } from './Loading';
import { useFillColumn } from '../lib/use-fill-column';

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

  // the quote runs down to the bottom of the record's middle column, like a landing page preview
  const { ref: bodyRef, height: bodyHeight } = useFillColumn<HTMLDivElement>([out, error]);

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
        ? (
          <div ref={bodyRef} className="landing-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
            <iframe className="landing-preview" title="Quote preview" sandbox="allow-same-origin" srcDoc={out.html} />
          </div>
        )
        : <p className="muted">Publish a quote template, or pick one in the Template card, to see the quote here.</p>}
    </div>
  );
}
