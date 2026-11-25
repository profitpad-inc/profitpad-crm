import { useEffect, useState } from 'react';
import { FileDown, Pencil, RefreshCw } from 'lucide-react';
import { API_BASE, api, type CrmRecord, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Select } from './Select';
import { confirmDialog } from './confirm';
import { CodeTextarea } from './CodeTextarea';
import { Loading } from './Loading';
import { CodeBlock } from './CodeBlock';
import { useFillColumn } from '../lib/use-fill-column';

// The Template card on a document template's record page (api/src/templates.ts),
// laid out like a landing page's: Draft / Published, then Preview (drawn for a
// real record, as the customer's page or as a PDF), HTML and Data sources. Code
// shows read-only first (line numbers, VS Code style folding, copy), running to
// the bottom of the record's column; admins press Edit on the draft to type in
// it, and saving returns to the read-only view.
// Publish / Default / Revert sit in the card's head.
// AIs usually write templates through the MCP tools; this is for looking and
// small changes.

const WRAP_KEY = 'pcrm.viewCodeWrap';

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === '1';
  } catch {
    return false;
  }
}

interface TemplateOut {
  id: string;
  name: string | null;
  object: string;
  status: 'draft' | 'published';
  is_default: boolean;
  unpublished_changes: boolean;
  draft_source: string | null;
  draft_queries: string | null;
  source: string | null;
  queries: string | null;
}

