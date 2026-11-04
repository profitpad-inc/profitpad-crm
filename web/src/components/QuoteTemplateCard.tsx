import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileCode2 } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { loadTemplateChoices, templateOptions, type TemplateChoice } from '../lib/templates';
import { Select } from './Select';

// Record page card for quotes: which document template draws the quote for
// the customer (their page and the PDF). "Default (name)" links no template,
// so the quote follows whatever the default is; another choice links that
// template (a quote links to at most one, migration 0075).
export function QuoteTemplateCard({ quoteId, canEdit }: { quoteId: string; canEdit: boolean }) {
  const { toast } = useApp();
  const [templates, setTemplates] = useState<TemplateChoice[] | null>(null);
  // the linked template's id, '' when the quote uses the default
  const [linked, setLinked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadTemplateChoices('quotes'),
      api<{ results: { record_id: string }[] }>('GET', `/v1/objects/quotes/${quoteId}/associations?to_object=document_templates`)
    ]).then(([list, links]) => {
      if (cancelled) return;
      setTemplates(list);
      setLinked(links.results[0]?.record_id ?? '');
    }).catch((err) => !cancelled && setError((err as Error).message));
    return () => { cancelled = true; };
  }, [quoteId]);

  async function pick(next: string) {
    if (linked === null || next === linked) return;
    setBusy(true);
    setError(null);
    try {
      // one template per quote: unlink the old one first
      if (linked) await api('DELETE', `/v1/objects/quotes/${quoteId}/associations/document_templates/${linked}`);
      if (next) await api('PUT', `/v1/objects/quotes/${quoteId}/associations/document_templates/${next}`, {});
      setLinked(next);
      toast('Template changed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && templates === null) return null;
  // a linked template that is no longer published (archived, say) is not used:
  // the quote falls back to the default until another is picked
  const current = linked && templates?.some((t) => t.id === linked) ? linked : '';
  const shown = templates?.find((t) => (current ? t.id === current : t.isDefault));
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-icon"><FileCode2 size={15} strokeWidth={1.75} /></span>
        <h3>Template</h3>
      </div>
      {templates === null || linked === null ? (
        <div className="muted small">Loading…</div>
      ) : (
        <>
          <Select value={current} onChange={(v) => void pick(v)} options={templateOptions(templates)}
            disabled={!canEdit || busy} aria-label="Document template" />
          <div className="muted small" style={{ marginTop: 8 }}>
            How the customer's page and the PDF look.
            {shown && <> <Link to={`/objects/document_templates/${shown.id}`}>Open {shown.name}</Link></>}
          </div>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
