import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { api, type NavItem, type SearchResult, type View } from '../lib/api';
import { useApp } from '../lib/app-context';
import { DEFAULT_THEME, THEME_FIELDS, type Theme } from '../lib/theme';
import { displayName, initials } from '../lib/display';
import { RoleSettings, UserSettings } from './AccessSettings';
import { ApiKeySettings, SecurityLog } from './SecuritySettings';
import { ConnectedApps } from './ConnectedApps';
import { CalendarSettings } from './CalendarSettings';
import { PropertySettings } from './PropertySettings';

export function Settings() {
  const { me } = useApp();
  return (
    <div className="page settings">
      <h1 className="page-title">Settings</h1>
      <div className="settings-layout">
        <nav className="settings-nav">
          <NavLink to="/settings" end>Account</NavLink>
          <NavLink to="/settings/connected-apps">Connected apps</NavLink>
          {me.user && <NavLink to="/settings/calendars">Calendars</NavLink>}
          {me.is_admin && <NavLink to="/settings/theme">Theme</NavLink>}
          {me.is_admin && <NavLink to="/settings/navigation">Navigation menus</NavLink>}
          {me.is_admin && <NavLink to="/settings/properties">Properties</NavLink>}
          {me.is_admin && <NavLink to="/settings/users">Users</NavLink>}
          {me.is_admin && <NavLink to="/settings/roles">Roles</NavLink>}
          {me.is_admin && <NavLink to="/settings/embed-domains">Embed domains</NavLink>}
          {me.is_admin && <NavLink to="/settings/api-keys">API keys</NavLink>}
          {me.is_admin && <NavLink to="/settings/security-log">Security log</NavLink>}
        </nav>
        <div className="settings-body">
          <Routes>
            <Route index element={<Account />} />
            <Route path="connected-apps" element={<ConnectedApps />} />
            <Route path="calendars" element={<CalendarSettings />} />
            <Route path="theme" element={me.is_admin ? <ThemeSettings /> : <Navigate to="/settings" />} />
            <Route path="navigation" element={me.is_admin ? <NavSettings /> : <Navigate to="/settings" />} />
            <Route path="properties" element={me.is_admin ? <PropertySettings /> : <Navigate to="/settings" />} />
            <Route path="users" element={me.is_admin ? <UserSettings /> : <Navigate to="/settings" />} />
            <Route path="roles" element={me.is_admin ? <RoleSettings /> : <Navigate to="/settings" />} />
            <Route path="embed-domains" element={me.is_admin ? <EmbedDomains /> : <Navigate to="/settings" />} />
            <Route path="forms" element={<Navigate to="/settings/embed-domains" replace />} />
            <Route path="api-keys" element={me.is_admin ? <ApiKeySettings /> : <Navigate to="/settings" />} />
            <Route path="security-log" element={me.is_admin ? <SecurityLog /> : <Navigate to="/settings" />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function Account() {
  const { me, signOut } = useApp();
  const name = me.user?.name || [me.user?.first_name, me.user?.last_name].filter(Boolean).join(' ') || me.key_name;
  return (
    <section>
      <div className="account">
        <span className="record-avatar">{initials(name)}</span>
        <div>
          <h2>{name}</h2>
          <div className="muted">{me.user?.email ?? ''}</div>
        </div>
      </div>
      <dl className="facts">
        <dt>Signed in with</dt><dd>Google</dd>
        <dt>Access</dt><dd>{me.is_admin ? 'Admin' : me.scopes.join(', ')}</dd>
      </dl>
      <button className="btn" onClick={signOut}>Sign out</button>
    </section>
  );
}

function ThemeSettings() {
  const { theme, setTheme } = useApp();
  const [draft, setDraft] = useState<Theme>(theme);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update(next: Theme) {
    setDraft(next);
    setTheme(next); // live preview
    setSaved(null);
  }

  async function save() {
    setError(null);
    try {
      await api('PUT', '/v1/ui/settings/theme', draft);
      setSaved('Saved for everyone.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <h2>Theme</h2>
      <p className="muted">Colors apply to everyone in this portal. Changes preview immediately; save to keep them.</p>
      <div className="theme-grid">
        {THEME_FIELDS.map((f) => (
          <label key={f.key} className="color-field">
            <input type="color" value={draft[f.key]} onChange={(e) => update({ ...draft, [f.key]: e.target.value })} />
            <span>{f.label}</span>
            <code className="muted">{draft[f.key]}</code>
          </label>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={() => update(DEFAULT_THEME)}>Reset to defaults</button>
        <button className="btn primary" onClick={save}>Save theme</button>
        {saved && <span className="muted small">{saved}</span>}
      </div>
    </section>
  );
}

// Embed domains: websites allowed to embed forms and booking pages (embed.js). The CRM's own address is always
// allowed, for the hosted /p/form/ page.
function EmbedDomains() {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ forms?: { allowed_origins?: string[] } }>('GET', '/v1/ui/settings')
      .then((s) => setOrigins(s.forms?.allowed_origins ?? []))
      .catch((err) => setError((err as Error).message));
  }, []);

  async function save(next: string[]) {
    setError(null);
    setSaved(null);
    try {
      const res = await api<{ allowed_origins: string[] }>('PUT', '/v1/ui/settings/forms', { allowed_origins: next });
      setOrigins(res.allowed_origins);
      setDraft('');
      setSaved('Saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function add() {
    const v = draft.trim();
    if (!v || !origins) return;
    save([...origins, /^https?:\/\//i.test(v) ? v : `https://${v}`]);
  }

  return (
    <section>
      <h2>Embed domains</h2>
      <p className="muted">
        Websites allowed to embed forms and booking pages with the snippet from their record page. Enter each address
        separately: <code>https://example.com</code> and <code>https://www.example.com</code> are different websites.
        This stops other websites from using your forms and booking pages; spam is handled by rate limits and hidden bot checks.
      </p>
      {origins && (
        <div className="origin-list">
          {origins.length === 0 ? <div className="muted small">No websites yet. Forms and booking pages only work on their hosted page.</div> : (
            <ul>
              {origins.map((o) => (
                <li key={o}>
                  <span>{o}</span>
                  <button className="icon-btn push-right" title="Remove" aria-label={`Remove ${o}`}
                    onClick={() => window.confirm(`Remove ${o}? Forms and booking pages embedded there stop working.`) && save(origins.filter((x) => x !== o))}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="field inline" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input placeholder="https://www.example.com" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Website address" />
            <button className="btn primary" type="submit" disabled={!draft.trim()}>
              <Plus size={14} /> Add
            </button>
          </form>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {saved && <div className="muted small">{saved}</div>}
    </section>
  );
}

interface UserOption {
  id: string;
  name: string;
}

function itemLabel(item: NavItem, objectLabel: (o: string) => string, viewName: (o: string, id: number) => string): string {
  switch (item.type) {
    case 'home': return 'Home';
    case 'reporting': return 'Reporting';
    case 'divider': return '— Divider —';
    case 'object': return item.label ?? objectLabel(item.object);
    case 'view': return item.label ?? `${objectLabel(item.object)}: ${viewName(item.object, item.view_id)}`;
    case 'section': return `Section: ${item.label}`;
  }
}

function NavSettings() {
  const { objects, objectByName, reloadNav, navSource } = useApp();
  const [target, setTarget] = useState<string>('default');
  const [menus, setMenus] = useState<{ scope: string; user_id: string | null; items: NavItem[] }[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [items, setItems] = useState<NavItem[]>([]);
  const [views, setViews] = useState<Record<string, View[]>>({});
  const [adding, setAdding] = useState<{ section: number | null; type: string; object: string; view: string; label: string }>({ section: null, type: 'object', object: objects[0]?.api_name ?? '', view: '', label: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMenus() {
    const res = await api<{ results: { scope: string; user_id: string | null; items: NavItem[] }[] }>('GET', '/v1/ui/nav/menus');
    setMenus(res.results);
    return res.results;
  }

  useEffect(() => {
    loadMenus().then((m) => setItems(m.find((x) => x.scope === 'default')?.items ?? []));
    api<SearchResult>('POST', '/v1/objects/users/search', { limit: 200, properties: ['name', 'first_name', 'last_name', 'email'], sorts: [{ property: 'name', direction: 'asc' }] })
      .then((r) => setUsers(r.results.map((u) => ({ id: u.id, name: displayName(u.properties, u.id) }))))
      .catch(() => undefined);
  }, []);

  function pickTarget(t: string) {
    setTarget(t);
    setMessage(null);
    const own = menus.find((m) => m.scope === 'user' && m.user_id === t);
    setItems(t === 'default' ? menus.find((m) => m.scope === 'default')?.items ?? [] : own?.items ?? menus.find((m) => m.scope === 'default')?.items ?? []);
  }

  useEffect(() => {
    if (adding.type !== 'view' || !adding.object || views[adding.object]) return;
    api<{ results: View[] }>('GET', `/v1/ui/views?object=${adding.object}`).then((r) => setViews((v) => ({ ...v, [adding.object]: r.results })));
  }, [adding.type, adding.object, views]);

  const objectLabel = (o: string) => objectByName.get(o)?.label_plural ?? o;
  const viewName = (o: string, id: number) => views[o]?.find((v) => v.id === id)?.name ?? `view ${id}`;

  function update(section: number | null, fn: (list: NavItem[]) => NavItem[]) {
    setItems((all) => {
      if (section === null) return fn(all);
      return all.map((it, i) => (i === section && it.type === 'section' ? { ...it, items: fn(it.items) } : it));
    });
  }

  const move = (list: NavItem[], i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  function add() {
    let item: NavItem;
    if (adding.type === 'object') item = { type: 'object', object: adding.object };
    else if (adding.type === 'view') {
      if (!adding.view) return;
      item = { type: 'view', object: adding.object, view_id: Number(adding.view), ...(adding.label ? { label: adding.label } : {}) };
    } else if (adding.type === 'section') {
      if (!adding.label.trim()) return;
      item = { type: 'section', label: adding.label.trim(), items: [] };
    } else item = { type: adding.type as 'home' | 'reporting' | 'divider' };
    update(adding.section, (l) => [...l, item]);
    setAdding((a) => ({ ...a, label: '' }));
  }

  async function save() {
    setError(null);
    try {
      if (target === 'default') await api('PUT', '/v1/ui/nav/default', { items });
      else await api('PUT', `/v1/ui/nav/users/${target}`, { items });
      await loadMenus();
      await reloadNav();
      setMessage('Saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetUser() {
    await api('DELETE', `/v1/ui/nav/users/${target}`);
    const m = await loadMenus();
    setItems(m.find((x) => x.scope === 'default')?.items ?? []);
    await reloadNav();
    setMessage('This user now uses the default menu.');
  }

  const hasOwn = target !== 'default' && menus.some((m) => m.scope === 'user' && m.user_id === target);

  const renderList = (list: NavItem[], section: number | null) =>
    list.map((it, i) => (
      <div key={`${section}-${i}`} className={`nav-edit-row${section !== null ? ' child' : ''}`}>
        <span className="nav-edit-label">{itemLabel(it, objectLabel, viewName)}</span>
        <button className="icon-btn" onClick={() => update(section, (l) => move(l, i, -1))} disabled={i === 0} aria-label="Move up"><ArrowUp size={14} /></button>
        <button className="icon-btn" onClick={() => update(section, (l) => move(l, i, 1))} disabled={i === list.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
        <button className="icon-btn" onClick={() => update(section, (l) => l.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={14} /></button>
        {it.type === 'section' && section === null && (
          <div className="nav-edit-children">{renderList(it.items, i)}</div>
        )}
      </div>
    ));

  return (
    <section>
      <h2>Navigation menus</h2>
      <p className="muted">
        The default menu is shown to everyone without their own. Pick a user to give them their own menu.
        {navSource === 'user' && ' (Your own menu overrides the default.)'}
      </p>
      <label className="field inline">
        <span>Menu</span>
        <select value={target} onChange={(e) => pickTarget(e.target.value)}>
          <option value="default">Default menu (everyone)</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}{menus.some((m) => m.scope === 'user' && m.user_id === u.id) ? ' (own menu)' : ''}
            </option>
          ))}
        </select>
      </label>
      {target !== 'default' && !hasOwn && <p className="muted small">This user uses the default menu. Saving creates their own copy.</p>}

      <div className="nav-edit">{renderList(items, null)}</div>

      <div className="nav-add">
        <select value={adding.section ?? ''} onChange={(e) => setAdding((a) => ({ ...a, section: e.target.value === '' ? null : Number(e.target.value) }))}>
          <option value="">Add to top level</option>
          {items.map((it, i) => it.type === 'section' && <option key={i} value={i}>Add to section "{it.label}"</option>)}
        </select>
        <select value={adding.type} onChange={(e) => setAdding((a) => ({ ...a, type: e.target.value }))}>
          <option value="object">Object</option>
          <option value="view">Saved view</option>
          <option value="home">Home</option>
          <option value="reporting">Reporting</option>
          <option value="divider">Divider</option>
          {adding.section === null && <option value="section">Section</option>}
        </select>
        {(adding.type === 'object' || adding.type === 'view') && (
          <select value={adding.object} onChange={(e) => setAdding((a) => ({ ...a, object: e.target.value, view: '' }))}>
            {objects.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
          </select>
        )}
        {adding.type === 'view' && (
          <select value={adding.view} onChange={(e) => setAdding((a) => ({ ...a, view: e.target.value }))}>
            <option value="">Choose a view</option>
            {(views[adding.object] ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.shared ? '' : ' (personal)'}</option>)}
          </select>
        )}
        {(adding.type === 'section' || adding.type === 'view') && (
          <input placeholder={adding.type === 'section' ? 'Section name' : 'Label (optional)'} value={adding.label} maxLength={63} onChange={(e) => setAdding((a) => ({ ...a, label: e.target.value }))} />
        )}
        <button className="btn" onClick={add}><Plus size={14} /> Add</button>
      </div>

      {error && <div className="error">{error}</div>}
      <div className="actions">
        {hasOwn && <button className="btn" onClick={resetUser}>Reset to default menu</button>}
        <button className="btn primary" onClick={save}>Save menu</button>
        {message && <span className="muted small">{message}</span>}
      </div>
    </section>
  );
}
