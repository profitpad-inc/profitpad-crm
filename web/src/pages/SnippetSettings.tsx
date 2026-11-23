import { useEffect, useState } from 'react';
import { Hash, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { clearSnippetCache } from '../lib/snippets';
import { confirmDialog } from '../components/confirm';
import { EditPanel, EmptyState, SettingsPage, StatusPill, TableSkeleton } from '../components/settings';

// Settings → Snippets: saved text pulled into any text box by typing # and
// the shortcut (api/src/snippets.ts). Snippets are shared with everyone unless
// their author turns that off; the author or an admin changes a shared one,
// and a personal one replaces a shared one with its shortcut for its author.
// Most recently used first, as the API sorts them.

interface Snippet {
  id: string;
  shortcut: string;
  name: string;
  body: string;
  shared: boolean;
  added_by: { id: string; name: string | null } | null;
  can_edit: boolean;
  can_share: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Draft {
  id: string | null;
  shortcut: string;
  name: string;
  body: string;
  shared: boolean;
  // whether this user decides who sees it (the author, or anyone for a new one)
  canShare: boolean;
}

const shortcutFrom = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function SnippetSettings() {
  const { me, toast } = useApp();
  const [list, setList] = useState<Snippet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [shortcutTouched, setShortcutTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // a bare API key has no user to own a snippet; only admins add them then
  const canAdd = !!me.user || me.is_admin;

  const load = () => api<{ results: Snippet[] }>('GET', '/v1/snippets')
    .then((r) => { setList(r.results); setError(null); })
    .catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  function start(d: Draft) {
    setDraft(d);
    setShortcutTouched(!!d.id);
    setError(null);
  }

  async function save(d: Draft) {
    setBusy(true);
    setError(null);
    try {
      const body = { shortcut: d.shortcut, name: d.name, body: d.body, ...(d.canShare ? { shared: d.shared } : {}) };
      if (d.id) await api('PATCH', `/v1/snippets/${d.id}`, body);
      else await api('POST', '/v1/snippets', body);
      clearSnippetCache();
      setDraft(null);
      toast(d.id ? 'Snippet saved' : 'Snippet added');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: Snippet) {
    if (!(await confirmDialog(`Typing #${s.shortcut} will no longer offer it${s.shared ? ' to anyone' : ''}.`, { title: `Delete "${s.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api('DELETE', `/v1/snippets/${s.id}`);
      clearSnippetCache();
      toast('Snippet deleted');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const d = draft;
  const mineShortcuts = new Set(list?.filter((s) => !s.shared).map((s) => s.shortcut));

  const table = (rows: Snippet[]) => (
    <div className="access-table">
      <table className="grid">
        <thead>
          <tr><th>Shortcut</th><th>Name and text</th><th>Added by</th><th>Last used</th><th>Updated</th><th>Created</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td><code>#{s.shortcut}</code></td>
              <td className="primary-cell wrap">
                {s.name}
                {!s.shared && <> <StatusPill tone="off">Only you</StatusPill></>}
                {s.shared && mineShortcuts.has(s.shortcut) && <> <StatusPill tone="off">Replaced by yours</StatusPill></>}
                <span className="sub">{oneLine(s.body).slice(0, 160)}{oneLine(s.body).length > 160 ? '…' : ''}</span>
              </td>
              <td className="muted">{!s.added_by ? 'An admin' : s.added_by.id === me.user?.id ? 'You' : s.added_by.name ?? 'Unknown user'}</td>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{s.last_used_at ? when(s.last_used_at) : 'Never'}</td>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{when(s.updated_at)}</td>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{when(s.created_at)}</td>
              <td className="row-actions">
                {s.can_edit && (
                  <span className="row-actions-inner">
                    <button className="btn small ghost" onClick={() => start({ id: s.id, shortcut: s.shortcut, name: s.name, body: s.body, shared: s.shared, canShare: s.can_share })}>Edit</button>
                    <button className="btn small ghost danger-text" onClick={() => remove(s)}>Delete</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // shared with everyone unless turned off; an API key with no user cannot keep one for itself
  const newDraft = (): Draft => ({ id: null, shortcut: '', name: '', body: '', shared: true, canShare: !!me.user });

  return (
    <SettingsPage
      className="wide"
      title="Snippets"
      description={<>
        Saved text you can drop into any text box (notes, call notes, emails, long text properties and custom views that allow it) by typing{' '}
        <code>#</code> and the shortcut, then picking it from the menu. Merge fields fill in when the snippet goes in:{' '}
        <code>{'{{r.first_name|there}}'}</code> is the first name of the record you are on, or "there" when it has none, and{' '}
        <code>{'{{me.first_name}}'}</code> is yours. Any property's API name works after <code>r.</code> or <code>me.</code>.
        {' '}Snippets are shared with everyone unless you turn that off to keep one for yourself. The person who added a shared snippet, or an admin, can change it.
      </>}
      actions={!d && canAdd && <button className="btn primary" onClick={() => start(newDraft())}><Plus size={14} /> New snippet</button>}
    >
      {error && <div className="error">{error}</div>}
      {d && (
        <EditPanel
          title={d.id ? `Edit #${d.shortcut}` : 'New snippet'}
          onSubmit={() => save(d)}
          footer={<>
            <button className="btn" type="button" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn primary" type="submit" disabled={busy || !d.name.trim() || !d.shortcut || !d.body.trim()}>{d.id ? 'Save' : 'Add snippet'}</button>
          </>}
        >
          <div className="field-row">
            <label>Name
              <input value={d.name} required maxLength={100} placeholder="Welcome email"
                onChange={(e) => setDraft({ ...d, name: e.target.value, shortcut: shortcutTouched ? d.shortcut : shortcutFrom(e.target.value) })} />
            </label>
            <label>Shortcut (typed after #)
              <input value={d.shortcut} required maxLength={40} pattern="[a-z0-9][a-z0-9_\-]{0,39}" placeholder="welcome_email"
                title="Lowercase letters, digits, _ and -"
                onChange={(e) => { setShortcutTouched(true); setDraft({ ...d, shortcut: e.target.value.toLowerCase().replace(/^#/, '') }); }} />
            </label>
            {d.canShare && (
              <label className="check" title="Off: only you see this snippet">
                <input type="checkbox" checked={d.shared} onChange={(e) => setDraft({ ...d, shared: e.target.checked })} /> Shared with everyone
              </label>
            )}
          </div>
          <label>Text
            <textarea value={d.body} rows={8} maxLength={20000} required
              placeholder={'Hi {{r.first_name|there}},\n\nWelcome to ProfitPad!\n\nCheers,\n\n{{me.first_name}}'}
              onChange={(e) => setDraft({ ...d, body: e.target.value })} />
          </label>
        </EditPanel>
      )}
      {!list && !error && <TableSkeleton rows={3} />}
      {list && list.length === 0 && !d && (
        <EmptyState icon={<Hash size={18} />} title="No snippets yet" action={canAdd ? <button className="btn primary" onClick={() => start(newDraft())}>New snippet</button> : undefined}>
          Add text you type often, like a quick reply (#omw for "On my way!") or a whole welcome email.
        </EmptyState>
      )}
      {list && list.length > 0 && table(list)}
    </SettingsPage>
  );
}
