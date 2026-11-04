import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  Menu as MenuIcon, Search, Copy, ArrowDown, ArrowUp, Boxes, Cable, CalendarDays, Coins, CreditCard, Globe, GripVertical, IdCard, KeyRound, Palette, PanelLeft, Plug, Plus, ScrollText,
  Hash, MapPin, ShieldCheck, SlidersHorizontal, Trash2, Upload, User, Users, Webhook
} from 'lucide-react';
import { BrandMark } from '../components/Logo';
import { api, type CrmRecord, type NavItem, type SearchResult, type View } from '../lib/api';
import { useApp } from '../lib/app-context';
import { ColorInput } from '../components/ColorPicker';
import { EmptyState, SaveBar, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton, useReview } from '../components/settings';
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
import { ObjectSettings } from './ObjectSettings';
import { IntegrationSettings } from './IntegrationSettings';
import { WebhookSettings } from './WebhookSettings';
import { CardScannerSettings } from './CardScannerSettings';
import { CurrencySettings } from './CurrencySettings';
import { AddressSettings } from './AddressSettings';
import { SnippetSettings } from './SnippetSettings';
import { Select } from '../components/Select';
import { Modal } from '../components/ui';
import { HtmlEditorModal, HtmlValue } from '../components/HtmlEditor';
import '../settings.css';
import { confirmDialog } from '../components/confirm';

// who sees a page: everyone, signed-in users (not bare API keys), admins, or
// those who may edit a menu (admins, and users allowed to change their own)
type Gate = 'all' | 'user' | 'admin' | 'nav';
interface SettingsLink { path: string; label: string; icon: ReactNode; gate: Gate; element: ReactNode }

const GROUPS: { label: string; links: SettingsLink[] }[] = [
  { label: 'Your account', links: [
    { path: '', label: 'Account', icon: <User size={16} />, gate: 'all', element: <Account /> },
    { path: 'connected-apps', label: 'Connected apps', icon: <Plug size={16} />, gate: 'all', element: <ConnectedApps /> },
    { path: 'calendars', label: 'Calendars', icon: <CalendarDays size={16} />, gate: 'user', element: <CalendarSettings /> },
    { path: 'snippets', label: 'Snippets', icon: <Hash size={16} />, gate: 'all', element: <SnippetSettings /> }
  ] },
  { label: 'Workspace', links: [
    { path: 'theme', label: 'Theme', icon: <Palette size={16} />, gate: 'admin', element: <ThemeSettings /> },
    { path: 'navigation', label: 'Navigation menus', icon: <PanelLeft size={16} />, gate: 'nav', element: <NavSettings /> },
    { path: 'objects', label: 'Objects', icon: <Boxes size={16} />, gate: 'admin', element: <ObjectSettings /> },
    { path: 'properties', label: 'Properties', icon: <SlidersHorizontal size={16} />, gate: 'admin', element: <PropertySettings /> },
    { path: 'currencies', label: 'Currencies', icon: <Coins size={16} />, gate: 'admin', element: <CurrencySettings /> }
  ] },
  { label: 'People and access', links: [
    { path: 'users', label: 'Users', icon: <Users size={16} />, gate: 'admin', element: <UserSettings /> },
    { path: 'roles', label: 'Roles', icon: <ShieldCheck size={16} />, gate: 'admin', element: <RoleSettings /> }
  ] },
  { label: 'Integrations', links: [
    { path: 'embed-domains', label: 'Embed domains', icon: <Globe size={16} />, gate: 'admin', element: <EmbedDomains /> },
    { path: 'view-integrations', label: 'View integrations', icon: <Cable size={16} />, gate: 'admin', element: <IntegrationSettings /> },
    { path: 'webhooks', label: 'Webhooks', icon: <Webhook size={16} />, gate: 'admin', element: <WebhookSettings /> },
    { path: 'payments', label: 'Payments', icon: <CreditCard size={16} />, gate: 'admin', element: <PaymentSettings /> },
    { path: 'card-scanner', label: 'Card scanner', icon: <IdCard size={16} />, gate: 'admin', element: <CardScannerSettings /> },
    { path: 'address-autocomplete', label: 'Address autocomplete', icon: <MapPin size={16} />, gate: 'admin', element: <AddressSettings /> }
  ] },
  { label: 'Security', links: [
    { path: 'api-keys', label: 'API keys', icon: <KeyRound size={16} />, gate: 'admin', element: <ApiKeySettings /> },
    { path: 'security-log', label: 'Security log', icon: <ScrollText size={16} />, gate: 'admin', element: <SecurityLog /> }
  ] }
];

export function Settings() {
  const { me, navCanEdit } = useApp();
  const allowed = (g: Gate) => g === 'all' || (g === 'user' ? !!me.user : g === 'nav' ? me.is_admin || navCanEdit : me.is_admin);
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
      {me.user && <EmailSignature userId={me.user.id} initial={me.user.email_signature ?? null} canWrite={me.scopes.includes('write')} />}
    </SettingsPage>
  );
}

