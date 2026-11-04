import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { ViewIcon } from '../lib/lucide-icons';
import { useAddToMenu } from '../lib/use-add-to-menu';
import { useViewIconPicker } from './IconPicker';
import { confirmDialog } from './confirm';

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

const WRAP_KEY = 'pcrm.viewCodeWrap';

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === '1';
  } catch {
    return false;
  }
}

// Code with line numbers (left out when copying). Unwrapped, long lines scroll
// sideways and the numbers stay put; wrapped, a long line keeps one number.
function CodeBlock({ text, wrap }: { text: string; wrap: boolean }) {
  const lines = text.split('\n');
  return (
    <pre className={`view-code numbered${wrap ? ' wrap' : ''}`} style={{ ['--gutter' as string]: `${String(lines.length).length}ch` }}>
      {lines.map((line, i) => (
        <span key={i} className="code-line">
          <span className="ln" aria-hidden>{i + 1}</span>
          <span className="lc">{line || ' '}</span>
        </span>
      ))}
    </pre>
  );
}

// An integration as GET /v1/view-integrations returns it (url and status for admins only)
interface Integration {
  key: string;
  label: string;
  description: string | null;
  audience: 'admins' | 'everyone';
  url?: string;
  enabled?: boolean;
  last_called_at?: string | null;
  last_status?: number | null;
  last_error?: string | null;
}

