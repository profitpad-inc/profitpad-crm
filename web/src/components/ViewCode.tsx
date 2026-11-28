import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { ViewIcon } from '../lib/lucide-icons';
import { useAddToMenu } from '../lib/use-add-to-menu';
import { useViewIconPicker } from './IconPicker';
import { confirmDialog } from './confirm';
import { Loading } from './Loading';
import { McpNotice } from './McpNotice';
import { CodeBlock } from './CodeBlock';
import { CodeTextarea } from './CodeTextarea';
import { useFillColumn } from '../lib/use-fill-column';

interface ViewCodeOut {
  id: string;
  slug: string;
  status: 'draft' | 'published';
  unpublished_changes: boolean;
  published_at: string | null;
  draft_source: string | null;
  draft_queries: Queries;
  source: string | null;
  queries: Queries;
}

const WRAP_KEY = 'pcrm.viewCodeWrap';

function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === '1';
  } catch {
    return false;
  }
}

type Queries = Record<string, { sql: string; params: Record<string, string> }>;

// A query while it is being edited: params as "since: date, owner: text"
interface QueryDraft {
  key: number;
  name: string;
  params: string;
  sql: string;
}

const PARAM_TYPES = ['text', 'number', 'date', 'datetime', 'boolean'];
let nextKey = 1;

function toDrafts(queries: Queries | null | undefined): QueryDraft[] {
  return Object.entries(queries ?? {}).map(([name, q]) => ({
    key: nextKey++,
    name,
    params: Object.entries(q.params).map(([p, t]) => `${p}: ${t}`).join(', '),
    sql: q.sql
  }));
}

const sameDrafts = (a: QueryDraft[], b: QueryDraft[]) =>
  a.length === b.length && a.every((q, i) => q.name === b[i].name && q.params === b[i].params && q.sql === b[i].sql);

// The edited queries as the API takes them, or what is wrong with them.
// The server checks the rest (names, types, params the SQL uses).
function fromDrafts(list: QueryDraft[]): { queries: Queries } | { error: string } {
  const queries: Queries = {};
  for (const q of list) {
    const name = q.name.trim();
    if (!name) return { error: 'Every query needs a name.' };
    if (queries[name]) return { error: `Two queries are named "${name}".` };
    const params: Record<string, string> = {};
    for (const part of q.params.split(',').map((x) => x.trim()).filter(Boolean)) {
      const m = part.match(/^([^:\s]+)\s*:\s*(\S+)$/);
      if (!m) return { error: `Query "${name}": write params as "name: type", like "since: date". Types: ${PARAM_TYPES.join(', ')}.` };
      params[m[1]] = m[2];
    }
    queries[name] = { sql: q.sql, params };
  }
  return { queries };
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
  if (!all) return <Loading className="muted" />;
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
      <p className="small muted">Integrations are set up in <Link to="/settings/view-integrations">Settings &gt; View integrations</Link>.</p>
    </div>
  );
}

