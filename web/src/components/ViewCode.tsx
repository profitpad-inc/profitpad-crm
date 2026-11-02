import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { ViewIcon } from '../lib/lucide-icons';
import { useViewIconPicker } from './IconPicker';

interface ViewCodeOut {
  id: string;
  slug: string;
  status: 'draft' | 'published';
  unpublished_changes: boolean;
  published_at: string | null;
  draft_source: string | null;
  draft_queries: Record<string, { sql: string; params: Record<string, string> }>;
  source: string | null;
  queries: Record<string, { sql: string; params: Record<string, string> }>;
}

// A custom view's record page: its React code and SQL queries (draft and
// published), with Open and Publish. Views are written by admins' AI through
// the MCP; this card is for reading and publishing.
export function ViewCode({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast, reloadCustomViews } = useApp();
  const [code, setCode] = useState<ViewCodeOut | null>(null);
  const [which, setWhich] = useState<'draft' | 'published'>('draft');
  const [tab, setTab] = useState<'code' | 'queries'>('code');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const iconPicker = useViewIconPicker(record, onChanged);
  const icon = iconPicker.icon;

  useEffect(() => {
    let live = true;
    api<ViewCodeOut>('GET', `/v1/views/${record.id}/code`)
      .then((c) => live && setCode(c))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [record.id, record.properties.updated_at]);

  async function publish() {
    if (!confirm('Publish the draft? Everyone who can open this view will see it.')) return;
    setBusy(true);
    setError(null);
    try {
      setCode(await api<ViewCodeOut>('POST', `/v1/views/${record.id}/publish`));
      onChanged(await api<CrmRecord>('GET', `/v1/objects/views/${record.id}`));
      reloadCustomViews().catch(() => undefined);
      toast('Published');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !code) return <div className="card"><div className="error">{error}</div></div>;
  if (!code) return <div className="card muted">Loading…</div>;
  const source = which === 'draft' ? code.draft_source : code.source;
  const queries = which === 'draft' ? code.draft_queries : code.queries;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Code</h3>
        <span className="muted small">
          {code.status === 'published' ? (code.unpublished_changes ? 'Published, draft has changes' : 'Published') : 'Draft, not published yet'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={iconPicker.open} title={icon ? `Icon: ${icon}` : 'Default icon'}>
          <ViewIcon icon={icon} size={14} /> Icon
        </button>
        <Link className="btn small" to={{ pathname: '/view/', search: '?draft=1', hash: `#${code.slug}` }}>Open draft <ExternalLink size={12} /></Link>
        {code.status === 'published' && <Link className="btn small" to={{ pathname: '/view/', hash: `#${code.slug}` }}>Open <ExternalLink size={12} /></Link>}
        {code.unpublished_changes && code.draft_source && <button className="btn small primary" disabled={busy} onClick={publish}>Publish</button>}
      </div>
      {(error || iconPicker.error) && <div className="error">{error ?? iconPicker.error}</div>}
      {iconPicker.picker}
      <div className="tabs">
        <div className={`tab${which === 'draft' ? ' active' : ''}`}><button onClick={() => setWhich('draft')}>Draft</button></div>
        <div className={`tab${which === 'published' ? ' active' : ''}`}><button onClick={() => setWhich('published')} disabled={!code.source}>Published</button></div>
        <span style={{ flex: 1 }} />
        <div className={`tab${tab === 'code' ? ' active' : ''}`}><button onClick={() => setTab('code')}>React</button></div>
        <div className={`tab${tab === 'queries' ? ' active' : ''}`}><button onClick={() => setTab('queries')}>Queries ({Object.keys(queries ?? {}).length})</button></div>
      </div>
      {tab === 'code' ? (
        source ? <pre className="view-code">{source}</pre> : <p className="muted">No code yet. Ask your AI to build this view through the CRM's MCP connection.</p>
      ) : Object.keys(queries ?? {}).length === 0 ? (
        <p className="muted">No queries.</p>
      ) : (
        Object.entries(queries).map(([name, q]) => (
          <div key={name} style={{ marginTop: 10 }}>
            <div className="small">
              <strong>{name}</strong>
              {Object.keys(q.params).length > 0 && <span className="muted"> ({Object.entries(q.params).map(([p, t]) => `${p}: ${t}`).join(', ')})</span>}
            </div>
            <pre className="view-code">{q.sql}</pre>
          </div>
        ))
      )}
    </div>
  );
}
