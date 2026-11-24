import { useEffect, useState } from 'react';
import { BookOpen, History, Plus, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useUrlSearch } from '../lib/use-url-search';
import { confirmDialog } from '../components/confirm';
import { SaveHint } from '../components/SaveHint';
import { useDirty } from '../lib/use-dirty';
import { Modal } from '../components/ui';
import { ShowMore } from '../components/ShowMore';
import { Markdown } from '../components/Markdown';
import { EditPanel, EmptyState, SettingsPage, StatusPill, TableSkeleton } from '../components/settings';

// Settings → Knowledge base (api/src/knowledge.ts): articles the business
// writes about itself (ICP, revenue, sales team...) that AI agents connected
// over MCP read with get_knowledge and can update. Roles say who reads and
// who edits (Settings → Roles, Knowledge base); admins-only articles stay
// with Super Admins. Each save is kept, and History restores an earlier version.

interface Article {
  id: string;
  title: string;
  body: string;
  admins_only: boolean;
  updated_at: string;
  updated_by: string;
  updated_via: 'ui' | 'mcp' | 'api';
}

interface Revision {
  id: string;
  title: string;
  body: string;
  admins_only: boolean;
  saved_at: string;
  saved_by: string;
  saved_via: 'ui' | 'mcp' | 'api';
}

interface Draft { id: string | null; title: string; body: string; admins_only: boolean }

// Starting points, each a title and an outline to fill in.
const TOPICS: { title: string; body: string; admins_only?: boolean }[] = [
  { title: 'Company overview', body: 'What we do:\nWho we serve:\nFounded:\nHeadquarters:\nWebsite:\nWhat makes us different:' },
  {
    title: 'Ideal customer profile',
    body: 'Industries:\nCompany size (employees, revenue):\nRegions:\nJob titles we sell to (decision makers, champions):\nPains we solve:\nSigns a company is a good fit:\nSigns a company is not a fit:'
  },
  {
    title: 'Revenue and goals',
    body: 'Current revenue (as of <month year>):\nAverage deal size:\nAverage sales cycle:\nThis year\'s target:\nQuarterly targets:',
    admins_only: true
  },
  {
    title: 'Sales team',
    body: 'Number of sales reps:\nRoles (SDRs, AEs, account managers):\nTerritories or segments each covers:\nTeam demographics (experience, background, locations, languages):\nQuota per rep:'
  },
  { title: 'Products and pricing', body: 'Products and services:\nPricing and packages:\nDiscounts allowed, and who approves them:' },
  { title: 'Competitors', body: 'Main competitors:\nHow we win against each:\nWhere they beat us:' },
  { title: 'Sales process', body: 'Pipeline stages, and what moves a deal to the next one:\nHow we qualify a lead:\nCommon objections, and how we answer them:' },
  { title: 'Messaging and tone', body: 'Our value propositions:\nTone of voice:\nWords we use:\nWords we avoid:' }
];