// The integration keys a view's code sends to: callIntegration('key', ...)
// with a written-out key. dynamic counts calls whose key is built in code.
function integrationKeys(source: string | null): { keys: string[]; dynamic: number } {
  if (!source) return { keys: [], dynamic: 0 };
  const keys = new Set<string>();
  for (const m of source.matchAll(/callIntegration\s*(?:<[^>()]*>)?\s*\(\s*(['"`])([^'"`$\\]+)\1/g)) keys.add(m[2]);
  const calls = [...source.matchAll(/callIntegration\s*(?:<[^>()]*>)?\s*\(/g)].length;
  const literal = [...source.matchAll(/callIntegration\s*(?:<[^>()]*>)?\s*\(\s*(['"`])[^'"`$\\]+\1/g)].length;
  return { keys: [...keys].sort(), dynamic: Math.max(0, calls - literal) };
}

function ViewIntegrations({ source }: { source: string | null }) {
  const [all, setAll] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ results: Integration[] }>('GET', '/v1/view-integrations')
      .then((r) => live && setAll(r.results))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const { keys, dynamic } = integrationKeys(source);
  if (error) return <div className="error">{error}</div>;
  if (!all) return <p className="muted">Loading…</p>;
  if (keys.length === 0 && dynamic === 0) return <p className="muted">This view sends nothing to integrations.</p>;
  const byKey = new Map(all.map((i) => [i.key, i]));
  return (
    <div className="view-integrations">
      {keys.map((k) => {
        const i = byKey.get(k);
        if (!i) {
          return (
            <div key={k} className="view-integration">
              <div><strong>{k}</strong> <span className="pill danger">Not set up</span></div>
              <p className="small muted">The code calls this key, but no integration has it. Add one in <Link to="/settings/view-integrations">View integrations</Link>.</p>
            </div>
          );
        }
        return (
          <div key={k} className="view-integration">
            <div>
              <strong>{i.label}</strong> <span className="muted small">{i.key}</span>
              {i.enabled === false && <span className="pill">Off</span>}
            </div>
            {i.description && <p className="small">{i.description}</p>}
            <dl className="small">
              {i.url && <><dt>Sends to</dt><dd className="mono">{i.url}</dd></>}
              <dt>Who can use it</dt><dd>{i.audience === 'everyone' ? 'Everyone who can open the view' : 'Admins'}</dd>
              {i.url !== undefined && (
                <>
                  <dt>Last call</dt>
                  <dd>
                    {i.last_called_at ? new Date(i.last_called_at).toLocaleString() : 'Never'}
                    {i.last_status != null && <span className="muted"> · HTTP {i.last_status}</span>}
                    {i.last_error && <div className="error-text">{i.last_error}</div>}
                  </dd>
                </>
              )}
            </dl>
          </div>
        );
      })}
      {dynamic > 0 && <p className="small muted">{dynamic === 1 ? '1 call builds its key' : `${dynamic} calls build their key`} in code, so it is not listed here.</p>}
      <p className="small muted">Integrations are set up in <Link to="/settings/view-integrations">Settings, View integrations</Link>.</p>
    </div>
  );
}

// A custom view's record page: its React code and SQL queries (draft and
// published), with Open and Publish. Views are written by admins' AI through
// the MCP; this card is for reading and publishing.
export function ViewCode({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast, reloadCustomViews } = useApp();
  const [code, setCode] = useState<ViewCodeOut | null>(null);
  const [which, setWhich] = useState<'draft' | 'published'>('draft');
  const [tab, setTab] = useState<'code' | 'queries' | 'integrations'>('code');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wrap, setWrap] = useState(readWrap);
  const iconPicker = useViewIconPicker(record, onChanged);
  const icon = iconPicker.icon;
  const menu = useAddToMenu(code?.slug);

  useEffect(() => {
    let live = true;
    api<ViewCodeOut>('GET', `/v1/views/${record.id}/code`)
      .then((c) => live && setCode(c))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [record.id, record.properties.updated_at]);

  useEffect(() => {
    try {
      localStorage.setItem(WRAP_KEY, wrap ? '1' : '0');
    } catch {
      // per-viewer convenience only
    }
  }, [wrap]);

  async function publish() {
    if (!(await confirmDialog('Everyone who can open this view will see it.', { title: 'Publish the draft?', confirmLabel: 'Publish' }))) return;
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
        {menu && (
          menu.inMenu
            ? <Link className="btn small" to="/settings/navigation">In menu</Link>
            : <button className="btn small" disabled={menu.busy || code.status !== 'published'} title={code.status === 'published' ? undefined : 'Publish the view first'} onClick={menu.add}>Add to menu</button>
        )}
        {code.unpublished_changes && code.draft_source && <button className="btn small primary" disabled={busy} onClick={publish}>Publish</button>}
      </div>
      {(error || iconPicker.error || menu?.error) && <div className="error">{error ?? iconPicker.error ?? menu?.error}</div>}
      {iconPicker.picker}
      <div className="tabs">
        <div className={`tab${which === 'draft' ? ' active' : ''}`}><button onClick={() => setWhich('draft')}>Draft</button></div>
        <div className={`tab${which === 'published' ? ' active' : ''}`}><button onClick={() => setWhich('published')} disabled={!code.source}>Published</button></div>
        <span style={{ flex: 1 }} />
        {tab !== 'integrations' && (
          <label className="small muted code-wrap-toggle">
            <input type="checkbox" role="switch" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
          </label>
        )}
        <div className={`tab${tab === 'code' ? ' active' : ''}`}><button onClick={() => setTab('code')}>React</button></div>
        <div className={`tab${tab === 'queries' ? ' active' : ''}`}><button onClick={() => setTab('queries')}>Queries ({Object.keys(queries ?? {}).length})</button></div>
        <div className={`tab${tab === 'integrations' ? ' active' : ''}`}><button onClick={() => setTab('integrations')}>Integrations ({integrationKeys(source).keys.length})</button></div>
      </div>
      {tab === 'integrations' ? (
        <ViewIntegrations source={source} />
      ) : tab === 'code' ? (
        source ? <CodeBlock text={source} wrap={wrap} /> : <p className="muted">No code yet. Ask your AI to build this view through the CRM's MCP connection.</p>
      ) : Object.keys(queries ?? {}).length === 0 ? (
        <p className="muted">No queries.</p>
      ) : (
        Object.entries(queries).map(([name, q]) => (
          <div key={name} style={{ marginTop: 10 }}>
            <div className="small">
              <strong>{name}</strong>
              {Object.keys(q.params).length > 0 && <span className="muted"> ({Object.entries(q.params).map(([p, t]) => `${p}: ${t}`).join(', ')})</span>}
            </div>
            <CodeBlock text={q.sql} wrap={wrap} />
          </div>
        ))
      )}
    </div>
  );
}