// Your own email signature (users.email_signature), saved on your user
// record like any other property (needs Edit on users; the API cleans it).
function EmailSignature({ userId, initial, canWrite }: { userId: string; initial: string | null; canWrite: boolean }) {
  const { toast } = useApp();
  const [html, setHtml] = useState(initial);
  const [editing, setEditing] = useState(false);
  return (
    <SettingsSection title="Email signature" description="Added to the end of emails you send from the CRM. Images must be public links: a CRM file (its public link is turned on) or a public web address."
      actions={canWrite && !html ? <button className="btn" onClick={() => setEditing(true)}>Add signature</button> : undefined}>
      {html
        ? <HtmlValue html={html} title="Email signature" onEdit={canWrite ? () => setEditing(true) : undefined} />
        : <p className="muted">No signature yet.</p>}
      {editing && (
        <HtmlEditorModal
          title="Email signature"
          value={html ?? ''}
          hint="Write HTML or paste a signature's HTML. Scripts and forms are removed on save."
          onClose={() => setEditing(false)}
          onSave={async (draft) => {
            const res = await api<CrmRecord>('PATCH', `/v1/objects/users/${userId}`, { properties: { email_signature: draft.trim() ? draft : null } });
            setHtml((res.properties.email_signature as string | null) ?? null);
            setEditing(false);
            toast('Signature saved');
          }}
        />
      )}
    </SettingsSection>
  );
}

const THEME_GROUPS: { label: string; keys: ThemeKey[] }[] = [
  { label: 'Brand', keys: ['primary'] },
  { label: 'Sidebar', keys: ['sidebar_background', 'sidebar_text', 'sidebar_active'] },
  { label: 'Content', keys: ['page_background', 'surface', 'text', 'muted_text', 'border'] }
];

// A picked logo file as a data URL: SVGs as they are, other images shrunk to fit 256 × 256 and saved as PNG
// (transparency kept), so the setting stays small.
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

async function logoFromFile(file: File): Promise<string> {
  if (!LOGO_TYPES.includes(file.type)) throw new Error('Pick a PNG, JPEG, WebP, GIF or SVG image.');
  const url = await readFileAsDataUrl(file);
  if (file.type === 'image/svg+xml') {
    if (url.length > 300 * 1024) throw new Error('That SVG is too large (300 KB at most).');
    return url;
  }
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not open that image.'));
    img.src = url;
  });
  const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

function ThemeSettings() {
  const { theme, setTheme, dropdownColors, setDropdownColors, logo, setLogo } = useApp();
  const [draft, setDraft] = useState<Theme>(theme);
  const [colors, setColors] = useState<string[]>(dropdownColors);
  const [logoDraft, setLogoDraft] = useState<string | null>(logo);
  // what is saved, to tell whether the draft has unsaved changes (the live preview changes `theme` itself)
  const [saved, setSaved] = useState(() => JSON.stringify({ theme, colors: dropdownColors, logo }));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify({ theme: draft, colors, logo: logoDraft }) !== saved;

  function update(next: Theme) {
    setDraft(next);
    setTheme(next); // live preview
    setMessage(null);
  }

  function updateLogo(next: string | null) {
    setLogoDraft(next);
    setLogo(next); // live preview in the sidebar
    setMessage(null);
  }

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      updateLogo(await logoFromFile(file));
    } catch (err) {
      setError((err as Error).message);
    }
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
      await api('PUT', '/v1/ui/settings/logo', { image: logoDraft });
      setDropdownColors(colors);
      setSaved(JSON.stringify({ theme: draft, colors, logo: logoDraft }));
      setMessage('Theme saved for everyone.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const label = (k: ThemeKey) => THEME_FIELDS.find((f) => f.key === k)!.label;

  return (
    <SettingsPage className="wide" title="Theme" description="The logo and colours apply to everyone in this portal. Changes show straight away; save to keep them.">
      <div className="theme-layout">
        <div className="theme-controls">
          <SettingsSection title="Logo" description="Shown in the sidebar, the phone header and the login page. A square image with a transparent background works best.">
            <div className="logo-field">
              <span className="logo-field-tile dark" title="On the sidebar"><BrandMark src={logoDraft} size={36} /></span>
              <span className="logo-field-tile light" title="On a light page"><BrandMark src={logoDraft} size={36} /></span>
              <div className="logo-field-actions">
                <label className="btn">
                  <Upload size={14} /> {logoDraft ? 'Change logo' : 'Upload logo'}
                  <input type="file" accept={LOGO_TYPES.join(',')} hidden onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {logoDraft && <button className="btn" onClick={() => updateLogo(null)}>Use the CRM logo</button>}
              </div>
            </div>
          </SettingsSection>
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
        <ThemePreview theme={draft} colors={colors} logo={logoDraft} />
      </div>
      <SaveBar dirty={dirty} message={message} error={error}>
        <button className="btn" onClick={() => { update(DEFAULT_THEME); setColors(defaultDropdownColors()); updateLogo(null); }}>Reset to defaults</button>
        <button className="btn primary" onClick={save} disabled={!dirty}>Save theme</button>
      </SaveBar>
    </SettingsPage>
  );
}

