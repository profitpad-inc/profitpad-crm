import { useEffect, useRef, useState } from 'react';
import { Code, Eye, Globe, Pencil, ImagePlus, Search, Upload } from 'lucide-react';
import { api, type SearchResult } from '../lib/api';
import { uploadFile, type FileInfo } from '../lib/files';
import { Menu, Modal } from './ui';
import '../html-editor.css';

// HTML values (text properties with display "html": email signatures, email
// template bodies, form HTML): a sandboxed preview, and an editor with the
// code beside a live preview and a way to add images. Images in an email must
// be public links, so an image is either a CRM file with its public link
// turned on, or a public web address.

const PREVIEW_STYLE = `html, body { margin: 0; } body { padding: 12px 14px; font: 14px/1.5 Inter, system-ui, sans-serif; color: #1f2328; background: #fff; overflow-wrap: anywhere; }
  img { max-width: 100%; } pre { white-space: pre-wrap; }`;

// No scripts, forms or plugins. allow-same-origin (without allow-scripts) only
// lets this page read the frame's height; links open in a new tab.
export function HtmlPreview({ html, title = 'HTML preview', minHeight = 40, maxHeight }: { html: string; title?: string; minHeight?: number; maxHeight?: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const fit = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const h = Math.max(minHeight, doc.documentElement.scrollHeight);
    setHeight(maxHeight ? Math.min(h, maxHeight) : h);
  };
  // images load after the frame does; size again when each one arrives
  const onLoad = () => {
    fit();
    frame.current?.contentDocument?.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
  };
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${PREVIEW_STYLE}</style></head><body>${html}</body></html>`;
  return (
    <iframe ref={frame} className="html-preview" title={title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc} style={{ height }} onLoad={onLoad} />
  );
}

// A saved HTML value on a record page or a settings page: the preview, or the
// code, with an Edit button when onEdit is given.
export function HtmlValue({ html, title, onEdit }: { html: string; title?: string; onEdit?: () => void }) {
  const [view, setView] = useState<'preview' | 'code'>('preview');
  return (
    <div className="html-value" onClick={(e) => e.stopPropagation()}>
      <div className="html-seg" role="group" aria-label="Show">
        <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}><Eye size={13} /> Preview</button>
        <button type="button" aria-pressed={view === 'code'} onClick={() => setView('code')}><Code size={13} /> HTML</button>
        {onEdit && <button type="button" onClick={onEdit}><Pencil size={13} /> Edit</button>}
      </div>
      {view === 'preview' ? <HtmlPreview html={html} title={title} maxHeight={480} /> : <pre className="html-code">{html}</pre>}
    </div>
  );
}

const imgTag = (src: string, alt: string) => `<img src="${src.replace(/"/g, '&quot;')}" alt="${alt.replace(/"/g, '&quot;')}" style="max-width: 200px; height: auto;">`;

// Turns on the file's public link (the same link if it is already on).
async function publicLink(id: string): Promise<string> {
  const f = await api<FileInfo>('POST', `/v1/files/${id}/public`);
  if (!f.public_url) throw new Error('this file has no public link');
  return f.public_url;
}

export function HtmlEditorModal({ title, value, hint, onSave, onClose }: {
  title: string; value: string; hint?: string;
  // resolves to the value as saved (the API may clean it), or throws
  onSave: (html: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'url' | 'files'>('none');
  const [busy, setBusy] = useState<string | null>(null);
  const code = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // where the cursor was when the code box last had it
  const caret = useRef<{ start: number; end: number }>({ start: value.length, end: value.length });

  // the preview follows typing after a short pause, so it does not reload on every key
  useEffect(() => {
    const t = setTimeout(() => setShown(draft), 300);
    return () => clearTimeout(t);
  }, [draft]);

  const remember = () => {
    const el = code.current;
    if (el) caret.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  function insert(snippet: string) {
    const { start, end } = caret.current;
    const next = draft.slice(0, start) + snippet + draft.slice(end);
    setDraft(next);
    setShown(next);
    const at = start + snippet.length;
    caret.current = { start: at, end: at };
    requestAnimationFrame(() => {
      const el = code.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  async function uploadImage(list: FileList | null) {
    const f = list?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setError('Pick an image file (PNG, JPEG, GIF, SVG or WebP).');
      return;
    }
    setError(null);
    try {
      setBusy(`Uploading ${f.name}…`);
      const id = await uploadFile(f, null, (fraction) => setBusy(`Uploading ${f.name}… ${Math.round(fraction * 100)}%`));
      setBusy('Turning on the public link…');
      insert(imgTag(await publicLink(id), f.name.replace(/\.[^.]+$/, '')));
    } catch (err) {
      setError(`Could not add the image: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  const changed = draft !== value;
  return (
    <Modal title={title} onClose={onClose} wide locked={changed} className="html-editor-modal"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving || busy !== null || !changed}>{saving ? 'Saving…' : 'Save'}</button>
        </>
      }>
      {hint && <p className="muted html-editor-hint">{hint}</p>}
      <div className="html-editor-tools">
        <Menu trigger={(open) => (
          <button type="button" className="btn small" onClick={open} disabled={busy !== null}><ImagePlus size={14} /> Add image</button>
        )}>
          {(close) => (
            <>
              <button onClick={() => { close(); setPanel('none'); fileInput.current?.click(); }}><Upload size={14} /> Upload to CRM files</button>
              <button onClick={() => { close(); setPanel('files'); }}><Search size={14} /> Choose a CRM file</button>
              <button onClick={() => { close(); setPanel('url'); }}><Globe size={14} /> From a web address</button>
            </>
          )}
        </Menu>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => uploadImage(e.target.files)} />
        {busy && <span className="muted">{busy}</span>}
      </div>
      {panel === 'url' && <UrlPanel onInsert={(src) => { insert(imgTag(src, '')); setPanel('none'); }} onCancel={() => setPanel('none')} />}
      {panel === 'files' && (
        <FilePanel
          onPick={async (f) => {
            setPanel('none');
            setError(null);
            try {
              setBusy('Turning on the public link…');
              insert(imgTag(f.public_url ?? (await publicLink(f.id)), (f.name ?? '').replace(/\.[^.]+$/, '')));
            } catch (err) {
              setError(`Could not use that file: ${(err as Error).message}`);
            } finally {
              setBusy(null);
            }
          }}
          onCancel={() => setPanel('none')}
        />
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="html-editor-panes">
        <label className="html-editor-pane">
          <span className="html-editor-label">HTML</span>
          <textarea ref={code} value={draft} spellCheck={false} autoFocus
            onChange={(e) => { setDraft(e.target.value); remember(); }} onSelect={remember} onKeyUp={remember} onClick={remember} />
        </label>
        <div className="html-editor-pane">
          <span className="html-editor-label">Preview</span>
          <div className="html-editor-preview">
            {shown.trim() ? <HtmlPreview html={shown} minHeight={120} /> : <div className="muted html-editor-empty">Nothing to show yet.</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function UrlPanel({ onInsert, onCancel }: { onInsert: (src: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const ok = /^https?:\/\/[^\s"<>]+$/i.test(url.trim());
  return (
    <div className="html-editor-panel">
      <input autoFocus placeholder="https://www.example.com/logo.png" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Image web address"
        onKeyDown={(e) => { if (e.key === 'Enter' && ok) onInsert(url.trim()); if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }} />
      <button className="btn small primary" disabled={!ok} onClick={() => onInsert(url.trim())}>Add</button>
      <button className="btn small" onClick={onCancel}>Cancel</button>
      {url.trim() && !ok && <div className="muted html-editor-panel-note">Use a full address starting with https:// that anyone can open.</div>}
    </div>
  );
}

interface FileRow { id: string; name: string | null; public_url: string | null }

// Image files the user can open, newest first, searched by name.
function FilePanel({ onPick, onCancel }: { onPick: (f: FileRow) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api<SearchResult>('POST', '/v1/objects/files/search', {
          query: query.trim() || undefined,
          limit: 20,
          properties: ['name', 'mime_type'],
          filter_groups: [{ filters: [{ property: 'mime_type', operator: 'starts_with', value: 'image/' }, { property: 'status', operator: 'eq', value: 'ready' }] }],
          sorts: [{ property: 'created_at', direction: 'desc' }]
        });
        if (cancelled) return;
        const ids = res.results.map((r) => r.id);
        // public links come from the file endpoint (the record holds only the token)
        const info = ids.length ? (await api<{ results: FileInfo[] }>('GET', `/v1/files?ids=${ids.join(',')}`)).results : [];
        if (cancelled) return;
        const byId = new Map(info.map((f) => [f.id, f]));
        setRows(res.results.map((r) => ({ id: r.id, name: (r.properties.name as string | null) ?? null, public_url: byId.get(r.id)?.public_url ?? null })));
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }, query ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  return (
    <div className="html-editor-panel files">
      <div className="html-editor-panel-row">
        <input autoFocus placeholder="Search image files by name" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search files"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }} />
        <button className="btn small" onClick={onCancel}>Cancel</button>
      </div>
      {error ? <div className="error">{error}</div>
        : rows === null ? <div className="muted">Loading…</div>
        : rows.length === 0 ? <div className="muted">No image files{query.trim() ? ' match that name' : ' yet. Upload one instead'}.</div>
        : (
          <ul className="html-file-list">
            {rows.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => onPick(f)}>
                  <span className="html-file-name">{f.name ?? f.id}</span>
                  <span className="muted">{f.public_url ? 'Public link on' : 'Turns on its public link'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