// A custom view's record page: its React code and SQL queries (draft and
// published), with Open and Publish. Views are usually written by admins' AI
// through the MCP; Edit on the draft lets an admin type in the React code and
// the queries by hand, and saving returns to the read-only view.
export function ViewCode({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast, reloadCustomViews } = useApp();
  const [code, setCode] = useState<ViewCodeOut | null>(null);
  const [which, setWhich] = useState<'draft' | 'published'>('draft');
  const [tab, setTab] = useState<'code' | 'queries' | 'integrations'>('code');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wrap, setWrap] = useState(readWrap);
  const [editing, setEditing] = useState(false);
  const [draftSource, setDraftSource] = useState('');
  const [draftQueries, setDraftQueries] = useState<QueryDraft[]>([]);
  const [savedQueries, setSavedQueries] = useState<QueryDraft[]>([]);
  const iconPicker = useViewIconPicker(record, onChanged);
  const icon = iconPicker.icon;
  const menu = useAddToMenu(code?.slug);
  // the React code runs down to the bottom of the record's middle column, like a landing page's HTML
  const { ref: bodyRef, height: bodyHeight } = useFillColumn<HTMLDivElement>([code, error, tab, which, editing]);

  const load = (c: ViewCodeOut) => {
    setCode(c);
    setDraftSource(c.draft_source ?? '');
    const q = toDrafts(c.draft_queries);
    setDraftQueries(q);
    setSavedQueries(q);
  };

  useEffect(() => {
    let live = true;
    api<ViewCodeOut>('GET', `/v1/views/${record.id}/code`)
      .then((c) => live && load(c))
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
      load(await api<ViewCodeOut>('POST', `/v1/views/${record.id}/publish`));
      onChanged(await api<CrmRecord>('GET', `/v1/objects/views/${record.id}`));
      reloadCustomViews().catch(() => undefined);
      toast('Published');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const parsed = fromDrafts(draftQueries);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      load(await api<ViewCodeOut>('PUT', `/v1/views/${record.id}/draft`, { source: draftSource, queries: parsed.queries }));
      onChanged(await api<CrmRecord>('GET', `/v1/objects/views/${record.id}`));
      setEditing(false);
      toast('Draft saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    if (!code) return;
    setDraftSource(code.draft_source ?? '');
    setDraftQueries(savedQueries);
    setError(null);
    setEditing(false);
  }

  const setQuery = (key: number, patch: Partial<QueryDraft>) =>
    setDraftQueries((list) => list.map((q) => (q.key === key ? { ...q, ...patch } : q)));

  if (error && !code) return <div className="card"><div className="error">{error}</div></div>;
  if (!code) return <div className="card muted"><Loading /></div>;
  const source = which === 'draft' ? code.draft_source : code.source;
  const queries = which === 'draft' ? code.draft_queries : code.queries;
  const dirty = draftSource !== (code.draft_source ?? '') || !sameDrafts(draftQueries, savedQueries);
  // typing in the draft: Edit was pressed, or there are unsaved changes
  const typing = which === 'draft' && tab !== 'integrations' && (editing || dirty);
  return (
    <div className="card view-code-card">
      <div className="card-head">
        <div className="view-code-title">
          <h3>Code</h3>
          <span className="muted small">
            {code.status === 'published' ? (code.unpublished_changes ? 'Published, draft has changes' : 'Published') : 'Draft, not published yet'}
          </span>
        </div>
        <div className="view-code-actions">
          <button className="btn small" onClick={iconPicker.open} title={icon ? `Icon: ${icon}` : 'Default icon'}>
            <ViewIcon icon={icon} size={14} /> Icon
          </button>
          <Link className="btn small" to={{ pathname: '/view/', search: '?draft=1', hash: `#${code.slug}` }}>Open draft <ExternalLink size={12} /></Link>
          {code.status === 'published' && <Link className="btn small" to={{ pathname: '/view/', hash: `#${code.slug}` }}>Open <ExternalLink size={12} /></Link>}
          {menu && <Link className="btn small" to="/settings/navigation">{menu.inMenu ? 'In menu' : 'Add to menu'}</Link>}
          {code.unpublished_changes && code.draft_source && (
            <button className="btn small primary" disabled={busy || dirty} title={dirty ? 'Save the draft first' : undefined} onClick={publish}>Publish</button>
          )}
        </div>
      </div>
      <McpNotice kind="views" />
      {(error || iconPicker.error) && <div className="error">{error ?? iconPicker.error}</div>}
      {iconPicker.picker}
      {/* one row on wide screens; on phones the version and the part are two rows */}
      <div className="view-code-tabs">
        <div className="tabs">
          <div className={`tab${which === 'draft' ? ' active' : ''}`}><button onClick={() => setWhich('draft')}>Draft</button></div>
          <div className={`tab${which === 'published' ? ' active' : ''}`}><button onClick={() => setWhich('published')} disabled={!code.source}>Published</button></div>
          {tab !== 'integrations' && !typing && (
            <label className="small muted code-wrap-toggle">
              <input type="checkbox" role="switch" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
            </label>
          )}
          {which === 'draft' && tab !== 'integrations' && !typing && (
            <button className="btn small view-code-edit" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>
          )}
        </div>
        <div className="tabs">
          <div className={`tab${tab === 'code' ? ' active' : ''}`}><button onClick={() => setTab('code')}>React</button></div>
          <div className={`tab${tab === 'queries' ? ' active' : ''}`}><button onClick={() => setTab('queries')}>Queries ({which === 'draft' ? draftQueries.length : Object.keys(queries ?? {}).length})</button></div>
          <div className={`tab${tab === 'integrations' ? ' active' : ''}`}><button onClick={() => setTab('integrations')}>Integrations ({integrationKeys(which === 'draft' ? draftSource : source).keys.length})</button></div>
        </div>
      </div>
      {tab === 'integrations' ? (
        <ViewIntegrations source={which === 'draft' ? draftSource : source} />
      ) : typing ? (
        <>
          {tab === 'code' ? (
            <div ref={bodyRef} className="landing-body code-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
              <CodeTextarea value={draftSource} autoFocus aria-label="React code"
                placeholder="export default function View() { ... }"
                onChange={(e) => setDraftSource(e.target.value)} />
            </div>
          ) : (
            <div className="view-query-editors">
              {draftQueries.length === 0 && <p className="muted">No queries.</p>}
              {draftQueries.map((q) => (
                <div key={q.key} className="view-query-editor">
                  <div className="view-query-fields">
                    <label className="field">
                      <span>Name</span>
                      <input value={q.name} placeholder="deals_by_week" onChange={(e) => setQuery(q.key, { name: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Params</span>
                      <input value={q.params} placeholder="since: date, owner: text" onChange={(e) => setQuery(q.key, { params: e.target.value })} />
                    </label>
                    <button className="btn small ghost danger-text" title="Remove this query" aria-label={`Remove query ${q.name || 'without a name'}`}
                      onClick={async () => {
                        if (q.sql.trim() && !(await confirmDialog(`Remove the query "${q.name || 'without a name'}" from the draft?`, { title: 'Remove the query?', confirmLabel: 'Remove', danger: true }))) return;
                        setDraftQueries((list) => list.filter((x) => x.key !== q.key));
                      }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <CodeTextarea value={q.sql} rows={Math.min(24, Math.max(6, q.sql.split('\n').length + 1))} aria-label={`SQL for ${q.name || 'the query'}`}
                    placeholder="select ... from reporting.deals where close_date >= :since"
                    onChange={(e) => setQuery(q.key, { sql: e.target.value })} />
                </div>
              ))}
              <div>
                <button className="btn small" onClick={() => setDraftQueries((list) => [...list, { key: nextKey++, name: '', params: '', sql: '' }])}>
                  <Plus size={13} /> Add query
                </button>
              </div>
            </div>
          )}
          <div className="template-actions">
            <span className="muted small">{tab === 'code' ? 'Folding comes back after you save.' : `Param types: ${PARAM_TYPES.join(', ')}. :me is built in.`}</span>
            <span style={{ flex: 1 }} />
            {dirty
              ? <button className="btn small ghost" disabled={busy} onClick={discard}>Discard</button>
              : <button className="btn small ghost" onClick={() => setEditing(false)}>Done</button>}
            <button className="btn small primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving...' : 'Save draft'}</button>
          </div>
        </>
      ) : tab === 'code' ? (
        source ? (
          <div ref={bodyRef} className="landing-body code-body" style={bodyHeight ? { height: bodyHeight } : undefined}>
            <CodeBlock text={source} wrap={wrap} lang="js" />
          </div>
        ) : <p className="muted">No code yet. Ask your AI to build this view through the CRM's MCP connection{which === 'draft' && ', or press Edit to write it'}.</p>
      ) : Object.keys(queries ?? {}).length === 0 ? (
        <p className="muted">No queries.{which === 'draft' && ' Press Edit to add one.'}</p>
      ) : (
        Object.entries(queries).map(([name, q]) => (
          <div key={name} style={{ marginTop: 10 }}>
            <div className="small">
              <strong>{name}</strong>
              {Object.keys(q.params).length > 0 && <span className="muted"> ({Object.entries(q.params).map(([p, t]) => `${p}: ${t}`).join(', ')})</span>}
            </div>
            <CodeBlock text={q.sql} wrap={wrap} lang="sql" />
          </div>
        ))
      )}
    </div>
  );
}