// A miniature CRM drawn from the draft, showing what this page itself does not: a record, a table with dropdown
// pills and the full dropdown palette.
function ThemePreview({ theme, colors, logo }: { theme: Theme; colors: string[]; logo: string | null }) {
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
        <div className="tp-side">{logo ? <img className="tp-logo brand-logo" src={logo} alt="" width={22} height={22} /> : <i className="logo" />}<i className="active" /><i /><i /><i /></div>
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
// allowed, for the hosted /p/form/ page. Websites added outside the CRM (an AI over MCP, an API key) wait in
// pending_origins until an admin allows them here (migration 0061).
interface PendingOrigin {
  origin: string;
  requested_via: string | null;
  requested_at: string;
}

function EmbedDomains() {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [pending, setPending] = useState<PendingOrigin[]>([]);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const review = useReview();

  useEffect(() => {
    api<{ forms?: { allowed_origins?: string[]; pending_origins?: PendingOrigin[] } }>('GET', '/v1/ui/settings')
      .then((s) => {
        setOrigins(s.forms?.allowed_origins ?? []);
        setPending(s.forms?.pending_origins ?? []);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  // next: the allowed websites; keep: the waiting ones to keep waiting
  async function save(next: string[], keep = pending.map((x) => x.origin), message = 'Saved.') {
    setError(null);
    setSaved(null);
    try {
      const res = await api<{ allowed_origins: string[]; pending_origins: PendingOrigin[] }>('PUT', '/v1/ui/settings/forms', { allowed_origins: next, pending_origins: keep });
      setOrigins(res.allowed_origins);
      setPending(res.pending_origins);
      setDraft('');
      setSaved(message);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function add() {
    const v = draft.trim();
    if (!v || !origins) return;
    save([...origins, /^https?:\/\//i.test(v) ? v : `https://${v}`]);
  }

  const others = (o: string) => pending.map((x) => x.origin).filter((x) => x !== o);

  return (
    <SettingsPage
      title="Embed domains"
      description={<>
        Websites allowed to embed forms and booking pages with the snippet from their record page. Enter each address
        separately: <code>https://example.com</code> and <code>https://www.example.com</code> are different websites.
      </>}
    >
      {origins && pending.length > 0 && (
        <SettingsSection
          title="Waiting for approval"
          description="Added from outside the CRM, such as by an AI connected to it. Forms and booking pages only work on these websites once you allow them."
          className={review === 'pending' ? 'reviewing' : undefined}
        >
          <ul className="origin-list" id="review-pending">
            {pending.map((x) => (
              <li key={x.origin}>
                <Globe size={14} className="lead" />
                <span className="origin-main">
                  <span>{x.origin}</span>
                  <span className="muted small">{x.requested_via ? `Added by ${x.requested_via}` : 'Added outside the CRM'}, {new Date(x.requested_at).toLocaleString()}</span>
                </span>
                <span className="push-right row-actions-inner">
                  <button className="btn small primary" onClick={() => save([...origins, x.origin], others(x.origin), `${x.origin} allowed.`)}>Allow</button>
                  <button className="btn small ghost" onClick={() => save(origins, others(x.origin), `${x.origin} dismissed.`)}>Dismiss</button>
                </span>
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}
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
                  onClick={async () => { if (await confirmDialog('Forms and booking pages embedded there stop working.', { title: `Remove ${o}?`, confirmLabel: 'Remove', danger: true })) save(origins.filter((x) => x !== o)); }}>
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
  group_id: string | null;
  items: NavItem[];
  bottom_left: 'menu' | 'home';
  bottom: NavItem[];
}

const BOTTOM_MAX = 3;

interface UserOption {
  id: string;
  name: string;
}

export interface NavGroup {
  id: string;
  name: string;
  members_can_customize: boolean;
  members: string[];
}

interface MenuSnapshot { items: NavItem[]; bottom_left: 'menu' | 'home'; bottom: NavItem[] }

function itemLabel(item: NavItem, objectLabel: (o: string) => string, viewName: (o: string, id: number) => string, customViewName: (slug: string) => string): string {
  switch (item.type) {
    case 'home': return 'Home';
    case 'custom_view': return item.label ?? customViewName(item.slug);
    case 'card_scanner': return item.label ?? 'Card scanner';
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

// A list in the menu editor: the sidebar's top level, a section (its index in the top level) or the mobile hotbar.
type ListKey = 'top' | 'bottom' | number;
interface Spot { list: ListKey; index: number }

// moves list[from] so it lands before what is now list[to] (to = length: the end)
function moveWithin<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, x);
  return next;
}

// moves a sidebar item between the top level and sections (never a section into a section; the caller checks)
function moveNav(all: NavItem[], from: Spot, to: Spot): NavItem[] {
  if (from.list === to.list) {
    if (from.list === 'top') return moveWithin(all, from.index, to.index);
    return all.map((it, i) => (i === from.list && it.type === 'section' ? { ...it, items: moveWithin(it.items, from.index, to.index) } : it));
  }
  let item: NavItem | undefined;
  let next: NavItem[];
  if (from.list === 'top') {
    item = all[from.index];
    next = all.filter((_, i) => i !== from.index);
  } else {
    next = all.map((it, i) => {
      if (i !== from.list || it.type !== 'section') return it;
      item = it.items[from.index];
      return { ...it, items: it.items.filter((_, j) => j !== from.index) };
    });
  }
  const moved = item;
  if (!moved) return all;
  if (to.list === 'top') {
    next.splice(to.index, 0, moved);
    return next;
  }
  // taking an item out of the top level above the section shifts the section up one
  const section = from.list === 'top' && from.index < (to.list as number) ? (to.list as number) - 1 : to.list;
  return next.map((it, i) => (i === section && it.type === 'section' ? { ...it, items: [...it.items.slice(0, to.index), moved, ...it.items.slice(to.index)] } : it));
}

// Targets: 'me' (the signed-in user's own menu, where the editor opens), 'default' (everyone not in a
// group), 'group:<id>' and 'user:<id>'. Users who are not admins only get 'me'.
function NavSettings() {
  const { me, objects, objectByName, reloadNav, customViews } = useApp();
  const navigate = useNavigate();
  const isAdmin = me.is_admin;
  const myId = me.user?.id ?? null;
  const [target, setTarget] = useState<string>(myId ? 'me' : 'default');
  const [menus, setMenus] = useState<Menu[]>([]);
  const [groups, setGroups] = useState<NavGroup[]>([]);
  const [everyoneCan, setEveryoneCan] = useState(false);
  // for users who are not admins: which menu they see now (their own, their group's or the default)
  const [mySource, setMySource] = useState<'default' | 'group' | 'user'>('default');
  const [copyOpen, setCopyOpen] = useState(false);
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
  // which + Add picker is open, under the sidebar or under the hotbar
  const [picker, setPicker] = useState<'sidebar' | 'bottom' | null>(null);
  // a short note by the hotbar's + Add when it is clicked with the hotbar full
  const [fullNote, setFullNote] = useState(false);
  const fullNoteTimer = useRef<number | undefined>(undefined);
  // the row being dragged and where it would land
  const dragFrom = useRef<Spot | null>(null);
  const [dropAt, setDropAt] = useState<Spot | null>(null);
  // with unsaved changes: the page or menu the admin asked to go to, held until they discard or keep editing
  const [leaving, setLeaving] = useState<{ to: string } | { target: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMenus() {
    const res = await api<{ results: Menu[]; groups: NavGroup[]; everyone_can_customize: boolean }>('GET', '/v1/ui/nav/menus');
    setMenus(res.results);
    setGroups(res.groups);
    setEveryoneCan(res.everyone_can_customize);
    return res;
  }

  // a user who is not an admin reads only the menu they see now
  async function loadMine() {
    const res = await api<MenuSnapshot & { source: 'default' | 'group' | 'user' }>('GET', '/v1/ui/nav');
    setMySource(res.source);
    showMenu(res);
  }

  // the menu a target sees: a user's own, else their group's, else the default
  function menuFor(t: string, ms = menus, gs = groups): Menu | undefined {
    const def = ms.find((m) => m.scope === 'default');
    const groupMenu = (id: string) => ms.find((m) => m.scope === 'group' && String(m.group_id) === String(id));
    if (t === 'default') return def;
    if (t.startsWith('group:')) return groupMenu(t.slice(6));
    const uid = t === 'me' ? myId : t.slice(5);
    const own = ms.find((m) => m.scope === 'user' && m.user_id === uid);
    if (own) return own;
    const g = gs.find((x) => uid !== null && x.members.includes(uid));
    return (g && groupMenu(g.id)) || def;
  }

  useEffect(() => {
    if (!isAdmin) {
      loadMine().then(() => setLoaded(true));
      return;
    }
    loadMenus().then((r) => { showMenu(menuFor(target, r.results, r.groups)); setLoaded(true); });
    api<SearchResult>('POST', '/v1/objects/users/search', { limit: 200, properties: ['name', 'first_name', 'last_name', 'email'], sorts: [{ property: 'name', direction: 'asc' }] })
      .then((r) => setUsers(r.results.map((u) => ({ id: u.id, name: displayName(u.properties, u.id) }))))
      .catch(() => undefined);
  }, []);

  function showMenu(m: MenuSnapshot | undefined) {
    const next = { items: m?.items ?? [], bottomLeft: m?.bottom_left ?? 'menu', bottom: m?.bottom ?? [] };
    setItems(next.items);
    setBottomLeft(next.bottomLeft);
    setBottom(next.bottom);
    setSavedJson(JSON.stringify(next));
  }

  const dirty = loaded && JSON.stringify({ items, bottomLeft, bottom }) !== savedJson;

  // With unsaved changes, a click on a link to another page asks first (the same dialog as closing a property),
  // and closing or reloading the tab gets the browser's own warning.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaving({ to: url.pathname + url.search + url.hash });
    };
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty]);

  function discard() {
    const l = leaving;
    setLeaving(null);
    if (!l) return;
    if ('to' in l) {
      setSavedJson(JSON.stringify({ items, bottomLeft, bottom }));
      navigate(l.to);
    } else showTarget(l.target);
  }

  function pickTarget(t: string) {
    if (dirty) setLeaving({ target: t });
    else showTarget(t);
  }

  function showTarget(t: string) {
    setTarget(t);
    setMessage(null);
    setError(null);
    showMenu(menuFor(t));
  }

  // fills the editor with a copy of another menu; nothing is saved until Save menu
  function copyFrom(source: string) {
    const m = menuFor(source);
    if (!m) return;
    setItems(m.items);
    setBottomLeft(m.bottom_left);
    setBottom(m.bottom);
    setCopyOpen(false);
    setError(null);
    setMessage(null);
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
    } else if (adding.type === 'card_scanner') {
      item = { type: 'card_scanner', ...(adding.label ? { label: adding.label } : {}) };
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
    setPicker(null);
  }

  function openPicker(where: 'sidebar' | 'bottom') {
    setError(null);
    // dividers and sections cannot go in the hotbar, nor Home (that is the Left button setting)
    setAdding((a) => ({
      ...a,
      section: where === 'bottom' ? 'bottom' : null,
      type: where === 'bottom' && (a.type === 'divider' || a.type === 'section' || a.type === 'home') ? 'object' : a.type,
      label: ''
    }));
    setPicker(where);
  }

  const listOf = (key: ListKey): NavItem[] => {
    if (key === 'bottom') return bottom;
    if (key === 'top') return items;
    const s = items[key];
    return s?.type === 'section' ? s.items : [];
  };

  // whether the dragged row may land in a list: the hotbar and the sidebar stay apart, and sections do not nest
  function canDrop(to: ListKey) {
    const from = dragFrom.current;
    if (!from) return false;
    if ((from.list === 'bottom') !== (to === 'bottom')) return false;
    return !(typeof to === 'number' && listOf(from.list)[from.index]?.type === 'section');
  }

  function dragOverRow(e: DragEvent<HTMLDivElement>, list: ListKey, i: number, it: NavItem) {
    if (!dragFrom.current) return;
    e.stopPropagation();
    // measure against the row's own line, not a section's links under it
    const head = (e.currentTarget.querySelector('.nav-edit-label') as HTMLElement).getBoundingClientRect();
    const below = e.clientY >= head.top + head.height / 2;
    // the lower half of a section's heading drops into the section, at its top
    if (it.type === 'section' && list === 'top' && below && canDrop(i)) {
      e.preventDefault();
      setDropAt({ list: i, index: 0 });
      return;
    }
    if (!canDrop(list)) return;
    e.preventDefault();
    setDropAt({ list, index: below ? i + 1 : i });
  }

  function drop() {
    const from = dragFrom.current;
    const to = dropAt;
    dragFrom.current = null;
    setDropAt(null);
    if (!from || !to) return;
    if (from.list === 'bottom') setBottom((l) => moveWithin(l, from.index, to.index));
    else setItems((all) => moveNav(all, from, to));
  }

  async function save() {
    setError(null);
    const body = { items, bottom_left: bottomLeft, bottom };
    try {
      if (target === 'me') await api('PUT', '/v1/ui/nav/me', body);
      else if (target === 'default') await api('PUT', '/v1/ui/nav/default', body);
      else if (target.startsWith('group:')) await api('PUT', `/v1/ui/nav/groups/${target.slice(6)}/menu`, body);
      else await api('PUT', `/v1/ui/nav/users/${target.slice(5)}`, body);
      if (isAdmin) await loadMenus();
      else setMySource('user');
      await reloadNav();
      setSavedJson(JSON.stringify({ items, bottomLeft, bottom }));
      setMessage('Menu saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetUser() {
    setError(null);
    try {
      await api('DELETE', target === 'me' ? '/v1/ui/nav/me' : `/v1/ui/nav/users/${target.slice(5)}`);
      if (isAdmin) {
        const r = await loadMenus();
        showMenu(menuFor(target, r.results, r.groups));
      } else await loadMine();
      await reloadNav();
      setMessage(`${target === 'me' ? 'You now see' : 'This user now sees'} the ${fallbackName} menu.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const userOf = (t: string) => (t === 'me' ? myId : t.startsWith('user:') ? t.slice(5) : null);
  const targetUser = userOf(target);
  const groupOfUser = (uid: string | null) => (uid ? groups.find((g) => g.members.includes(uid)) : undefined);
  const hasOwn = target === 'me' && !isAdmin ? mySource === 'user' : targetUser !== null && menus.some((m) => m.scope === 'user' && m.user_id === targetUser);
  // what a user without their own menu sees: their group's menu or the default
  const fallbackGroup = groupOfUser(targetUser);
  const fallbackName = !isAdmin ? 'shared' : fallbackGroup ? `"${fallbackGroup.name}" group` : 'default';
  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  const targetLabel = (t: string) => {
    if (t === 'me') return 'My menu (just me)';
    if (t === 'default') return 'Default (everyone not in a group)';
    if (t.startsWith('group:')) return `Group: ${groups.find((g) => String(g.id) === t.slice(6))?.name ?? t.slice(6)}`;
    return userName(t.slice(5));
  };
  // when the editor opens on someone in a group that does not allow their own menu (Super Admins are exempt)
  const lockedGroup = target.startsWith('user:') && fallbackGroup && !fallbackGroup.members_can_customize ? fallbackGroup : undefined;

  // menus to copy from (Copy from, and a new group's starting menu)
  const menuSources = [
    ...(myId ? [{ value: 'me', label: 'My menu' }] : []),
    { value: 'default', label: 'Default (everyone not in a group)' },
    ...groups.map((g) => ({ value: `group:${g.id}`, label: `Group: ${g.name}` })),
    ...users.filter((u) => u.id !== myId).map((u) => ({ value: `user:${u.id}`, label: u.name }))
  ];

  function sidebarDescription(): string {
    if (target === 'me') {
      if (hasOwn) return 'Your own menu. Only you see it.';
      return isAdmin
        ? `You see the ${fallbackName} menu now. Saving makes your own copy that only you see.`
        : 'You see the shared menu now. Saving makes your own copy that only you see.';
    }
    if (target === 'default') return 'Shown to everyone who is not in a group and has no menu of their own.';
    if (target.startsWith('group:')) {
      const g = groups.find((x) => String(x.id) === target.slice(6));
      const n = g?.members.length ?? 0;
      return `Shown to the ${n} ${n === 1 ? 'member' : 'members'} of this group${g?.members_can_customize ? ' who have not made their own menu' : ''}.`;
    }
    if (lockedGroup) return `This user is in "${lockedGroup.name}", which does not let members have their own menu, so they see the group's menu unless they are a Super Admin.`;
    return hasOwn ? 'This user has their own menu.' : `This user sees the ${fallbackName} menu. Saving creates their own copy.`;
  }

  const row = (it: NavItem, i: number, list: NavItem[], listKey: ListKey, change: (fn: (l: NavItem[]) => NavItem[]) => void, child: boolean, children?: ReactNode) => {
    const label = itemLabel(it, objectLabel, viewName, customViewName);
    const kind = itemKind(it);
    const dropHere = dropAt?.list === listKey;
    return (
      <div
        key={i}
        className={`nav-edit-row ${it.type}${child ? ' child' : ''}${dropHere && dropAt.index === i ? ' drop-before' : ''}${dropHere && dropAt.index === list.length && i === list.length - 1 ? ' drop-after' : ''}`}
        onDragOver={(e) => dragOverRow(e, listKey, i, it)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(); }}
      >
        <span
          className="nav-grip"
          draggable
          title="Drag to reorder"
          onDragStart={(e) => {
            e.stopPropagation();
            dragFrom.current = { list: listKey, index: i };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', label);
            e.dataTransfer.setDragImage(e.currentTarget.parentElement!, 12, 12);
          }}
          onDragEnd={() => { dragFrom.current = null; setDropAt(null); }}
        >
          <GripVertical size={14} />
        </span>
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

  const renderList = (list: NavItem[], section: number | null): ReactNode[] =>
    list.map((it, i) => row(it, i, list, section ?? 'top', (fn) => update(section, fn), section !== null,
      it.type === 'section' && section === null ? (
        <div
          className={`nav-edit-children${dropAt?.list === i && it.items.length === 0 ? ' drop-into' : ''}`}
          // over the gaps or an empty section (rows inside handle their own)
          onDragOver={(e) => {
            if (!dragFrom.current) return;
            e.stopPropagation();
            if (!canDrop(i)) return;
            e.preventDefault();
            setDropAt({ list: i, index: it.items.length });
          }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(); }}
        >
          {renderList(it.items, i)}
        </div>
      ) : undefined));

  const addButton = (where: 'sidebar' | 'bottom') => {
    const full = where === 'bottom' && bottom.length >= BOTTOM_MAX && picker !== where;
    // a full hotbar's button stays clickable (looking disabled) so a click can say why nothing opens
    return (
      <span className="nav-add-btn">
        <button
          type="button"
          className={`btn small${full ? ' looks-disabled' : ''}`}
          aria-expanded={picker === where}
          aria-disabled={full || undefined}
          onClick={() => {
            if (full) {
              setFullNote(true);
              window.clearTimeout(fullNoteTimer.current);
              fullNoteTimer.current = window.setTimeout(() => setFullNote(false), 3000);
            } else if (picker === where) setPicker(null);
            else openPicker(where);
          }}
        >
          <Plus size={14} /> Add
        </button>
        {full && fullNote && <span className="nav-add-note" role="status">Max {BOTTOM_MAX} links. Remove one to add another.</span>}
      </span>
    );
  };

  // the selector under a menu's + Add: what to add and, in the sidebar, where
  const addPicker = (where: 'sidebar' | 'bottom') => picker === where && (
    <div className="nav-add">
      {where === 'sidebar' && items.some((it) => it.type === 'section') && (
        <label className="field">
          <span>Where</span>
          <Select
            value={adding.section === null || adding.section === 'bottom' ? '' : adding.section}
            onChange={(v) => {
              const section = v === '' ? null : Number(v);
              setAdding((a) => ({ ...a, section, type: section !== null && a.type === 'section' ? 'object' : a.type }));
            }}
          >
            <option value="">Top level</option>
            {items.map((it, i) => it.type === 'section' && <option key={i} value={i}>In section "{it.label}"</option>)}
          </Select>
        </label>
      )}
      <label className="field">
        <span>Type</span>
        <Select value={adding.type} onChange={(v) => setAdding((a) => ({ ...a, type: v, view: '' }))}>
          <option value="object">Object</option>
          <option value="view">Saved view</option>
          <option value="custom_view">Custom view</option>
          <option value="card_scanner">Card scanner</option>
          {where !== 'bottom' && <option value="divider">Divider</option>}
          {adding.section === null && <option value="section">Section</option>}
          {where !== 'bottom' && <option value="home">Home</option>}
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
      {(adding.type === 'section' || adding.type === 'view' || adding.type === 'custom_view' || adding.type === 'card_scanner') && (
        <label className="field">
          <span>{adding.type === 'section' ? 'Section name' : 'Label (optional)'}</span>
          <input value={adding.label} maxLength={63} onChange={(e) => setAdding((a) => ({ ...a, label: e.target.value }))} />
        </label>
      )}
      <div className="nav-add-actions">
        <button className="btn" onClick={() => setPicker(null)}>Cancel</button>
        <button className="btn primary" onClick={add}><Plus size={14} /> Add</button>
      </div>
    </div>
  );


  return (
    <SettingsPage
      title={isAdmin ? 'Navigation menus' : 'Your menu'}
      description={isAdmin
        ? 'You start on your own menu, which only you see. Pick Default, a group or a user to edit theirs. Groups below decide who sees which menu.'
        : 'Your own sidebar and mobile hotbar. Only you see them.'}
      actions={isAdmin && (
        <>
          <Select value={target} onChange={(v) => pickTarget(v)} aria-label="Menu to edit">
            {myId && <option value="me">My menu (just me)</option>}
            <option value="default">Default (everyone not in a group)</option>
            {groups.map((g) => <option key={g.id} value={`group:${g.id}`}>Group: {g.name}</option>)}
            {users.filter((u) => u.id !== myId).map((u) => {
              const own = menus.some((m) => m.scope === 'user' && m.user_id === u.id);
              const g = groupOfUser(u.id);
              const notes = [own && 'own menu', g && `in ${g.name}`].filter(Boolean).join(', ');
              return <option key={u.id} value={`user:${u.id}`}>{u.name}{notes ? ` (${notes})` : ''}</option>;
            })}
          </Select>
          <button className="btn" onClick={() => setCopyOpen(true)} disabled={!loaded}><Copy size={14} /> Copy from</button>
        </>
      )}
    >
      <SettingsSection title="Sidebar" description={sidebarDescription()}>
        {!loaded ? <TableSkeleton rows={5} /> : items.length === 0
          ? <EmptyState icon={<PanelLeft size={18} />} title="This menu is empty">Add objects, views and sections with + Add.</EmptyState>
          : <div className="nav-tree">{renderList(items, null)}</div>}
        {loaded && addButton('sidebar')}
        {addPicker('sidebar')}
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
          <SettingRow label="Links">
            {bottom.length === 0 ? <span className="muted">No links between the left button and Search.</span> : (
              <div className="nav-tree stretch">
                {bottom.map((it, i) => row(it, i, bottom, 'bottom', (fn) => setBottom(fn), false))}
              </div>
            )}
            {addButton('bottom')}
            {addPicker('bottom')}
          </SettingRow>
        </div>
      </SettingsSection>

      {isAdmin && loaded && (
        <NavGroups
          groups={groups}
          users={users}
          myId={myId}
          everyoneCan={everyoneCan}
          menuSources={menuSources}
          onChanged={async () => { await loadMenus(); await reloadNav(); }}
          onEditMenu={(t) => { pickTarget(t); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
        />
      )}

      <SaveBar dirty={dirty} message={message} error={error}>
        {hasOwn && <button className="btn" onClick={resetUser}>Reset to {fallbackName} menu</button>}
        <button className="btn primary" onClick={save}>Save menu</button>
      </SaveBar>

      {copyOpen && (
        <CopyMenuModal
          sources={menuSources.filter((x) => x.value !== target)}
          into={targetLabel(target)}
          onCopy={copyFrom}
          onClose={() => setCopyOpen(false)}
        />
      )}

      {leaving && (
        <Modal
          className="discard-confirm"
          title="Discard your changes?"
          onClose={() => setLeaving(null)}
          footer={
            <>
              <button className="btn" onClick={() => setLeaving(null)} autoFocus>Keep editing</button>
              <button className="btn danger" onClick={discard}>Discard</button>
            </>
          }
        >
          <p>{'to' in leaving ? 'Leaving now loses' : 'Switching menus now loses'} any changes you haven't saved to this menu.</p>
        </Modal>
      )}
    </SettingsPage>
  );
}

interface MenuSource { value: string; label: string }

function CopyMenuModal({ sources, into, onCopy, onClose }: { sources: MenuSource[]; into: string; onCopy: (source: string) => void; onClose: () => void }) {
  const [from, setFrom] = useState(sources[0]?.value ?? '');
  return (
    <Modal
      title="Copy a menu"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onCopy(from)} disabled={!from}><Copy size={14} /> Copy</button>
        </>
      }
    >
      <label className="field">
        <span>Copy from</span>
        <Select value={from} onChange={setFrom} aria-label="Menu to copy from">
          {sources.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </Select>
      </label>
      <p className="muted small">
        Replaces the sidebar and mobile hotbar of {into} with a copy. For a user without their own menu, this copies the menu they see now.
        Nothing is saved until you click Save menu.
      </p>
    </Modal>
  );
}

// Menu groups: who sees which menu. A user is in at most one group; each group decides whether its members
// may change their own menu (Super Admins always may). Changes here save right away.
function NavGroups({ groups, users, myId, everyoneCan, menuSources, onChanged, onEditMenu }: {
  groups: NavGroup[];
  users: UserOption[];
  myId: string | null;
  everyoneCan: boolean;
  menuSources: MenuSource[];
  onChanged: () => Promise<void>;
  onEditMenu: (target: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<NavGroup | null>(null);
  const [editingMembers, setEditingMembers] = useState<NavGroup | null>(null);
  const grouped = new Set(groups.flatMap((g) => g.members));
  const ungrouped = users.filter((u) => !grouped.has(u.id)).length;
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? id;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function memberSummary(ids: string[]) {
    if (ids.length === 0) return <span className="muted small">No members</span>;
    const names = ids.map((id) => (id === myId ? 'You' : nameOf(id)));
    return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  }

  return (
    <SettingsSection
      title="Menu groups"
      description="Members of a group see the group's menu. Each person can be in one group. Super Admins may always change their own menu, even in a group that does not allow it."
      actions={<button className="btn small" onClick={() => setCreating(true)}><Plus size={14} /> New group</button>}
    >
      {error && <div className="error">{error}</div>}
      <div className="access-table nav-groups">
        <table className="grid">
          <thead>
            <tr><th>Group</th><th>Members</th><th>Members can change their own menu</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            <tr>
              <td className="primary-cell">Everyone else <span className="muted small">(default menu)</span></td>
              <td>{ungrouped} {ungrouped === 1 ? 'user' : 'users'} in no group</td>
              <td>
                <label className="nav-group-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={everyoneCan}
                    aria-label="Users in no group can change their own menu"
                    onChange={(e) => run(() => api('PUT', '/v1/ui/nav/access', { everyone_can_customize: e.target.checked }))}
                  />
                  {everyoneCan ? 'On' : 'Off'}
                </label>
              </td>
              <td className="row-actions">
                <span className="row-actions-inner"><button className="btn small" onClick={() => onEditMenu('default')}>Edit menu</button></span>
              </td>
            </tr>
            {groups.map((g) => (
              <tr key={g.id}>
                <td className="primary-cell">{g.name}</td>
                <td className="wrap">{memberSummary(g.members)}</td>
                <td>
                  <label className="nav-group-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={g.members_can_customize}
                      aria-label={`Members of ${g.name} can change their own menu`}
                      onChange={(e) => run(() => api('PATCH', `/v1/ui/nav/groups/${g.id}`, { members_can_customize: e.target.checked }))}
                    />
                    {g.members_can_customize ? 'On' : 'Off'}
                  </label>
                </td>
                <td className="row-actions">
                  <span className="row-actions-inner">
                  <button className="btn small" onClick={() => onEditMenu(`group:${g.id}`)}>Edit menu</button>
                  <button className="btn small" onClick={() => setEditingMembers(g)}><Users size={14} /> Members</button>
                  <button className="btn small" onClick={() => setRenaming(g)}>Rename</button>
                  <button
                    className="icon-btn"
                    aria-label={`Delete ${g.name}`}
                    onClick={async () => {
                      if (await confirmDialog('Its members go back to the default menu (or their own, if they have one and are allowed).', { title: `Delete the group "${g.name}"?`, confirmLabel: 'Delete', danger: true })) {
                        run(() => api('DELETE', `/v1/ui/nav/groups/${g.id}`));
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <GroupModal
          title="New group"
          menuSources={menuSources}
          onClose={() => setCreating(false)}
          onSave={async (b) => {
            await api('POST', '/v1/ui/nav/groups', b);
            setCreating(false);
            await onChanged();
          }}
        />
      )}
      {renaming && (
        <GroupModal
          title={`Rename ${renaming.name}`}
          initialName={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (b) => {
            await api('PATCH', `/v1/ui/nav/groups/${renaming.id}`, { name: b.name });
            setRenaming(null);
            await onChanged();
          }}
        />
      )}
      {editingMembers && (
        <MembersModal
          group={editingMembers}
          groups={groups}
          users={users}
          myId={myId}
          onClose={() => setEditingMembers(null)}
          onSave={async (ids) => {
            await api('PUT', `/v1/ui/nav/groups/${editingMembers.id}/members`, { user_ids: ids });
            setEditingMembers(null);
            await onChanged();
          }}
        />
      )}
    </SettingsSection>
  );
}

// New group (name, starting menu, the switch) or rename (name only, when menuSources is left out)
function GroupModal({ title, initialName = '', menuSources, onSave, onClose }: {
  title: string;
  initialName?: string;
  menuSources?: MenuSource[];
  onSave: (b: { name: string; copy_from?: string; members_can_customize?: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [copy, setCopy] = useState('default');
  const [can, setCan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(menuSources ? { name: name.trim(), copy_from: copy, members_can_customize: can } : { name: name.trim() });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !name.trim()}>{menuSources ? 'Create group' : 'Save'}</button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={63} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </label>
      {menuSources && (
        <>
          <label className="field">
            <span>Start with a copy of</span>
            <Select value={copy} onChange={setCopy} aria-label="Menu to start from">
              {menuSources.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </Select>
          </label>
          <label className="nav-group-switch">
            <input type="checkbox" role="switch" checked={can} onChange={(e) => setCan(e.target.checked)} />
            Members can change their own menu
          </label>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

function MembersModal({ group, groups, users, myId, onSave, onClose }: {
  group: NavGroup;
  groups: NavGroup[];
  users: UserOption[];
  myId: string | null;
  onSave: (ids: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set(group.members));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const otherGroup = (id: string) => groups.find((g) => g.id !== group.id && g.members.includes(id));
  const q = query.trim().toLowerCase();
  const shown = users.filter((u) => !q || u.name.toLowerCase().includes(q));
  const moving = [...picked].filter((id) => otherGroup(id)).length;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSave([...picked]);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Members of ${group.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small push-right-note">{picked.size} {picked.size === 1 ? 'member' : 'members'}{moving ? `, ${moving} moving from another group` : ''}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>Save members</button>
        </>
      }
    >
      <p className="muted small">Each person can be in one group. Turning on someone who is in another group moves them here.</p>
      <div className="nav-members-search">
        <Search size={14} />
        <input value={query} placeholder="Search users" aria-label="Search users" onChange={(e) => setQuery(e.target.value)} autoFocus />
      </div>
      <div className="nav-members">
        {shown.length === 0 && <div className="muted small">No users match.</div>}
        {shown.map((u) => {
          const other = otherGroup(u.id);
          return (
            <label key={u.id} className="nav-member">
              <input
                type="checkbox"
                role="switch"
                checked={picked.has(u.id)}
                onChange={(e) => setPicked((s) => {
                  const next = new Set(s);
                  if (e.target.checked) next.add(u.id);
                  else next.delete(u.id);
                  return next;
                })}
              />
              <span className="nav-member-name">{u.name}{u.id === myId ? ' (you)' : ''}</span>
              {other && <span className="muted small">{picked.has(u.id) ? `Moves from ${other.name}` : `In ${other.name}`}</span>}
            </label>
          );
        })}
      </div>
      {error && <div className="error">{error}</div>}
    </Modal>
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
