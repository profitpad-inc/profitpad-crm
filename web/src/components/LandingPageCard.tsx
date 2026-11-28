import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Pencil } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { CodeBlock } from './CodeBlock';
import { CodeTextarea } from './CodeTextarea';
import { confirmDialog } from './confirm';
import { Loading } from './Loading';
import { McpNotice } from './McpNotice';
import { useFillColumn } from '../lib/use-fill-column';

interface LandingPageOut {
  id: string;
  slug: string;
  status: 'draft' | 'published';
  url_path: string;
  unpublished_changes: boolean;
  published_at: string | null;
  draft_html: string | null;
  html: string | null;
}

const WRAP_KEY = 'pcrm.viewCodeWrap';

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === '1';
  } catch {
    return false;
  }
}

const pagePath = (slug: string, draft = false) => `/p/page/${draft ? '?draft=1' : ''}#${slug}`;

// A landing page's record page: a preview and the HTML (draft and
// published), with Open, Copy link, Publish and Unpublish. Pages are usually
// written by admins' AI through the API or MCP; Edit on the draft lets an admin
// type in the HTML by hand, and saving returns to the read-only view.
export function LandingPageCard({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const [page, setPage] = useState<LandingPageOut | null>(null);
  const [which, setWhich] = useState<'draft' | 'published'>('draft');
  const [tab, setTab] = useState<'preview' | 'html'>('preview');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wrap, setWrap] = useState(readWrap);
  const [editing, setEditing] = useState(false);
  const [draftHtml, setDraftHtml] = useState('');

  const load = (pg: LandingPageOut) => {
    setPage(pg);
    setDraftHtml(pg.draft_html ?? '');
  };

  useEffect(() => {
    let live = true;
    api<LandingPageOut>('GET', `/v1/landing-pages/${record.id}`)
      .then((pg) => live && load(pg))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [record.id, record.properties.updated_at]);

  // the preview (or HTML) runs down to the bottom of the record's middle column
  const { ref: bodyRef, height: bodyHeight } = useFillColumn<HTMLDivElement>([page, error, tab, which, editing]);

  useEffect(() => {
    try {
      localStorage.setItem(WRAP_KEY, wrap ? '1' : '0');
    } catch {
      // per-viewer convenience only
    }
  }, [wrap]);

  async function act(path: 'publish' | 'unpublish', done: string) {
    setBusy(true);
    setError(null);
    try {
      load(await api<LandingPageOut>('POST', `/v1/landing-pages/${record.id}/${path}`));
      onChanged(await api<CrmRecord>('GET', `/v1/objects/landing_pages/${record.id}`));
      toast(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!(await confirmDialog('Anyone with the link will be able to open this page.', { title: 'Publish the draft?', confirmLabel: 'Publish' }))) return;
    await act('publish', 'Published');
  }

  async function unpublish() {
    if (!(await confirmDialog('The link will show "Page not found" until you publish again. The HTML is kept.', { title: 'Take this page down?', confirmLabel: 'Unpublish', danger: true }))) return;
    await act('unpublish', 'Unpublished');
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      load(await api<LandingPageOut>('PUT', `/v1/landing-pages/${record.id}/draft`, { html: draftHtml }));
      onChanged(await api<CrmRecord>('GET', `/v1/objects/landing_pages/${record.id}`));
      setEditing(false);
      toast('Draft saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!page) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${pagePath(page.slug)}`);
      toast('Link copied');
    } catch {
      setError('Could not copy the link');
    }
  }

  if (error && !page) return <div className="card"><div className="error">{error}</div></div>;
  if (!page) return <div className="card muted"><Loading /></div>;
  const published = page.status === 'published';
  const html = which === 'draft' ? page.draft_html : page.html;
  const previewSrc = which === 'draft' ? pagePath(page.slug, true) : pagePath(page.slug);
  const dirty = draftHtml !== (page.draft_html ?? '');
  // typing in the draft's HTML: Edit was pressed, or there are unsaved changes
  const typing = which === 'draft' && tab === 'html' && (editing || dirty);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Page</h3>
        <span className="muted small">
          {published ? (page.unpublished_changes ? 'Published, draft has changes' : 'Published') : page.html ? 'Not published (taken down)' : 'Draft, not published yet'}
        </span>
        <span style={{ flex: 1 }} />
        {page.draft_html && <a className="btn small" href={pagePath(page.slug, true)} target="_blank" rel="noreferrer">Open draft <ExternalLink size={12} /></a>}
        {published && <a className="btn small" href={pagePath(page.slug)} target="_blank" rel="noreferrer">Open <ExternalLink size={12} /></a>}
        {published && <button className="btn small" onClick={copyLink}><Copy size={12} /> Copy link</button>}
        {published && <button className="btn small" disabled={busy} onClick={unpublish}>Unpublish</button>}
        {page.unpublished_changes && page.draft_html && (
          <button className="btn small primary" disabled={busy || dirty} title={dirty ? 'Save the draft first' : undefined} onClick={publish}>Publish</button>
        )}
      </div>
      <McpNotice kind="landing_pages" />
      {error && <div className="error">{error}</div>}
      <div className="tabs">
        <div className={`tab${which === 'draft' ? ' active' : ''}`}><button onClick={() => setWhich('draft')}>Draft</button></div>
        <div className={`tab${which === 'published' ? ' active' : ''}`}><button onClick={() => setWhich('published')} disabled={!published}>Published</button></div>
        <span style={{ flex: 1 }} />
        {tab === 'html' && !typing && (
          <label className="small muted code-wrap-toggle">
            <input type="checkbox" role="switch" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
          </label>
        )}
        {which === 'draft' && !typing && (
          <button className="btn small template-edit" onClick={() => { setTab('html'); setEditing(true); }}><Pencil size={13} /> Edit</button>
        )}
        <div className={`tab${tab === 'preview' ? ' active' : ''}`}><button onClick={() => setTab('preview')}>Preview</button></div>
        <div className={`tab${tab === 'html' ? ' active' : ''}`}><button onClick={() => setTab('html')}>HTML</button></div>
      </div>
      {typing ? (
        <>
          <div ref={bodyRef} className="landing-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
            <CodeTextarea value={draftHtml} autoFocus aria-label="Page HTML"
              placeholder="<!doctype html> ..."
              onChange={(e) => setDraftHtml(e.target.value)} />
          </div>
          <div className="template-actions">
            <span className="muted small">Folding comes back after you save.</span>
            <span style={{ flex: 1 }} />
            {dirty
              ? <button className="btn small ghost" disabled={busy} onClick={() => { setDraftHtml(page.draft_html ?? ''); setError(null); setEditing(false); }}>Discard</button>
              : <button className="btn small ghost" onClick={() => setEditing(false)}>Done</button>}
            <button className="btn small primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving...' : 'Save draft'}</button>
          </div>
        </>
      ) : !html ? (
        <p className="muted">No HTML yet. Ask your AI to build this page through the CRM's MCP connection{which === 'draft' ? ', or press Edit to write it' : ''}.</p>
      ) : (
        <div ref={bodyRef} className="landing-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
          {tab === 'preview'
            ? <iframe key={`${which}-${record.properties.updated_at as string}`} className="landing-preview" title="Page preview" src={previewSrc} />
            : <CodeBlock text={html} wrap={wrap} lang="html" />}
        </div>
      )}
    </div>
  );
}
