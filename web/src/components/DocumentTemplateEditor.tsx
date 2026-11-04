import { useEffect, useRef, useState } from 'react';
import { FileDown, RefreshCw } from 'lucide-react';
import { API_BASE, api, type CrmRecord, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Select } from './Select';
import { confirmDialog } from './confirm';

// The Template card on a document template's record page (api/src/templates.ts):
// the draft's code and data sources, editable by admins, Publish / Default /
// Revert, and a preview for a real record, as the customer's page and as a PDF.
// AIs usually write templates through the MCP tools; this is for looking and
// small changes.

interface TemplateOut {
  id: string;
  name: string | null;
  object: string;
  kind: 'html' | 'react';
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
  const [tab, setTab] = useState<'code' | 'queries'>('code');
  const [source, setSource] = useState('');
  const [queries, setQueries] = useState('');
  const [kind, setKind] = useState<'html' | 'react'>('html');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<{ value: string; label: string }[]>([]);
  const [recordId, setRecordId] = useState('');
  const [preview, setPreview] = useState<{ html: string; warnings: string[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  const load = (out: TemplateOut) => {
    setT(out);
    setSource(out.draft_source ?? '');
    setQueries(out.draft_queries ?? '');
    setKind(out.kind);
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
      .catch(() => undefined);
  }, [t?.object]);

  if (error && !t) return <div className="card"><div className="error">{error}</div></div>;
  if (!t) return <div className="card muted">Loading…</div>;
  const dirty = source !== (t.draft_source ?? '') || queries !== (t.draft_queries ?? '') || kind !== t.kind;
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
    if (await act(() => api('PUT', `/v1/document-templates/${record.id}/draft`, { source, queries: parsed ?? {}, kind }), 'Draft saved')) {
      void showPreview();
    }
  }

  async function showPreview() {
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await api('POST', `/v1/document-templates/${record.id}/render`, { record_id: recordId || undefined, draft: which === 'draft' }));
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
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
      setError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  const fit = () => {
    const doc = frame.current?.contentDocument;
    if (frame.current && doc?.documentElement) frame.current.style.height = `${Math.max(400, Math.min(doc.documentElement.scrollHeight, 6000))}px`;
  };

  const shownSource = which === 'draft' ? source : t.source ?? '';
  const shownQueries = which === 'draft' ? queries : t.queries ?? '';
  const readOnly = which === 'published' || !canEdit;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Template</h3>
          <span className="muted small">
            {t.kind === 'react' ? 'React' : 'HTML (Liquid)'} · {t.status === 'published' ? (t.unpublished_changes ? 'Published, draft has changes' : 'Published') : 'Draft, not published yet'}
            {t.is_default ? ' · Default for every record without its own template' : ''}
          </span>
          <span style={{ flex: 1 }} />
          {canEdit && t.status === 'published' && t.unpublished_changes && (
            <button className="btn small ghost" disabled={busy} onClick={async () => { if (await confirmDialog('Throw away the draft\'s changes? The draft becomes the published version again.', { title: 'Revert the draft?', confirmLabel: 'Revert', danger: true })) void act(() => api('POST', `/v1/document-templates/${record.id}/revert`), 'Draft reverted'); }}>Revert draft</button>
          )}
          {canEdit && t.status === 'published' && (
            <button className="btn small" disabled={busy} onClick={() => void act(() => api('POST', `/v1/document-templates/${record.id}/default`, { default: !t.is_default }), t.is_default ? 'No longer the default' : 'Now the default')}>
              {t.is_default ? 'Stop being the default' : 'Make default'}
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
          <div className={`tab${tab === 'code' ? ' active' : ''}`}><button onClick={() => setTab('code')}>{t.kind === 'react' ? 'React' : 'HTML'}</button></div>
          <div className={`tab${tab === 'queries' ? ' active' : ''}`}><button onClick={() => setTab('queries')}>Data sources</button></div>
        </div>
        {tab === 'code' ? (
          <textarea className="view-code template-code" spellCheck={false} value={shownSource} readOnly={readOnly}
            placeholder={readOnly ? 'No code yet.' : 'An HTML page with Liquid tags, like {{ quote.name }}, or React (TSX) whose default export gets the data prop.'}
            onChange={(e) => setSource(e.target.value)} aria-label="Template code" />
        ) : (
          <textarea className="view-code template-code short" spellCheck={false} value={shownQueries} readOnly={readOnly}
            placeholder={'{"summary": {"sql": "select count(*) as lines from view_data.associations where object_type_id = \'pc_0022\' and record_id = :record_id and other_object_type_id = \'pc_0020\'"}}'}
            onChange={(e) => setQueries(e.target.value)} aria-label="Data sources" />
        )}
        {which === 'draft' && canEdit && (
          <div className="template-actions">
            <Select value={kind} onChange={(v) => setKind(v as 'html' | 'react')} aria-label="Written in"
              options={[{ value: 'html', label: 'HTML (Liquid)' }, { value: 'react', label: 'React' }]} />
            <span style={{ flex: 1 }} />
            {dirty && <button className="btn small ghost" disabled={busy} onClick={() => load(t)}>Discard</button>}
            <button className="btn small primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving...' : 'Save draft'}</button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Preview</h3>
          <span className="muted small">{which === 'draft' ? 'The draft' : 'The published version'}, for</span>
          <div className="template-record">
            <Select value={recordId} onChange={setRecordId} aria-label="Record to preview" options={records.length ? records : [{ value: '', label: 'No records yet' }]} />
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn small" disabled={previewing || !shownSource} onClick={() => void showPreview()}><RefreshCw size={13} /> {preview ? 'Refresh' : 'Show'}</button>
          <button className="btn small" disabled={previewing || !shownSource} onClick={() => void pdf()}><FileDown size={13} /> PDF</button>
        </div>
        {preview?.warnings.length ? <div className="callout warn small">{preview.warnings.map((w) => <div key={w}>{w}</div>)}</div> : null}
        {preview
          ? <iframe ref={frame} className="template-preview" title="Template preview" sandbox="allow-same-origin" srcDoc={preview.html} onLoad={fit} />
          : <p className="muted">{previewing ? 'Drawing…' : 'Show draws the template for the chosen record, as the customer sees it.'}</p>}
      </div>
    </>
  );
}
