import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import {
  Menu as MenuIcon, Search, ArrowDown, ArrowUp, Cable, CalendarDays, CreditCard, Globe, KeyRound, Palette, PanelLeft, Plug, Plus, ScrollText,
  ShieldCheck, SlidersHorizontal, Trash2, User, Users, Webhook
} from 'lucide-react';
import { api, type NavItem, type SearchResult, type View } from '../lib/api';
import { useApp } from '../lib/app-context';
import { ColorInput } from '../components/ColorPicker';
import { EmptyState, SaveBar, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { DEFAULT_THEME, THEME_FIELDS, defaultDropdownColors, dropdownColorName, type Theme, type ThemeKey } from '../lib/theme';
import { HomeIcon, displayName, initials } from '../lib/display';
import { navLink } from '../lib/nav';
import { ViewIcon } from '../lib/lucide-icons';
import { RoleSettings, UserSettings } from './AccessSettings';
import { ApiKeySettings, SecurityLog } from './SecuritySettings';
import { ConnectedApps } from './ConnectedApps';
import { CalendarSettings } from './CalendarSettings';
import { PaymentSettings } from './PaymentSettings';
import { PropertySettings } from './PropertySettings';
import { IntegrationSettings } from './IntegrationSettings';
import { WebhookSettings } from './WebhookSettings';
import { Select } from '../components/Select';
import '../settings.css';

// who sees a page: everyone, signed-in users (not bare API keys), or admins
type Gate = 'all' | 'user' | 'admin';
interface SettingsLink { path: string; label: string; icon: ReactNode; gate: Gate; element: ReactNode }

const GROUPS: { label: string; links: SettingsLink[] }[] = [
  { label: 'Your account', links: [
    { path: '', label: 'Account', icon: <User size={16} />, gate: 'all', element: <Account /> },
    { path: 'connected-apps', label: 'Connected apps', icon: <Plug size={16} />, gate: 'all', element: <ConnectedApps /> },
    { path: 'calendars', label: 'Calendars', icon: <CalendarDays size={16} />, gate: 'user', element: <CalendarSettings /> }
  ] },
  { label: 'Workspace', links: [
    { path: 'theme', label: 'Theme', icon: <Palette size={16} />, gate: 'admin', element: <ThemeSettings /> },
    { path: 'navigation', label: 'Navigation menus', icon: <PanelLeft size={16} />, gate: 'admin', element: <NavSettings /> },
    { path: 'properties', label: 'Properties', icon: <SlidersHorizontal size={16} />, gate: 'admin', element: <PropertySettings /> }
  ] },
  { label: 'People and access', links: [
    { path: 'users', label: 'Users', icon: <Users size={16} />, gate: 'admin', element: <UserSettings /> },
    { path: 'roles', label: 'Roles', icon: <ShieldCheck size={16} />, gate: 'admin', element: <RoleSettings /> }
  ] },
  { label: 'Integrations', links: [
    { path: 'embed-domains', label: 'Embed domains', icon: <Globe size={16} />, gate: 'admin', element: <EmbedDomains /> },
    { path: 'view-integrations', label: 'View integrations', icon: <Cable size={16} />, gate: 'admin', element: <IntegrationSettings /> },
    { path: 'webhooks', label: 'Webhooks', icon: <Webhook size={16} />, gate: 'admin', element: <WebhookSettings /> },
    { path: 'payments', label: 'Payments', icon: <CreditCard size={16} />, gate: 'admin', element: <PaymentSettings /> }
  ] },
  { label: 'Security', links: [
    { path: 'api-keys', label: 'API keys', icon: <KeyRound size={16} />, gate: 'admin', element: <ApiKeySettings /> },
    { path: 'security-log', label: 'Security log', icon: <ScrollText size={16} />, gate: 'admin', element: <SecurityLog /> }
  ] }
];

export function Settings() {
  const { me } = useApp();
  const allowed = (g: Gate) => g === 'all' || (g === 'user' ? !!me.user : me.is_admin);
  return (
    <div className="page settings">
      <div className="settings-layout">
        <nav className="settings-rail" aria-label="Settings">
          <h1 className="settings-rail-title">Settings</h1>
          {GROUPS.map((g) => {
            const links = g.links.filter((l) => allowed(l.gate));
            if (links.length === 0) return null;
            return (
              <div key={g.label} className="settings-group">
                <div className="settings-group-label">{g.label}</div>
                {links.map((l) => (
                  <NavLink key={l.path} to={l.path ? `/settings/${l.path}` : '/settings'} end={!l.path}>
                    {l.icon}{l.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="settings-body">
          <Routes>
            {GROUPS.flatMap((g) => g.links).map((l) => {
              const element = allowed(l.gate) ? l.element : <Navigate to="/settings" />;
              return l.path ? <Route key={l.path} path={l.path} element={element} /> : <Route key="index" index element={element} />;
            })}
            <Route path="forms" element={<Navigate to="/settings/embed-domains" replace />} />
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
    <SettingsPage title="Account" description="Who you are signed in as and what you can do in this portal.">
      <div className="profile">
        <span className="person-avatar large">{initials(name)}</span>
        <div>
          <h2>{name}</h2>
          {me.user?.email && <div className="muted">{me.user.email}</div>}
        </div>
      </div>
      <div className="setting-rows">
        <SettingRow label="Access" hint={me.is_admin ? 'Admins can change every setting here.' : 'What this sign-in is allowed to do.'}>
          {me.is_admin ? <StatusPill tone="info">Admin</StatusPill> : <span>{me.scopes.join(', ')}</span>}
        </SettingRow>
        <SettingRow label="Sign out" hint="Ends this session on this device. Other devices stay signed in.">
          <button className="btn" onClick={signOut}>Sign out</button>
        </SettingRow>
      </div>
    </SettingsPage>
  );
}

const THEME_GROUPS: { label: string; keys: ThemeKey[] }[] = [
  { label: 'Brand', keys: ['primary'] },
  { label: 'Sidebar', keys: ['sidebar_background', 'sidebar_text', 'sidebar_active'] },
  { label: 'Content', keys: ['page_background', 'surface', 'text', 'muted_text', 'border'] }
];

function ThemeSettings() {
  const { theme, setTheme, dropdownColors, setDropdownColors } = useApp();
  const [draft, setDraft] = useState<Theme>(theme);
  const [colors, setColors] = useState<string[]>(dropdownColors);
  // what is saved, to tell whether the draft has unsaved changes (the live preview changes `theme` itself)
  const [saved, setSaved] = useState(() => JSON.stringify({ theme, colors: dropdownColors }));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify({ theme: draft, colors }) !== saved;

  function update(next: Theme) {
    setDraft(next);
    setTheme(next); // live preview
    setMessage(null);
  }

  function updateColor(i: number, hex: string) {
    setColors((cs) => cs.map((c, j) => (j === i ? hex.toLowerCase() : c)));
    setMessage(null);
  }

  async function save() {
    setError(null);
    try {
      await api('PUT', '/v1/ui/settings/theme', draft);
      await api('PUT', '/v1/ui/settings/dropdown_colors', { colors });
      setDropdownColors(colors);
      setSaved(JSON.stringify({ theme: draft, colors }));
      setMessage('Theme saved for everyone.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const label = (k: ThemeKey) => THEME_FIELDS.find((f) => f.key === k)!.label;

  return (
    <SettingsPage className="wide" title="Theme" description="Colours apply to everyone in this portal. Changes show straight away; save to keep them.">
      <div className="theme-layout">
        <div className="theme-controls">
          <SettingsSection title="Portal colours">
            {THEME_GROUPS.map((g) => (
              <div key={g.label} className="color-rows">
                <div className="color-rows-head">{g.label}</div>
                {g.keys.map((k) => (
                  <label key={k} className="color-field">
                    <ColorInput value={draft[k]} onChange={(hex) => update({ ...draft, [k]: hex })} label={label(k)} />
                    <span>{label(k)}</span>
                    <HexInput value={draft[k]} onChange={(hex) => update({ ...draft, [k]: hex })} />
                  </label>
                ))}
              </div>
            ))}
          </SettingsSection>
          <SettingsSection title="Default dropdown colours" description="The 16 colours offered when giving a dropdown choice a colour. Choices that already have a colour keep it.">
            <div className="swatch-grid">
              {colors.map((c, i) => (
                <label key={i} className="swatch-tile">
                  <span className="swatch-tile-top">
                    <ColorInput value={c} onChange={(hex) => updateColor(i, hex)} label={dropdownColorName(c, i)} />
                    {/* the hex is in the box below it, so a changed colour just says Custom */}
                    <span>{dropdownColorName(c, i) === c ? 'Custom' : dropdownColorName(c, i)}</span>
                  </span>
                  <HexInput value={c} onChange={(hex) => updateColor(i, hex)} />
                </label>
              ))}
            </div>
          </SettingsSection>
        </div>
        <ThemePreview theme={draft} colors={colors} />
      </div>
      <SaveBar dirty={dirty} message={message} error={error}>
        <button className="btn" onClick={() => { update(DEFAULT_THEME); setColors(defaultDropdownColors()); }}>Reset to defaults</button>
        <button className="btn primary" onClick={save} disabled={!dirty}>Save theme</button>
      </SaveBar>
    </SettingsPage>
  );
}

// A miniature CRM drawn from the draft, showing what this page itself does not: a record, a table with dropdown
// pills and the full dropdown palette.
function ThemePreview({ theme, colors }: { theme: Theme; colors: string[] }) {
  const vars = {
    '--p-primary': theme.primary, '--p-side': theme.sidebar_background, '--p-side-text': theme.sidebar_text,
    '--p-side-active': theme.sidebar_active, '--p-page': theme.page_background, '--p-surface': theme.surface,
    '--p-text': theme.text, '--p-muted': theme.muted_text, '--p-border': theme.border
  } as CSSProperties;
  const rows = [['Website redesign', 'Proposal'], ['Annual support', 'Negotiation'], ['Onboarding package', 'Closed won'], ['Hardware refresh', 'Discovery'], ['Training days', 'Proposal']];
  const stages = ['Discovery', 'Proposal', 'Negotiation', 'Closed won'];
  return (
    <div className="theme-preview-wrap" style={vars}>
      <div className="theme-preview-label">Preview</div>
      <div className="theme-preview" aria-hidden>
        <div className="tp-side"><i className="logo" /><i className="active" /><i /><i /><i /></div>
        <div className="tp-main">
          <div className="tp-head">
            <span className="tp-avatar">NT</span>
            <div><div className="tp-name">Northwind Traders</div><div className="tp-muted">Company</div></div>
            <span className="tp-btn">Create deal</span>
          </div>
          <div className="tp-table">
            <div className="tp-row th"><span>Deal</span><span>Stage</span></div>
            {rows.map(([deal, stage]) => (
              <div key={deal} className="tp-row">
                <a>{deal}</a>
                <span className="tp-pill" style={{ '--pill': colors[stages.indexOf(stage)] ?? theme.primary } as CSSProperties}>{stage}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="tp-palette">{colors.map((c, i) => <span key={i} style={{ background: c }} title={dropdownColorName(c, i)} />)}</div>
    </div>
  );
}

// Text box beside each swatch so a hex code can be typed or pasted. Accepts #rgb or #rrggbb, with or without the #
// (a pasted "#0362FF" next to the box's own # gives one #, not two); anything else stays as typed until it becomes
// valid, and reverts on blur.
function parseHex(text: string): string | null {
  const m = text.trim().replace(/^#+/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(m)) return `#${m}`;
  if (/^[0-9a-f]{3}$/.test(m)) return `#${m.split('').map((c) => c + c).join('')}`;
  return null;
}

function HexInput({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  return (
    <input
      className="hex-input"
      value={text}
      spellCheck={false}
      onChange={(e) => {
        const typed = e.target.value.replace(/^(\s*)#{2,}/, '$1#');
        setText(typed);
        const hex = parseHex(typed);
        if (hex && hex !== value) onChange(hex);
      }}
      onBlur={() => setText(value)}
    />
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
    <SettingsPage
      title="Embed domains"
      description={<>
        Websites allowed to embed forms and booking pages with the snippet from their record page. Enter each address
        separately: <code>https://example.com</code> and <code>https://www.example.com</code> are different websites.
      </>}
    >
      <SettingsSection
        title="Allowed websites"
        description="This stops other websites from using your forms and booking pages. Spam is handled by rate limits and hidden bot checks."
      >
        <form className="origin-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input placeholder="https://www.example.com" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Website address" />
          <button className="btn primary" type="submit" disabled={!draft.trim() || !origins}>
            <Plus size={14} /> Add website
          </button>
        </form>
        {!origins && !error && <TableSkeleton rows={2} />}
        {origins && origins.length === 0 && (
          <EmptyState icon={<Globe size={18} />} title="No websites yet">
            Forms and booking pages only work on their hosted page until you add a website here.
          </EmptyState>
        )}
        {origins && origins.length > 0 && (
          <ul className="origin-list">
            {origins.map((o) => (
              <li key={o}>
                <Globe size={14} className="lead" />
                <span>{o}</span>
                <button className="icon-btn push-right" title="Remove" aria-label={`Remove ${o}`}
                  onClick={() => window.confirm(`Remove ${o}? Forms and booking pages embedded there stop working.`) && save(origins.filter((x) => x !== o))}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <div className="error">{error}</div>}
        {saved && <div className="muted small" role="status">{saved}</div>}
      </SettingsSection>
    </SettingsPage>
  );
}

interface Menu {
  scope: string;
  user_id: string | null;
  items: NavItem[];
  bottom_left: 'menu' | 'home';
  bottom: NavItem[];
}

const BOTTOM_MAX = 3;

interface UserOption {
  id: string;
  name: string;
}

function itemLabel(item: NavItem, objectLabel: (o: string) => string, viewName: (o: string, id: number) => string, customViewName: (slug: string) => string): string {
  switch (item.type) {
    case 'home': return 'Home';
    case 'custom_view': return item.label ?? customViewName(item.slug);
    case 'divider': return 'Divider';
    case 'object': return item.label ?? objectLabel(item.object);
    case 'view': return item.label ?? `${objectLabel(item.object)}: ${viewName(item.object, item.view_id)}`;
    case 'section': return item.label;
  }
}

// A menu row's label: click to rename in place. Enter or leaving the box keeps
// it, Escape cancels. Emptied, a link goes back to its own name (fallback);
// a section needs a label, so emptying one keeps the old label.
function EditableLabel({ value, fallback, onSave }: { value: string; fallback: string | null; onSave: (label: string | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return <button type="button" className="nav-edit-name" title="Rename" onClick={() => setDraft(value)}>{value}</button>;
  }
  const done = (keep: boolean) => {
    const v = draft.trim();
    setDraft(null);
    if (!keep || v === value) return;
    if (!v || v === fallback) {
      if (fallback !== null) onSave(undefined);
      return;
    }
    onSave(v);
  };
  return (
    <input
      className="nav-edit-input"
      autoFocus
      value={draft}
      maxLength={63}
      placeholder={fallback ?? 'Section name'}
      aria-label="Label"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
      }}
    />
  );
}

// what kind of link a row is, shown in small text after its label where the label alone does not say
function itemKind(item: NavItem): string | null {
  switch (item.type) {
    case 'custom_view': return 'Custom view';
    case 'view': return 'Saved view';
    case 'section': return 'Section';
    default: return null;
  }
}

function NavSettings() {
  const { objects, objectByName, reloadNav, navSource, customViews } = useApp();
  const [target, setTarget] = useState<string>('default');
  const [menus, setMenus] = useState<Menu[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [items, setItems] = useState<NavItem[]>([]);
  const [bottomLeft, setBottomLeft] = useState<'menu' | 'home'>('menu');
  const [bottom, setBottom] = useState<NavItem[]>([]);
  // the menu as last loaded or saved, to tell whether there are unsaved changes
  const [savedJson, setSavedJson] = useState('');
  const [views, setViews] = useState<Record<string, View[]>>({});
  // section: a section's index, null for the sidebar's top level, 'bottom' for the mobile hotbar
  const [adding, setAdding] = useState<{ section: number | null | 'bottom'; type: string; object: string; view: string; label: string }>({ section: null, type: 'object', object: objects[0]?.api_name ?? '', view: '', label: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMenus() {
    const res = await api<{ results: Menu[] }>('GET', '/v1/ui/nav/menus');
    setMenus(res.results);
    return res.results;
  }

  useEffect(() => {
    loadMenus().then((m) => { showMenu(m.find((x) => x.scope === 'default')); setLoaded(true); });
    api<SearchResult>('POST', '/v1/objects/users/search', { limit: 200, properties: ['name', 'first_name', 'last_name', 'email'], sorts: [{ property: 'name', direction: 'asc' }] })
      .then((r) => setUsers(r.results.map((u) => ({ id: u.id, name: displayName(u.properties, u.id) }))))
      .catch(() => undefined);
  }, []);

  function showMenu(m: Menu | undefined) {
    const next = { items: m?.items ?? [], bottomLeft: m?.bottom_left ?? 'menu', bottom: m?.bottom ?? [] };
    setItems(next.items);
    setBottomLeft(next.bottomLeft);
    setBottom(next.bottom);
    setSavedJson(JSON.stringify(next));
  }

  const dirty = loaded && JSON.stringify({ items, bottomLeft, bottom }) !== savedJson;

  function pickTarget(t: string) {
    if (dirty && !window.confirm('Switch menus? Your unsaved changes to this menu are lost.')) return;
    setTarget(t);
    setMessage(null);
    const own = menus.find((m) => m.scope === 'user' && m.user_id === t);
    showMenu((t !== 'default' && own) || menus.find((m) => m.scope === 'default'));
  }

  useEffect(() => {
    if (adding.type !== 'view' || !adding.object || views[adding.object]) return;
    api<{ results: View[] }>('GET', `/v1/ui/views?object=${adding.object}`).then((r) => setViews((v) => ({ ...v, [adding.object]: r.results })));
  }, [adding.type, adding.object, views]);

  const objectLabel = (o: string) => objectByName.get(o)?.label_plural ?? o;
  const viewName = (o: string, id: number) => views[o]?.find((v) => v.id === id)?.name ?? `view ${id}`;
  const customViewName = (slug: string) => customViews.find((v) => v.slug === slug)?.name ?? slug;

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
    } else if (adding.type === 'custom_view') {
      if (!adding.view) return;
      item = { type: 'custom_view', slug: adding.view, ...(adding.label ? { label: adding.label } : {}) };
    } else if (adding.type === 'section') {
      if (!adding.label.trim()) return;
      item = { type: 'section', label: adding.label.trim(), items: [] };
    } else item = { type: adding.type as 'home' | 'divider' };
    if (adding.section === 'bottom') {
      if (bottom.length >= BOTTOM_MAX) {
        setError(`The mobile hotbar holds at most ${BOTTOM_MAX} links between the left button and Search.`);
        return;
      }
      setError(null);
      setBottom((l) => [...l, item]);
    } else update(adding.section, (l) => [...l, item]);
    setAdding((a) => ({ ...a, label: '' }));
  }

  async function save() {
    setError(null);
    try {
      if (target === 'default') await api('PUT', '/v1/ui/nav/default', { items, bottom_left: bottomLeft, bottom });
      else await api('PUT', `/v1/ui/nav/users/${target}`, { items, bottom_left: bottomLeft, bottom });
      await loadMenus();
      await reloadNav();
      setSavedJson(JSON.stringify({ items, bottomLeft, bottom }));
      setMessage('Menu saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetUser() {
    await api('DELETE', `/v1/ui/nav/users/${target}`);
    const m = await loadMenus();
    showMenu(m.find((x) => x.scope === 'default'));
    await reloadNav();
    setMessage('This user now uses the default menu.');
  }

  const hasOwn = target !== 'default' && menus.some((m) => m.scope === 'user' && m.user_id === target);

  const row = (it: NavItem, i: number, list: NavItem[], change: (fn: (l: NavItem[]) => NavItem[]) => void, child: boolean, children?: ReactNode) => {
    const label = itemLabel(it, objectLabel, viewName, customViewName);
    const kind = itemKind(it);
    return (
      <div key={i} className={`nav-edit-row ${it.type}${child ? ' child' : ''}`}>
        <span className="nav-edit-label">
          {it.type === 'home' || it.type === 'divider' ? label : (
            <EditableLabel
              value={label}
              fallback={it.type === 'section' ? null : itemLabel({ ...it, label: undefined } as NavItem, objectLabel, viewName, customViewName)}
              onSave={(l) => change((ls) => ls.map((x, j) => (j === i ? ({ ...x, label: l } as NavItem) : x)))}
            />
          )}
          {kind && it.type !== 'section' && <span className="kind">{kind}</span>}
        </span>
        <button className="icon-btn" onClick={() => change((l) => move(l, i, -1))} disabled={i === 0} aria-label={`Move ${label} up`}><ArrowUp size={14} /></button>
        <button className="icon-btn" onClick={() => change((l) => move(l, i, 1))} disabled={i === list.length - 1} aria-label={`Move ${label} down`}><ArrowDown size={14} /></button>
        <button className="icon-btn" onClick={() => change((l) => l.filter((_, j) => j !== i))} aria-label={`Remove ${label}`}><Trash2 size={14} /></button>
        {children}
      </div>
    );
  };

  const renderList = (list: NavItem[], section: number | null) =>
    list.map((it, i) => row(it, i, list, (fn) => update(section, fn), section !== null,
      it.type === 'section' && section === null ? <div className="nav-edit-children">{renderList(it.items, i)}</div> : undefined));


  return (
    <SettingsPage
      title="Navigation menus"
      description={<>The default menu is shown to everyone without their own. Pick a user to give them their own menu.{navSource === 'user' && ' Your own menu overrides the default.'}</>}
      actions={
        <Select value={target} onChange={(v) => pickTarget(v)} aria-label="Menu to edit">
          <option value="default">Default menu (everyone)</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}{menus.some((m) => m.scope === 'user' && m.user_id === u.id) ? ' (own menu)' : ''}
            </option>
          ))}
        </Select>
      }
    >
      <SettingsSection
        title="Sidebar"
        description={target !== 'default' && !hasOwn ? 'This user uses the default menu. Saving creates their own copy.' : 'Links in the order they appear. Sections group the links under them.'}
      >
        {!loaded ? <TableSkeleton rows={5} /> : items.length === 0
          ? <EmptyState icon={<PanelLeft size={18} />} title="This menu is empty">Add objects, views and sections below.</EmptyState>
          : <div className="nav-tree">{renderList(items, null)}</div>}
      </SettingsSection>

      <SettingsSection title="Mobile hotbar" description={`Shown along the bottom of the screen on mobile: the left button, up to ${BOTTOM_MAX} links, then Search.`}>
        <BottomBarPreview left={bottomLeft} items={bottom} />
        <div className="setting-rows">
          <SettingRow label="Left button" htmlFor="bottom-left">
            <Select id="bottom-left" value={bottomLeft} onChange={(v) => setBottomLeft(v as 'menu' | 'home')}>
              <option value="menu">Menu (opens the full menu)</option>
              <option value="home">Home</option>
            </Select>
          </SettingRow>
          <SettingRow label="Links" hint="Add links with Add an item below, choosing Mobile hotbar.">
            {bottom.length === 0 ? <span className="muted">No links between the left button and Search.</span> : (
              <div className="nav-tree stretch">
                {bottom.map((it, i) => row(it, i, bottom, (fn) => setBottom(fn), false))}
              </div>
            )}
          </SettingRow>
        </div>
      </SettingsSection>

      <SettingsSection title="Add an item">
        <div className="nav-add">
          <label className="field">
            <span>Where</span>
            <Select
              value={adding.section ?? ''}
              onChange={(v) => {
                const section = v === '' ? null : v === 'bottom' ? 'bottom' : Number(v);
                // dividers and sections cannot go in the hotbar, nor Home (that is the Left button setting)
                setAdding((a) => ({ ...a, section, type: section === 'bottom' && (a.type === 'divider' || a.type === 'section' || a.type === 'home') ? 'object' : a.type }));
              }}
            >
              <option value="">Sidebar</option>
              {items.map((it, i) => it.type === 'section' && <option key={i} value={i}>Sidebar, in section "{it.label}"</option>)}
              <option value="bottom">Mobile hotbar</option>
            </Select>
          </label>
          <label className="field">
            <span>Type</span>
            <Select value={adding.type} onChange={(v) => setAdding((a) => ({ ...a, type: v, view: '' }))}>
              <option value="object">Object</option>
              <option value="view">Saved view</option>
              {adding.section !== 'bottom' && <option value="home">Home</option>}
              <option value="custom_view">Custom view</option>
              {adding.section !== 'bottom' && <option value="divider">Divider</option>}
              {adding.section === null && <option value="section">Section</option>}
            </Select>
          </label>
          {(adding.type === 'object' || adding.type === 'view') && (
            <label className="field">
              <span>Object</span>
              <Select value={adding.object} onChange={(v) => setAdding((a) => ({ ...a, object: v, view: '' }))}>
                {objects.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
              </Select>
            </label>
          )}
          {adding.type === 'view' && (
            <label className="field">
              <span>View</span>
              <Select value={adding.view} onChange={(v) => setAdding((a) => ({ ...a, view: v }))}>
                <option value="">Choose a view</option>
                {(views[adding.object] ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.shared ? '' : ' (personal)'}</option>)}
              </Select>
            </label>
          )}
          {adding.type === 'custom_view' && (
            <label className="field">
              <span>View</span>
              <Select value={adding.view} onChange={(v) => setAdding((a) => ({ ...a, view: v }))}>
                <option value="">Choose a view</option>
                {customViews.map((v) => <option key={v.slug} value={v.slug}>{v.name ?? v.slug}{v.status === 'published' ? '' : ' (draft)'}</option>)}
              </Select>
            </label>
          )}
          {(adding.type === 'section' || adding.type === 'view' || adding.type === 'custom_view') && (
            <label className="field">
              <span>{adding.type === 'section' ? 'Section name' : 'Label (optional)'}</span>
              <input value={adding.label} maxLength={63} onChange={(e) => setAdding((a) => ({ ...a, label: e.target.value }))} />
            </label>
          )}
          <button className="btn" onClick={add}><Plus size={14} /> Add</button>
        </div>
      </SettingsSection>

      <SaveBar dirty={dirty} message={message} error={error}>
        {hasOwn && <button className="btn" onClick={resetUser}>Reset to default menu</button>}
        <button className="btn primary" onClick={save}>Save menu</button>
      </SaveBar>
    </SettingsPage>
  );
}

// The mobile hotbar as BottomBar (components/MobileNav.tsx) draws it, with the same classes and links, but not
// clickable. Like the real bar, links this admin cannot open are left out.
function BottomBarPreview({ left, items }: { left: 'menu' | 'home'; items: NavItem[] }) {
  const { objectByName, customViews } = useApp();
  return (
    <div className="bottom-bar-preview" aria-label="Mobile hotbar preview">
      <div className="bottom-bar">
        <span className="bottom-item">
          {left === 'menu' ? <MenuIcon size={22} strokeWidth={1.75} /> : <HomeIcon size={22} strokeWidth={1.75} />}
          <span>{left === 'menu' ? 'Menu' : 'Home'}</span>
        </span>
        {items.map((item, i) => {
          const link = navLink(item, objectByName, customViews);
          if (!link) return null;
          return (
            <span key={i} className="bottom-item">
              <ViewIcon icon={link.iconName} fallback={link.Icon} size={22} strokeWidth={1.75} />
              <span>{link.label}</span>
            </span>
          );
        })}
        <span className="bottom-item">
          <Search size={22} strokeWidth={1.75} />
          <span>Search</span>
        </span>
      </div>
    </div>
  );
}