const VIA: Record<Article['updated_via'], string> = { ui: 'in the CRM', mcp: 'by AI (MCP)', api: 'through the API' };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function KnowledgeSettings() {
  const { toast } = useApp();
  const [list, setList] = useState<Article[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [canAdminsOnly, setCanAdminsOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Article | null>(null);
  const [query, setQuery, settled] = useUrlSearch();

  const load = () => api<{ results: Article[]; can_edit: boolean; can_set_admins_only: boolean }>('GET', '/v1/knowledge')
    .then((r) => { setList(r.results); setCanEdit(r.can_edit); setCanAdminsOnly(r.can_set_admins_only); setError(null); })
    .catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  function start(d: Draft) {
    setDraft(d);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function save(d: Draft) {
    setBusy(true);
    setError(null);
    try {
      const body = { title: d.title, body: d.body, admins_only: d.admins_only };
      if (d.id) await api('PATCH', `/v1/knowledge/${d.id}`, body);
      else await api('POST', '/v1/knowledge', body);
      setDraft(null);
      toast(d.id ? 'Article saved' : 'Article added');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Article) {
    if (!(await confirmDialog('The article and all its saved versions are deleted for good, and AI agents will no longer see it.', { title: `Delete "${a.title}"?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api('DELETE', `/v1/knowledge/${a.id}`);
      toast('Article deleted');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const words = settled.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (list ?? []).filter((a) => { const t = `${a.title}\n${a.body}`.toLowerCase(); return words.every((w) => t.includes(w)); });
  const taken = new Set((list ?? []).map((a) => a.title.toLowerCase()));
  const suggestions = TOPICS.filter((t) => !taken.has(t.title.toLowerCase()));
  const blank = (): Draft => ({ id: null, title: '', body: '', admins_only: false });
  const fromTopic = (t: typeof TOPICS[number]): Draft => ({ id: null, title: t.title, body: t.body, admins_only: !!t.admins_only && canAdminsOnly });
  const d = draft;
  const { dirty } = useDirty(d, d ? d.id ?? 'new' : null);

  return (
    <SettingsPage
      className="wide knowledge"
      title="Knowledge base"
      description={<>
        What your business knows about itself: who you sell to, your numbers, your team, how you sell. AI agents connected to the CRM
        (Settings, Connected apps) read it for context, and the agent of someone who may edit it can add to it and keep it current when
        you tell it something new. Roles decide who reads it and who edits it.
        {canEdit ? ' Every save is kept, so you can see and undo what changed.' : ' Your team keeps it up to date.'}
      </>}
      actions={canEdit && !d && <button className="btn primary" onClick={() => start(blank())}><Plus size={14} /> New article</button>}
    >
      {error && <div className="error">{error}</div>}

      {d && (
        <EditPanel
          title={d.id ? `Edit "${d.title || 'article'}"` : 'New article'}
          onSubmit={() => save(d)}
          footer={<>
            <SaveHint missing={[!d.title.trim() && 'a title']} />
            <button className="btn" type="button" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn primary" type="submit" disabled={busy || !d.title.trim() || (!!d.id && !dirty)}>{d.id ? 'Save' : 'Add article'}</button>
          </>}
        >
          <div className="field-row">
            <label>Title
              <input value={d.title} required maxLength={120} placeholder="Ideal customer profile" autoFocus={!d.id && !d.title}
                onChange={(e) => setDraft({ ...d, title: e.target.value })} />
            </label>
            {canAdminsOnly && <label className="check" title="For figures like revenue that not everyone should see. AI agents of non-admins will not see it either.">
              <input type="checkbox" checked={d.admins_only} onChange={(e) => setDraft({ ...d, admins_only: e.target.checked })} /> Admins only
            </label>}
          </div>
          <label>Text
            <textarea value={d.body} rows={14} maxLength={50000}
              placeholder="Write it the way you would explain it to a new hire. Date figures that change, e.g. Revenue (Nov 2026): $2.4M ARR."
              onChange={(e) => setDraft({ ...d, body: e.target.value })} />
          </label>
        </EditPanel>
      )}

      {!list && !error && <TableSkeleton rows={3} />}

      {list && list.length === 0 && !d && (
        <EmptyState icon={<BookOpen size={18} />} title="Nothing written down yet"
          action={canEdit ? <button className="btn primary" onClick={() => start(fromTopic(TOPICS[1]))}>Start with your ideal customer profile</button> : undefined}>
          {canEdit
            ? 'Pick a topic below to start from an outline, or write your own.'
            : 'Nobody has added anything to the knowledge base yet.'}
        </EmptyState>
      )}

      {canEdit && !d && suggestions.length > 0 && list && (
        <div className="knowledge-topics">
          <span className="muted small"><Sparkles size={13} /> {list.length ? 'More topics to cover:' : 'Topics:'}</span>
          {suggestions.map((t) => (
            <button key={t.title} className="btn small" onClick={() => start(fromTopic(t))}><Plus size={12} /> {t.title}</button>
          ))}
        </div>
      )}

      {list && list.length > 1 && (
        <div className="settings-toolbar">
          <input type="search" placeholder="Search the knowledge base" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the knowledge base" />
          <span className="muted small">{shown.length} {shown.length === 1 ? 'article' : 'articles'}</span>
        </div>
      )}

      {list && list.length > 0 && shown.length === 0 && (
        <EmptyState compact icon={<BookOpen size={16} />} title="No matching articles">Try other words.</EmptyState>
      )}

      <div className="knowledge-list">
        {shown.map((a) => (
          <article key={a.id} className="card knowledge-card">
            <div className="card-head">
              <h3>{a.title}</h3>
              {a.admins_only && <StatusPill tone="info">Admins only</StatusPill>}
              {canEdit && (
                <span className="row-actions-inner push-right">
                  <button className="btn small ghost" onClick={() => start({ id: a.id, title: a.title, body: a.body, admins_only: a.admins_only })}>Edit</button>
                  <button className="btn small ghost" onClick={() => setHistory(a)}><History size={13} /> History</button>
                  <button className="btn small ghost danger-text" onClick={() => remove(a)}>Delete</button>
                </span>
              )}
            </div>
            {a.body.trim()
              ? <ShowMore as="div" lines={10} className="knowledge-body"><Markdown>{a.body}</Markdown></ShowMore>
              : <p className="muted small">No text yet.</p>}
            <div className="sub knowledge-meta">
              Updated {when(a.updated_at)} by {a.updated_by} {VIA[a.updated_via]}
            </div>
          </article>
        ))}
      </div>

      {history && (
        <HistoryModal article={history} canAdminsOnly={canAdminsOnly} onClose={() => setHistory(null)}
          onRestored={async () => { setHistory(null); toast('Version restored'); await load(); }} />
      )}
    </SettingsPage>
  );
}

function HistoryModal({ article, canAdminsOnly, onClose, onRestored }: { article: Article; canAdminsOnly: boolean; onClose: () => void; onRestored: () => void }) {
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ results: Revision[] }>('GET', `/v1/knowledge/${article.id}/revisions`)
      .then((r) => { setRevs(r.results); setPick(r.results[0]?.id ?? null); })
      .catch((e: Error) => setError(e.message));
  }, [article.id]);

  const current = revs?.[0]?.id;
  const sel = revs?.find((r) => r.id === pick) ?? null;

  async function restore(r: Revision) {
    if (!(await confirmDialog(`"${article.title}" goes back to this version from ${when(r.saved_at)}. The version it replaces stays in the history.`, { title: 'Restore this version?', confirmLabel: 'Restore' }))) return;
    setBusy(true);
    try {
      await api('PATCH', `/v1/knowledge/${article.id}`, { title: r.title, body: r.body, ...(canAdminsOnly ? { admins_only: r.admins_only } : {}) });
      onRestored();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`History of "${article.title}"`} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        {sel && sel.id !== current && <button className="btn primary" disabled={busy} onClick={() => restore(sel)}>Restore this version</button>}
      </>}>
      {error && <div className="error">{error}</div>}
      {!revs && !error && <TableSkeleton rows={4} />}
      {revs && (
        <div className="knowledge-history">
          <ul className="knowledge-history-list">
            {revs.map((r) => (
              <li key={r.id}>
                <button className={r.id === pick ? 'active' : ''} onClick={() => setPick(r.id)}>
                  <span>{when(r.saved_at)}{r.id === current && <> <StatusPill tone="on">Current</StatusPill></>}</span>
                  <span className="sub">{r.saved_by} {VIA[r.saved_via]}</span>
                </button>
              </li>
            ))}
          </ul>
          {sel && (
            <div className="knowledge-history-view">
              <h3>{sel.title}{sel.admins_only && <> <StatusPill tone="info">Admins only</StatusPill></>}</h3>
              <div className="knowledge-body">{sel.body.trim() ? <Markdown>{sel.body}</Markdown> : <span className="muted">No text.</span>}</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
