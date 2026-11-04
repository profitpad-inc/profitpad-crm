import { useEffect, useState } from 'react';
import { Hash, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { clearSnippetCache } from '../lib/snippets';
import { confirmDialog } from '../components/confirm';
import { EditPanel, EmptyState, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';

// Settings → Snippets: saved text pulled into any text box by typing # and
// the shortcut (api/src/snippets.ts). Everyone keeps their own; admins keep
// the shared ones. A personal snippet wins over a shared one with its shortcut.

interface Snippet {
  id: string;
  shortcut: string;
  name: string;
  body: string;
  shared: boolean;
  can_edit: boolean;
  updated_at: string;
}

interface Draft {
  id: string | null;
  shortcut: string;
  name: string;
  body: string;
  shared: boolean;
}

const shortcutFrom = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function SnippetSettings() {
  const { me, toast } = useApp();
  const [list, setList] = useState<Snippet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [shortcutTouched, setShortcutTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // a bare API key has no user, so only shared snippets
  const canOwn = !!me.user;

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
      const body = { shortcut: d.shortcut, name: d.name, body: d.body };
      if (d.id) await api('PATCH', `/v1/snippets/${d.id}`, body);
      else await api('POST', '/v1/snippets', { ...body, shared: d.shared });
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

  const mine = list?.filter((s) => !s.shared) ?? [];
  const shared = list?.filter((s) => s.shared) ?? [];
  const overridden = new Set(mine.map((s) => s.shortcut));
  const d = draft;

  const table = (rows: Snippet[]) => (
    <div className="access-table">
      <table className="grid">
        <thead>
          <tr><th>Shortcut</th><th>Name and text</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td><code>#{s.shortcut}</code></td>
              <td className="primary-cell wrap">
                {s.name} {s.shared && overridden.has(s.shortcut) && <StatusPill tone="off">Replaced by yours</StatusPill>}
                <span className="sub">{oneLine(s.body).slice(0, 160)}{oneLine(s.body).length > 160 ? '…' : ''}</span>
              </td>
              <td className="row-actions">
                {s.can_edit && (
                  <span className="row-actions-inner">
                    <button className="btn small ghost" onClick={() => start({ id: s.id, shortcut: s.shortcut, name: s.name, body: s.body, shared: s.shared })}>Edit</button>
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

  const newDraft = (): Draft => ({ id: null, shortcut: '', name: '', body: '', shared: !canOwn });

  return (
    <SettingsPage
      className="wide"
      title="Snippets"
      description={<>
        Saved text you can drop into any text box (notes, call notes, emails, long text properties and custom views that allow it) by typing{' '}
        <code>#</code> and the shortcut, then picking it from the menu. Merge fields fill in when the snippet goes in:{' '}
        <code>{'{{r.first_name|there}}'}</code> is the first name of the record you are on, or "there" when it has none, and{' '}
        <code>{'{{me.first_name}}'}</code> is yours. Any property's API name works after <code>r.</code> or <code>me.</code>.
      </>}
      actions={!d && <button className="btn primary" onClick={() => start(newDraft())}><Plus size={14} /> New snippet</button>}
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
            {!d.id && me.is_admin && canOwn && (
              <label className="check" title="Shared snippets are offered to everyone; only admins change them">
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
        <EmptyState icon={<Hash size={18} />} title="No snippets yet" action={<button className="btn primary" onClick={() => start(newDraft())}>New snippet</button>}>
          Add text you type often, like a product name (#hss for HubSpot) or a whole welcome email.
        </EmptyState>
      )}
      {list && list.length > 0 && (
        <>
          {canOwn && (
            <SettingsSection title="Your snippets" description="Only you see these. One with the same shortcut as a shared snippet replaces it for you.">
              {mine.length ? table(mine) : <p className="muted small">None yet.</p>}
            </SettingsSection>
          )}
          <SettingsSection title="Shared snippets" description={me.is_admin ? 'Offered to everyone. Only admins change these.' : 'Offered to everyone, kept by your admins.'}>
            {shared.length ? table(shared) : <p className="muted small">None yet.</p>}
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}