export function DocumentTemplateEditor({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast, me } = useApp();
  const [t, setT] = useState<TemplateOut | null>(null);
  const [which, setWhich] = useState<'draft' | 'published'>('draft');
  const [tab, setTab] = useState<'preview' | 'code' | 'queries'>('preview');
  const [wrap, setWrap] = useState(readWrap);
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState('');
  const [queries, setQueries] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null until the records to preview with have loaded
  const [records, setRecords] = useState<{ value: string; label: string }[] | null>(null);
  const [recordId, setRecordId] = useState('');
  const [preview, setPreview] = useState<{ html: string; warnings: string[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [nonce, setNonce] = useState(0);

  const load = (out: TemplateOut) => {
    setT(out);
    setSource(out.draft_source ?? '');
    setQueries(out.draft_queries ?? '');
  };

  useEffect(() => {
    let live = true;
    api<TemplateOut>('GET', `/v1/document-templates/${record.id}`)
      .then((out) => live && load(out))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [record.id]);

  // records to preview with: the newest of the template's object
  useEffect(() => {
    if (!t) return;
    api<SearchResult>('POST', `/v1/objects/${t.object}/search`, { limit: 25, properties: ['name'], sorts: [{ property: 'updated_at', direction: 'desc' }] })
      .then((r) => {
        const list = r.results.map((x) => ({ value: x.id, label: String(x.properties.name ?? `#${x.id}`) }));
        setRecords(list);
        setRecordId((id) => id || list[0]?.value || '');
      })
      .catch(() => setRecords([]));
  }, [t?.object]);

  useEffect(() => {
    try {
      localStorage.setItem(WRAP_KEY, wrap ? '1' : '0');
    } catch {
      // per-viewer convenience only
    }
  }, [wrap]);

  // the Preview tab draws the saved draft (or the published version) for the
  // chosen record, again after each save, publish or Refresh
  const savedSource = t ? (which === 'draft' ? t.draft_source : t.source) : null;
  useEffect(() => {
    if (tab !== 'preview' || !t || records === null) return;
    if (!savedSource) {
      setPreview(null);
      return;
    }
    let live = true;
    setPreviewing(true);
    setPreviewError(null);
    api<{ html: string; warnings: string[] }>('POST', `/v1/document-templates/${record.id}/render`, { record_id: recordId || undefined, draft: which === 'draft' })
      .then((p) => live && setPreview(p))
      .catch((e: Error) => {
        if (!live) return;
        setPreviewError(e.message);
        setPreview(null);
      })
      .finally(() => live && setPreviewing(false));
    return () => {
      live = false;
    };
  }, [tab, which, recordId, t, records === null, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // the preview runs down to the bottom of the record's middle column
  const { ref: bodyRef, height: bodyHeight } = useFillColumn<HTMLDivElement>([t, error, tab, which, preview, previewError, editing, source !== (t?.draft_source ?? '') || queries !== (t?.draft_queries ?? '')]);

  if (error && !t) return <div className="card"><div className="error">{error}</div></div>;
  if (!t) return <div className="card muted"><Loading /></div>;
  const dirty = source !== (t.draft_source ?? '') || queries !== (t.draft_queries ?? '');
  const canEdit = me.is_admin;

  async function act(fn: () => Promise<TemplateOut>, done: string) {
    setBusy(true);
    setError(null);
    try {
      load(await fn());
      onChanged(await api<CrmRecord>('GET', `/v1/objects/document_templates/${record.id}`));
      toast(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    let parsed: unknown = undefined;
    if (queries.trim()) {
      try {
        parsed = JSON.parse(queries);
      } catch {
        setError('Data sources must be JSON: {"name": {"sql": "select ... where id = :record_id"}}');
        return;
      }
    }
    if (await act(() => api('PUT', `/v1/document-templates/${record.id}/draft`, { source, queries: parsed ?? {} }), 'Draft saved')) setEditing(false);
  }

  async function pdf() {
    setPreviewing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/v1/document-templates/${record.id}/render`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ record_id: recordId || undefined, draft: which === 'draft', format: 'pdf' })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? res.statusText);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setPreviewError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  const shownSource = which === 'draft' ? source : t.source ?? '';
  const shownQueries = which === 'draft' ? queries : t.queries ?? '';
  const readOnly = which === 'published' || !canEdit;
  // typing in the draft: Edit was pressed, or there are unsaved changes
  const typing = !readOnly && (editing || dirty);

  return (
    <>
      <div className="card">
        <div className="card-head template-head">
          <h3>Template</h3>
          <span className="muted small">
            HTML (Liquid) · {t.status === 'published' ? (t.unpublished_changes ? 'Published, draft has changes' : 'Published') : 'Draft, not published yet'}
            {t.is_default ? ' · Default for every record without its own template' : ''}
          </span>
          <span style={{ flex: 1 }} />
          {canEdit && t.status === 'published' && t.unpublished_changes && (
            <button className="btn small ghost" disabled={busy} onClick={async () => { if (await confirmDialog('Throw away the draft\'s changes? The draft becomes the published version again.', { title: 'Revert the draft?', confirmLabel: 'Revert', danger: true })) void act(() => api('POST', `/v1/document-templates/${record.id}/revert`), 'Draft reverted'); }}>Revert draft</button>
          )}
          {/* there is always a default: it changes by making another template the default */}
          {canEdit && t.status === 'published' && !t.is_default && (
            <button className="btn small" disabled={busy} onClick={() => void act(() => api('POST', `/v1/document-templates/${record.id}/default`, { default: true }), 'Now the default')}>
              Make default
            </button>
          )}
          {canEdit && t.unpublished_changes && t.draft_source && (
            <button className="btn small primary" disabled={busy || dirty}
              title={dirty ? 'Save the draft first' : undefined}
              onClick={async () => { if (await confirmDialog('Customers will see it on records that use this template.', { title: 'Publish the draft?', confirmLabel: 'Publish' })) void act(() => api('POST', `/v1/document-templates/${record.id}/publish`), 'Published'); }}>
              Publish
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="tabs">
          <div className={`tab${which === 'draft' ? ' active' : ''}`}><button onClick={() => setWhich('draft')}>Draft</button></div>
          <div className={`tab${which === 'published' ? ' active' : ''}`}><button onClick={() => setWhich('published')} disabled={!t.source}>Published</button></div>
          <span style={{ flex: 1 }} />
          {tab !== 'preview' && !typing && (
            <label className="small muted code-wrap-toggle">
              <input type="checkbox" role="switch" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
            </label>
          )}
          {tab !== 'preview' && !readOnly && !typing && (
            <button className="btn small template-edit" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>
          )}
          <div className={`tab${tab === 'preview' ? ' active' : ''}`}><button onClick={() => setTab('preview')}>Preview</button></div>
          <div className={`tab${tab === 'code' ? ' active' : ''}`}><button onClick={() => setTab('code')}>HTML</button></div>
          <div className={`tab${tab === 'queries' ? ' active' : ''}`}><button onClick={() => setTab('queries')}>Data sources</button></div>
        </div>
        {tab === 'preview' ? (
          <>
            <div className="template-toolbar">
              <span className="muted small">For</span>
              <div className="template-record">
                <Select value={recordId} onChange={setRecordId} aria-label="Record to preview" options={records?.length ? records : [{ value: '', label: 'No records yet' }]} />
              </div>
              <span style={{ flex: 1 }} />
              <button className="btn small" disabled={previewing || !savedSource} onClick={() => setNonce((n) => n + 1)}><RefreshCw size={13} /> Refresh</button>
              <button className="btn small" disabled={previewing || !savedSource} onClick={() => void pdf()}><FileDown size={13} /> PDF</button>
            </div>
            {which === 'draft' && dirty && <div className="callout small">This is the saved draft. Save to see your changes here.</div>}
            {previewError && <div className="error">{previewError}</div>}
            {preview?.warnings.length ? <div className="callout warn small">{preview.warnings.map((w) => <div key={w}>{w}</div>)}</div> : null}
            {preview ? (
              <div ref={bodyRef} className="landing-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
                <iframe className="landing-preview" title="Template preview" sandbox="allow-same-origin" srcDoc={preview.html} />
              </div>
            ) : previewing || records === null ? (
              <Loading className="muted" />
            ) : !previewError && (
              <p className="muted">{savedSource ? 'Nothing to show yet.' : which === 'draft' ? 'No code yet. Write the HTML, then save the draft to see it here.' : 'Nothing published yet.'}</p>
            )}
          </>
        ) : !typing ? (
          (tab === 'code' ? shownSource : shownQueries) ? (
            <div ref={bodyRef} className="landing-body code-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
              <CodeBlock text={tab === 'code' ? shownSource : shownQueries} wrap={wrap} lang={tab === 'code' ? 'html' : 'js'} />
            </div>
          ) : (
            <p className="muted">{tab === 'code' ? 'No code yet.' : 'No data sources.'}{!readOnly && ' Press Edit to write it.'}</p>
          )
        ) : (
          <>
            <div ref={bodyRef} className="landing-body code-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
              {tab === 'code' ? (
                <CodeTextarea value={shownSource} autoFocus
                  placeholder="An HTML page with Liquid tags, like {{ quote.name }}."
                  onChange={(e) => setSource(e.target.value)} aria-label="Template code" />
              ) : (
                <CodeTextarea value={shownQueries} autoFocus
                  placeholder={'{"summary": {"sql": "select count(*) as lines from view_data.associations where object_type_id = \'pc_0022\' and record_id = :record_id and other_object_type_id = \'pc_0020\'"}}'}
                  onChange={(e) => setQueries(e.target.value)} aria-label="Data sources" />
              )}
            </div>
            <div className="template-actions">
              <span className="muted small">Folding comes back after you save.</span>
              <span style={{ flex: 1 }} />
              {dirty
                ? <button className="btn small ghost" disabled={busy} onClick={() => { load(t); setEditing(false); }}>Discard</button>
                : <button className="btn small ghost" onClick={() => setEditing(false)}>Done</button>}
              <button className="btn small primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving...' : 'Save draft'}</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
