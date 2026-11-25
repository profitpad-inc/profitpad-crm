import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Menu as MenuIcon, Search, Copy, ArrowDown, ArrowUp, Boxes, Cable, CalendarDays, Coins, CreditCard, Globe, GripVertical, IdCard, KeyRound, Palette, PanelLeft, Plug, Plus, ScrollText,
  BellRing, Folder, Hash, Mail, MapPin, ShieldCheck, SlidersHorizontal, Trash2, Upload, User, Users, Webhook
} from 'lucide-react';
import { BrandMark } from '../components/Logo';
import { api, can, type CrmRecord, type NavItem, type RolePermission, type SearchResult, type View } from '../lib/api';
import { useApp, type Themes } from '../lib/app-context';
import { ColorInput } from '../components/ColorPicker';
import { EmptyState, SaveBar, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton, useReview } from '../components/settings';
import { SaveHint } from '../components/SaveHint';
import { useDirty } from '../lib/use-dirty';
import { DEFAULT_DARK_THEME, DEFAULT_THEME, THEME_FIELDS, defaultDropdownColors, dropdownColorName, type ColorMode, type Mode, type Theme, type ThemeKey } from '../lib/theme';
import { MORE_OFF, displayName, moreGroups, objectIcon } from '../lib/display';
import { UserAvatar, refreshUserPhotos } from '../components/UserAvatar';
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
import { ImportHistory } from './ImportHistory';
import { OptionListSettings } from './OptionListSettings';
import { AssociationLabelSettings } from './AssociationLabelSettings';
import { AddressSettings } from './AddressSettings';
import { EmailSettings } from './EmailSettings';
import { BookOpen, History, ListChecks, Send, Tags, Video } from 'lucide-react';
import { SnippetSettings } from './SnippetSettings';
import { KnowledgeSettings } from './KnowledgeSettings';
import { MailboxSettings } from './MailboxSettings';
import { MeetingSettings } from './MeetingSettings';
import { NotificationEmailSettings } from './NotificationEmailSettings';
import { Select } from '../components/Select';
import { Modal } from '../components/ui';
import { IconPicker } from '../components/IconPicker';
import { HtmlEditorModal, HtmlValue } from '../components/HtmlEditor';
import '../settings.css';
import { confirmDialog } from '../components/confirm';

// who sees a page: everyone, signed-in users (not bare API keys), Super
// Admins, those who may edit a menu (admins, and users allowed to change their
// own), or those whose role has one of the listed permissions
type Gate = 'all' | 'user' | 'admin' | 'nav' | 'knowledge' | RolePermission[];
interface SettingsLink { path: string; label: string; icon: ReactNode; gate: Gate; element: ReactNode }

const GROUPS: { label: string; links: SettingsLink[] }[] = [
  { label: 'Your account', links: [
    { path: '', label: 'Account', icon: <User size={16} />, gate: 'all', element: <Account /> },
    { path: 'connected-apps', label: 'Connected apps', icon: <Plug size={16} />, gate: 'all', element: <ConnectedApps /> },
    { path: 'calendars', label: 'Calendars', icon: <CalendarDays size={16} />, gate: 'user', element: <CalendarSettings /> },
    { path: 'snippets', label: 'Snippets', icon: <Hash size={16} />, gate: 'all', element: <SnippetSettings /> }
  ] },
  { label: 'Workspace', links: [
    { path: 'navigation', label: 'Navigation menus', icon: <PanelLeft size={16} />, gate: 'nav', element: <NavSettings /> },
    { path: 'theme', label: 'Theme', icon: <Palette size={16} />, gate: 'admin', element: <ThemeSettings /> },
    { path: 'knowledge', label: 'Knowledge base', icon: <BookOpen size={16} />, gate: 'knowledge', element: <KnowledgeSettings /> },
    { path: 'objects', label: 'Objects', icon: <Boxes size={16} />, gate: 'admin', element: <ObjectSettings /> },
    { path: 'properties', label: 'Properties', icon: <SlidersHorizontal size={16} />, gate: ['properties'], element: <PropertySettings /> },
    { path: 'option-lists', label: 'Option lists', icon: <ListChecks size={16} />, gate: ['properties'], element: <OptionListSettings /> },
    { path: 'association-labels', label: 'Association labels', icon: <Tags size={16} />, gate: ['properties'], element: <AssociationLabelSettings /> },
    { path: 'currencies', label: 'Currencies', icon: <Coins size={16} />, gate: 'admin', element: <CurrencySettings /> },
    { path: 'imports', label: 'Imports and exports', icon: <History size={16} />, gate: 'all', element: <ImportHistory /> }
  ] },
  { label: 'People and access', links: [
    { path: 'users', label: 'Users', icon: <Users size={16} />, gate: ['users', 'roles'], element: <UserSettings /> },
    { path: 'roles', label: 'Roles', icon: <ShieldCheck size={16} />, gate: ['roles'], element: <RoleSettings /> }
  ] },
  { label: 'Integrations', links: [
    { path: 'embed-domains', label: 'Embed domains', icon: <Globe size={16} />, gate: ['integrations'], element: <EmbedDomains /> },
    { path: 'view-integrations', label: 'View integrations', icon: <Cable size={16} />, gate: ['integrations'], element: <IntegrationSettings /> },
    { path: 'webhooks', label: 'Webhooks', icon: <Webhook size={16} />, gate: ['integrations'], element: <WebhookSettings /> },
    { path: 'mailboxes', label: 'Mailboxes', icon: <Mail size={16} />, gate: ['integrations'], element: <MailboxSettings /> },
    { path: 'meetings', label: 'Meetings', icon: <Video size={16} />, gate: ['integrations'], element: <MeetingSettings /> },
    { path: 'notification-emails', label: 'Notification emails', icon: <BellRing size={16} />, gate: ['integrations'], element: <NotificationEmailSettings /> },
    { path: 'payments', label: 'Payments', icon: <CreditCard size={16} />, gate: ['integrations'], element: <PaymentSettings /> },
    { path: 'email', label: 'Email', icon: <Send size={16} />, gate: ['integrations'], element: <EmailSettings /> },
    { path: 'card-scanner', label: 'Card scanner', icon: <IdCard size={16} />, gate: ['integrations'], element: <CardScannerSettings /> },
    { path: 'address-autocomplete', label: 'Address autocomplete', icon: <MapPin size={16} />, gate: ['integrations'], element: <AddressSettings /> }
  ] },
  { label: 'Security', links: [
    { path: 'api-keys', label: 'API keys', icon: <KeyRound size={16} />, gate: ['api_keys'], element: <ApiKeySettings /> },
    { path: 'security-log', label: 'Security log', icon: <ScrollText size={16} />, gate: ['security_log'], element: <SecurityLog /> }
  ] }
];

export function Settings() {
  const { me, navCanEdit } = useApp();
  const allowed = (g: Gate) => g === 'all' || (Array.isArray(g) ? g.some((x) => can(me, x))
    : g === 'user' ? !!me.user : g === 'nav' ? me.is_admin || navCanEdit
    : g === 'knowledge' ? me.is_admin || (me.knowledge_access ?? 'read') !== 'none' : me.is_admin);
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

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match device' }
];

// Your profile photo: an uploaded one, else the Google or Microsoft account's
// (copied at each sign-in), else initials. Uploads are cropped to a centred
// square and shrunk to 256px before sending.
type PhotoState = { photo_url: string | null; photo_source: 'upload' | 'google' | 'microsoft' | null; account_photo: boolean };
const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function photoFromFile(file: File): Promise<string> {
  if (!PHOTO_TYPES.includes(file.type)) throw new Error('Pick a PNG, JPEG, WebP or GIF image.');
  const url = await readFileAsDataUrl(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not open that image.'));
    img.src = url;
  });
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const out = Math.max(1, Math.min(256, side));
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  canvas.getContext('2d')!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
  return canvas.toDataURL('image/jpeg', 0.88);
}

function Account() {
  const { me, signOut, colorMode, setColorMode, toast } = useApp();
  const name = me.user?.name || [me.user?.first_name, me.user?.last_name].filter(Boolean).join(' ') || me.key_name;
  const [photo, setPhoto] = useState<PhotoState>({
    photo_url: me.user?.photo_url ?? null, photo_source: me.user?.photo_source ?? null, account_photo: Boolean(me.user?.account_photo)
  });
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  async function savePhoto(run: () => Promise<PhotoState>, done: string) {
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      setPhoto(await run());
      await refreshUserPhotos();
      toast(done);
    } catch (err) {
      setPhotoError((err as Error).message);
    } finally {
      setPhotoBusy(false);
    }
  }
  const pickPhoto = (file: File | undefined) => {
    if (file) void savePhoto(async () => api<PhotoState>('PUT', '/v1/me/photo', { image: await photoFromFile(file) }), 'Photo saved');
  };
  const removePhoto = () => void savePhoto(() => api<PhotoState>('DELETE', '/v1/me/photo'), 'Photo removed');
  return (
    <SettingsPage title="Account" description="Who you are signed in as and what you can do in this portal.">
      <div className="profile">
        <UserAvatar userId={me.user?.id} name={name} className="person-avatar large" src={me.user ? photo.photo_url ?? null : undefined} />
        <div>
          <h2>{name}</h2>
          {me.user?.email && <div className="muted">{me.user.email}</div>}
          {me.user && (
            <div className="profile-photo-actions">
              <label className={`btn small${photoBusy ? ' disabled' : ''}`}>
                <Upload size={14} /> {photo.photo_source === 'upload' ? 'Change photo' : 'Upload a photo'}
                <input type="file" accept={PHOTO_TYPES.join(',')} hidden disabled={photoBusy} onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {photo.photo_source === 'upload' && (
                <button className="btn small" disabled={photoBusy} onClick={removePhoto}>
                  {photo.account_photo ? 'Use my account photo' : 'Remove photo'}
                </button>
              )}
            </div>
          )}
          {photoError && <div className="error">{photoError}</div>}
        </div>
      </div>
      <div className="setting-rows">
        <SettingRow label="Access" hint={me.is_admin ? 'Admins can change every setting here.' : 'What this sign-in is allowed to do.'}>
          {me.is_admin ? <StatusPill tone="info">Admin</StatusPill> : <span>{me.scopes.join(', ')}</span>}
        </SettingRow>
        <SettingRow label="Appearance" hint="Light or dark, for you on this device. Match device follows your computer or phone.">
          <div className="segmented" role="group" aria-label="Appearance">
            {COLOR_MODES.map((m) => (
              <button key={m.value} type="button" aria-pressed={colorMode === m.value} onClick={() => setColorMode(m.value)}>{m.label}</button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Sign out" hint="Ends this session on this device. Other devices stay signed in.">
          <button className="btn" onClick={signOut}>Sign out</button>
        </SettingRow>
      </div>
      {me.user && <NotificationPrefs />}
      {me.user && <EmailLoggingPrefs />}
      {me.user && <EmailSignature userId={me.user.id} initial={me.user.email_signature ?? null} canWrite={me.is_admin || me.scopes.includes('write') || me.scopes.includes('admin')} />}
    </SettingsPage>
  );
}

// Your own automatic email logging (users.email_autolog, migration 0106),
// through /v1/me/email-logging. Shown only when your sign-in address is on a
// provider set up in Settings, Mailboxes.
interface EmailLogging {
  setting: 'default' | 'all' | 'replies' | 'off';
  mailboxes: { mailbox: string; provider: 'google' | 'microsoft'; org_enabled: boolean; org_default: string; mode: string; last_ok_at: string | null; last_error: string | null; logged_count: number }[];
}
const MODE_LABEL: Record<string, string> = { all: 'All emails with contacts', replies: 'Only replies to logged threads', off: 'Off' };

function EmailLoggingPrefs() {
  const { toast } = useApp();
  const [state, setState] = useState<EmailLogging | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<EmailLogging>('GET', '/v1/me/email-logging').then(setState).catch((e) => setError((e as Error).message));
  }, []);

  if (!state || !state.mailboxes.length) return error ? <div className="error">{error}</div> : null;
  const orgOn = state.mailboxes.some((m) => m.org_enabled);
  const orgDefault = state.mailboxes.find((m) => m.org_enabled)?.org_default ?? 'off';

  async function save(setting: string) {
    setBusy(true);
    setError(null);
    try {
      setState(await api<EmailLogging>('PUT', '/v1/me/email-logging', { setting }));
      toast('Email logging saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Email logging" description="Email you exchange with contacts can be logged to the CRM from your mailbox automatically, on those contacts and their companies. Email among colleagues only is never logged.">
      {error && <div className="error">{error}</div>}
      {!orgOn && <div className="callout">An admin has not turned on automatic logging yet, so nothing is logged for now.</div>}
      <div className="setting-rows">
        <SettingRow label="Log automatically" htmlFor="email-autolog" hint="Only replies to logged threads: an email is logged only when it answers one already in the CRM (one you sent from the CRM, for example).">
          <Select
            id="email-autolog"
            value={state.setting}
            disabled={busy}
            options={[
              { value: 'default', label: `Organization default (${MODE_LABEL[orgDefault] ?? orgDefault})` },
              { value: 'all', label: MODE_LABEL.all },
              { value: 'replies', label: MODE_LABEL.replies },
              { value: 'off', label: MODE_LABEL.off }
            ]}
            onChange={save}
          />
        </SettingRow>
        {state.mailboxes.map((m) => (
          <SettingRow key={m.mailbox} label={m.mailbox} hint={m.last_error ? m.last_error : m.last_ok_at ? `Last checked ${new Date(m.last_ok_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}, ${m.logged_count} logged so far.` : undefined}>
            <span>{MODE_LABEL[m.mode] ?? m.mode}</span>
          </SettingRow>
        ))}
      </div>
    </SettingsSection>
  );
}

// Your own notification settings (users.notify_*, migration 0100), through
// /v1/me/notifications so it works whatever your role allows on users.
// Admins change anyone's on their user record.
type NotifyValue = 'email' | 'off';
const NOTIFY_ROWS: { key: 'notify_mentions' | 'notify_tasks'; label: string; hint: string }[] = [
  { key: 'notify_mentions', label: 'Mentions', hint: 'Someone @mentions you in a note or a comment.' },
  { key: 'notify_tasks', label: 'Tasks assigned', hint: 'A task is assigned to you by someone else.' }
];

function NotificationPrefs() {
  const { toast } = useApp();
  const [prefs, setPrefs] = useState<{ notify_mentions: NotifyValue; notify_tasks: NotifyValue; sender_on: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<typeof prefs>('GET', '/v1/me/notifications').then(setPrefs).catch((e) => setError((e as Error).message));
  }, []);

  async function save(key: string, on: boolean) {
    setBusy(true);
    setError(null);
    try {
      setPrefs(await api<NonNullable<typeof prefs>>('PUT', '/v1/me/notifications', { [key]: on ? 'email' : 'off' }));
      toast(on ? 'Emails turned on.' : 'Emails turned off.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Notifications" description="Which emails the CRM sends you. Admins can change these for you on your user record.">
      {error && <div className="error">{error}</div>}
      {prefs && !prefs.sender_on && <div className="callout">Notification emails are not turned on for this CRM yet, so none are sent for now.</div>}
      {prefs && (
        <div className="setting-rows">
          {NOTIFY_ROWS.map((r) => (
            <SettingRow key={r.key} label={r.label} hint={r.hint}>
              <label><input type="checkbox" role="switch" checked={prefs[r.key] === 'email'} disabled={busy} onChange={(e) => save(r.key, e.target.checked)} /> {prefs[r.key] === 'email' ? 'Email' : 'Off'}</label>
            </SettingRow>
          ))}
        </div>
      )}
    </SettingsSection>
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
  const { themes, setThemes, mode, setPreviewMode, dropdownColors, setDropdownColors, logo, setLogo } = useApp();
  // which palette is being edited; the whole CRM shows it while this page is open
  const [editing, setEditing] = useState<Mode>(mode);
  const [draft, setDraft] = useState<Themes>(themes);
  const [colors, setColors] = useState<string[]>(dropdownColors);
  const [logoDraft, setLogoDraft] = useState<string | null>(logo);
  // what is saved, to tell whether the draft has unsaved changes (the live preview changes `theme` itself)
  const [saved, setSaved] = useState(() => JSON.stringify({ themes, colors: dropdownColors, logo }));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify({ themes: draft, colors, logo: logoDraft }) !== saved;
  const palette = draft[editing];

  useEffect(() => { setPreviewMode(editing); }, [editing, setPreviewMode]);
  useEffect(() => () => setPreviewMode(null), [setPreviewMode]);

  function updateAll(next: Themes) {
    setDraft(next);
    setThemes(next); // live preview
    setMessage(null);
  }

  const update = (next: Theme) => updateAll({ ...draft, [editing]: next });

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
      await api('PUT', '/v1/ui/settings/theme', draft.light);
      await api('PUT', '/v1/ui/settings/theme_dark', draft.dark);
      await api('PUT', '/v1/ui/settings/dropdown_colors', { colors });
      await api('PUT', '/v1/ui/settings/logo', { image: logoDraft });
      setDropdownColors(colors);
      setSaved(JSON.stringify({ themes: draft, colors, logo: logoDraft }));
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
              <span className="logo-field-tile light" title="On the page"><BrandMark src={logoDraft} size={36} /></span>
              <div className="logo-field-actions">
                <label className="btn">
                  <Upload size={14} /> {logoDraft ? 'Change logo' : 'Upload logo'}
                  <input type="file" accept={LOGO_TYPES.join(',')} hidden onChange={(e) => { pickLogo(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {logoDraft && <button className="btn" onClick={() => updateLogo(null)}>Use the CRM logo</button>}
              </div>
            </div>
          </SettingsSection>
          <SettingsSection title="Portal colours" description="Each person picks light or dark in Settings, Account. The CRM shows the palette you are editing while this page is open.">
            <div className="segmented palette-tabs" role="group" aria-label="Palette">
              <button type="button" aria-pressed={editing === 'light'} onClick={() => setEditing('light')}>Light mode</button>
              <button type="button" aria-pressed={editing === 'dark'} onClick={() => setEditing('dark')}>Dark mode</button>
            </div>
            {THEME_GROUPS.map((g) => (
              <div key={g.label} className="color-rows">
                <div className="color-rows-head">{g.label}</div>
                {g.keys.map((k) => (
                  <label key={k} className="color-field">
                    <ColorInput value={palette[k]} onChange={(hex) => update({ ...palette, [k]: hex })} label={label(k)} />
                    <span>{label(k)}</span>
                    <HexInput value={palette[k]} onChange={(hex) => update({ ...palette, [k]: hex })} />
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
        <ThemePreview theme={palette} colors={colors} logo={logoDraft} />
      </div>
      <SaveBar dirty={dirty} message={message} error={error}>
        <button className="btn" onClick={() => { updateAll({ light: DEFAULT_THEME, dark: DEFAULT_DARK_THEME }); setColors(defaultDropdownColors()); updateLogo(null); }}>Reset to defaults</button>
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
  bottom: NavItem[];
  more_hidden?: string[];
}

// items in the mobile hotbar before Search, which is always last; the first is always Menu or Home
const BOTTOM_MAX = 4;
// a hotbar always starts with Menu or Home (the API reads one saved without it with Menu first)
const withLead = (bottom: NavItem[]): NavItem[] => (bottom[0]?.type === 'menu' || bottom[0]?.type === 'home' ? bottom : [{ type: 'menu' }, ...bottom]);

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

interface MenuSnapshot { items: NavItem[]; bottom: NavItem[]; more_hidden?: string[] }

function itemLabel(item: NavItem, objectLabel: (o: string) => string, viewName: (o: string, id: number) => string, customViewName: (slug: string) => string): string {
  switch (item.type) {
    case 'home': return 'Home';
    case 'menu': return 'Menu';
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

// A list in the menu editor: the sidebar's top level ('top'), a sidebar section (its index in the top level),
// the mobile hotbar ('bottom') or a hotbar section ('b:' and its index in the hotbar).
type ListKey = 'top' | 'bottom' | number | `b:${number}`;
interface Spot { list: ListKey; index: number }
type TreeKey = 'top' | number;

const isHotbar = (k: ListKey) => k === 'bottom' || (typeof k === 'string' && k.startsWith('b:'));
// the key within its own tree (sidebar or hotbar), as moveNav takes it
const treeKey = (k: ListKey): TreeKey => (k === 'top' || k === 'bottom' ? 'top' : typeof k === 'number' ? k : Number(k.slice(2)));
// the key of the section at index i of a tree's top level
const sectionKey = (root: 'top' | 'bottom', i: number): ListKey => (root === 'top' ? i : `b:${i}`);
const treeSpot = (s: Spot): { list: TreeKey; index: number } => ({ list: treeKey(s.list), index: s.index });

// moves list[from] so it lands before what is now list[to] (to = length: the end)
function moveWithin<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, x);
  return next;
}

// moves an item between a tree's top level and its sections (never a section into a section; the caller checks)
function moveNav(all: NavItem[], from: { list: TreeKey; index: number }, to: { list: TreeKey; index: number }): NavItem[] {
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

const ITEM_TYPE_LABELS: Record<string, string> = {
  object: 'Object', view: 'Saved view', custom_view: 'Custom view', card_scanner: 'Card scanner',
  divider: 'Divider', section: 'Section', home: 'Home', menu: 'Menu (opens the full menu)'
};

type NavTab = 'sidebar' | 'hotbar' | 'more' | 'groups';
const NAV_TABS: { key: NavTab; label: string }[] = [
  { key: 'sidebar', label: 'Sidebar' },
  { key: 'hotbar', label: 'Mobile hotbar' },
  { key: 'more', label: 'More menu' },
  { key: 'groups', label: 'Menu groups' }
];

// Targets: 'me' (the signed-in user's own menu, where the editor opens), 'default' (everyone not in a
// group), 'group:<id>' and 'user:<id>'. Users who are not admins only get 'me'.
function NavSettings() {
  const { me, objects, objectByName, reloadNav, customViews, setNavPreview } = useApp();
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
  const [bottom, setBottom] = useState<NavItem[]>([]);
  // objects left out of the sidebar's More menu
  const [moreHidden, setMoreHidden] = useState<string[]>([]);
  // the menu as last loaded or saved, to tell whether there are unsaved changes
  const [savedJson, setSavedJson] = useState('');
  const [views, setViews] = useState<Record<string, View[]>>({});
  // where: the list the new item goes into
  const [adding, setAdding] = useState<{ where: ListKey; type: string; object: string; view: string; label: string }>({ where: 'top', type: 'object', object: objects[0]?.api_name ?? '', view: '', label: '' });
  // which + Add picker is open, under the sidebar or under the hotbar
  const [picker, setPicker] = useState<'sidebar' | 'bottom' | null>(null);
  // a short note by the hotbar's + Add when it is clicked with the hotbar full
  const [fullNote, setFullNote] = useState(false);
  const fullNoteTimer = useRef<number | undefined>(undefined);
  // the row being dragged and where it would land
  const dragFrom = useRef<Spot | null>(null);
  const [dropAt, setDropAt] = useState<Spot | null>(null);
  // the top-level section (of the sidebar or the hotbar) whose icon is being picked
  const [iconFor, setIconFor] = useState<{ root: 'top' | 'bottom'; index: number } | null>(null);
  // with unsaved changes: the page or menu the admin asked to go to, held until they discard or keep editing
  const [leaving, setLeaving] = useState<{ to: string } | { target: string } | null>(null);
  // which part of the menu is shown: Sidebar, Mobile hotbar, More menu or (admins) Menu groups; kept in ?tab=
  const [params, setParams] = useSearchParams();
  const tabs = NAV_TABS.filter((t) => t.key !== 'groups' || isAdmin);
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? 'sidebar';
  const setTab = (key: NavTab) => setParams((p) => { const n = new URLSearchParams(p); if (key === 'sidebar') n.delete('tab'); else n.set('tab', key); return n; }, { replace: true });
  const moreOff = moreHidden.includes(MORE_OFF);
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
    const next = { items: m?.items ?? [], bottom: withLead(m?.bottom ?? []), moreHidden: m?.more_hidden ?? [] };
    setItems(next.items);
    setBottom(next.bottom);
    setMoreHidden(next.moreHidden);
    setSavedJson(JSON.stringify(next));
  }

  const dirty = loaded && JSON.stringify({ items, bottom, moreHidden }) !== savedJson;

  // While another menu (Default, a group or a user) is open here, the sidebar and mobile bar show it,
  // unsaved changes included, so the admin sees what those people will see. Leaving the page puts theirs back.
  useEffect(() => {
    if (!loaded || target === 'me') setNavPreview(null);
    else setNavPreview({ label: targetLabel(target), items, bottom, moreHidden });
  }, [loaded, target, items, bottom, moreHidden, groups, users]);
  useEffect(() => () => setNavPreview(null), [setNavPreview]);

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
      setSavedJson(JSON.stringify({ items, bottom, moreHidden }));
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
    setBottom(withLead(m.bottom));
    setMoreHidden(m.more_hidden ?? []);
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

  function updateList(key: ListKey, fn: (list: NavItem[]) => NavItem[]) {
    const set = isHotbar(key) ? setBottom : setItems;
    const at = treeKey(key);
    set((all) => (at === 'top' ? fn(all) : all.map((it, i) => (i === at && it.type === 'section' ? { ...it, items: fn(it.items) } : it))));
  }
  // the hotbar is full when its top level holds BOTTOM_MAX items; its sections still take more
  const hotbarFull = bottom.length >= BOTTOM_MAX;

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
    } else item = { type: adding.type as 'home' | 'divider' | 'menu' };
    if (adding.where === 'bottom' && hotbarFull) {
      setError(`The mobile hotbar holds at most ${BOTTOM_MAX} items before Search.`);
      return;
    }
    setError(null);
    updateList(adding.where, (l) => [...l, item]);
    setAdding((a) => ({ ...a, label: '' }));
    setPicker(null);
  }

  // the item types a list takes: no dividers on the hotbar itself (its Menu or Home is the fixed first row),
  // no sections inside sections
  function typesFor(key: ListKey): string[] {
    const links = ['object', 'view', 'custom_view', 'card_scanner'];
    if (key === 'bottom') return [...links, 'section'];
    if (key === 'top') return [...links, 'divider', 'section', 'home'];
    return [...links, 'divider', 'home'];
  }

  function pickWhere(where: ListKey) {
    setAdding((a) => ({ ...a, where, type: typesFor(where).includes(a.type) ? a.type : 'object' }));
  }

  function openPicker(where: 'sidebar' | 'bottom') {
    setError(null);
    // a full hotbar opens on its first section
    const first = where === 'sidebar' ? 'top' : hotbarFull ? sectionKey('bottom', bottom.findIndex((it) => it.type === 'section')) : 'bottom';
    pickWhere(first);
    setAdding((a) => ({ ...a, label: '' }));
    setPicker(where);
  }

  const listOf = (key: ListKey): NavItem[] => {
    const root = isHotbar(key) ? bottom : items;
    const at = treeKey(key);
    if (at === 'top') return root;
    const s = root[at];
    return s?.type === 'section' ? s.items : [];
  };

  // whether the dragged row may land in a list: the hotbar and the sidebar stay apart, sections do not nest,
  // and a full hotbar takes nothing more from its own sections
  function canDrop(to: ListKey) {
    const from = dragFrom.current;
    if (!from) return false;
    if (isHotbar(from.list) !== isHotbar(to)) return false;
    if (to === 'bottom' && from.list !== 'bottom' && hotbarFull) return false;
    return !(treeKey(to) !== 'top' && listOf(from.list)[from.index]?.type === 'section');
  }

  function dragOverRow(e: DragEvent<HTMLDivElement>, list: ListKey, i: number, it: NavItem) {
    if (!dragFrom.current) return;
    e.stopPropagation();
    // measure against the row's own line, not a section's links under it
    const head = (e.currentTarget.querySelector('.nav-edit-label') as HTMLElement).getBoundingClientRect();
    const below = e.clientY >= head.top + head.height / 2;
    // the lower half of a section's heading drops into the section, at its top
    if (it.type === 'section' && (list === 'top' || list === 'bottom') && below && canDrop(sectionKey(list, i))) {
      e.preventDefault();
      setDropAt({ list: sectionKey(list, i), index: 0 });
      return;
    }
    if (!canDrop(list)) return;
    e.preventDefault();
    // nothing goes before the hotbar's fixed Menu or Home
    setDropAt({ list, index: Math.max(below ? i + 1 : i, list === 'bottom' ? 1 : 0) });
  }

  function drop() {
    const from = dragFrom.current;
    const to = dropAt;
    dragFrom.current = null;
    setDropAt(null);
    if (!from || !to) return;
    (isHotbar(from.list) ? setBottom : setItems)((all) => moveNav(all, treeSpot(from), treeSpot(to)));
  }

  async function save() {
    setError(null);
    const body = { items, bottom, more_hidden: moreHidden };
    try {
      if (target === 'me') await api('PUT', '/v1/ui/nav/me', body);
      else if (target === 'default') await api('PUT', '/v1/ui/nav/default', body);
      else if (target.startsWith('group:')) await api('PUT', `/v1/ui/nav/groups/${target.slice(6)}/menu`, body);
      else await api('PUT', `/v1/ui/nav/users/${target.slice(5)}`, body);
      if (isAdmin) await loadMenus();
      else setMySource('user');
      await reloadNav();
      setSavedJson(JSON.stringify({ items, bottom, moreHidden }));
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
    // the hotbar's first row is fixed: Menu or Home, picked here, never moved or removed
    const lead = listKey === 'bottom' && i === 0;
    return (
      <div
        key={i}
        className={`nav-edit-row is-${it.type}${child ? ' child' : ''}${dropHere && dropAt.index === i ? ' drop-before' : ''}${dropHere && dropAt.index === list.length && i === list.length - 1 ? ' drop-after' : ''}`}
        onDragOver={(e) => dragOverRow(e, listKey, i, it)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(); }}
      >
        {lead ? <span className="nav-grip fixed" aria-hidden="true"><GripVertical size={14} /></span> : <span
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
        </span>}
        <span className="nav-edit-label">
          {lead && (
            <Select
              value={it.type}
              onChange={(v) => change((ls) => ls.map((x, j) => (j === 0 ? ({ type: v } as NavItem) : x)))}
              aria-label="First hotbar button"
            >
              <option value="menu">Menu</option>
              <option value="home">Home (Menu while on the home page)</option>
            </Select>
          )}
          {it.type === 'section' && (
            <button type="button" className="icon-btn nav-edit-icon" title="Change icon" aria-label={`Change the icon of ${label}`} onClick={() => setIconFor({ root: isHotbar(listKey) ? 'bottom' : 'top', index: i })}>
              <ViewIcon icon={it.icon} fallback={Folder} size={16} strokeWidth={1.75} />
            </button>
          )}
          {lead ? null : it.type === 'home' || it.type === 'divider' || it.type === 'menu' ? label : (
            <EditableLabel
              value={label}
              fallback={it.type === 'section' ? null : itemLabel({ ...it, label: undefined } as NavItem, objectLabel, viewName, customViewName)}
              onSave={(l) => change((ls) => ls.map((x, j) => (j === i ? ({ ...x, label: l } as NavItem) : x)))}
            />
          )}
          {kind && it.type !== 'section' && <span className="kind">{kind}</span>}
        </span>
        {!lead && (
          <>
            <button className="icon-btn" onClick={() => change((l) => move(l, i, -1))} disabled={i === (listKey === 'bottom' ? 1 : 0)} aria-label={`Move ${label} up`}><ArrowUp size={14} /></button>
            <button className="icon-btn" onClick={() => change((l) => move(l, i, 1))} disabled={i === list.length - 1} aria-label={`Move ${label} down`}><ArrowDown size={14} /></button>
            <button className="icon-btn" onClick={() => change((l) => l.filter((_, j) => j !== i))} aria-label={`Remove ${label}`}><Trash2 size={14} /></button>
          </>
        )}
        {children}
      </div>
    );
  };

  // key: 'top' or 'bottom' for a tree's top level (its sections are drawn inside), else a section's key
  const renderList = (list: NavItem[], key: ListKey): ReactNode[] =>
    list.map((it, i) => {
      const root = key === 'top' || key === 'bottom' ? key : null;
      const childKey = root && it.type === 'section' ? sectionKey(root, i) : null;
      return row(it, i, list, key, (fn) => updateList(key, fn), root === null,
        childKey !== null && it.type === 'section' ? (
          <div
            className={`nav-edit-children${dropAt?.list === childKey && it.items.length === 0 ? ' drop-into' : ''}`}
            // over the gaps or an empty section (rows inside handle their own)
            onDragOver={(e) => {
              if (!dragFrom.current) return;
              e.stopPropagation();
              if (!canDrop(childKey)) return;
              e.preventDefault();
              setDropAt({ list: childKey, index: it.items.length });
            }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(); }}
          >
            {renderList(it.items, childKey)}
          </div>
        ) : undefined);
    });

  const addButton = (where: 'sidebar' | 'bottom') => {
    const full = where === 'bottom' && hotbarFull && !bottom.some((it) => it.type === 'section') && picker !== where;
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
        {full && fullNote && <span className="nav-add-note" role="status">Max {BOTTOM_MAX} items. Remove one, or add a section, to add another.</span>}
      </span>
    );
  };

  // the selector under a menu's + Add: what to add and, in the sidebar, where
  const addPicker = (where: 'sidebar' | 'bottom') => picker === where && (
    <div className="nav-add">
      {(where === 'sidebar' ? items : bottom).some((it) => it.type === 'section') && (
        <label className="field">
          <span>Where</span>
          <Select value={String(adding.where)} onChange={(v) => pickWhere(v === 'top' || v === 'bottom' || v.startsWith('b:') ? (v as ListKey) : Number(v))}>
            {(where === 'sidebar' || !hotbarFull) && <option value={where === 'sidebar' ? 'top' : 'bottom'}>{where === 'sidebar' ? 'Top level' : 'On the hotbar'}</option>}
            {(where === 'sidebar' ? items : bottom).map((it, i) => it.type === 'section' && (
              <option key={i} value={String(sectionKey(where === 'sidebar' ? 'top' : 'bottom', i))}>In section "{it.label}"</option>
            ))}
          </Select>
        </label>
      )}
      <label className="field">
        <span>Type</span>
        <Select value={adding.type} onChange={(v) => setAdding((a) => ({ ...a, type: v, view: '' }))}>
          {typesFor(adding.where).map((t) => <option key={t} value={t}>{ITEM_TYPE_LABELS[t]}</option>)}
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


  const iconSection = iconFor === null ? undefined : (iconFor.root === 'top' ? items : bottom)[iconFor.index];
  return (
    <>
    {iconSection?.type === 'section' && (
      <IconPicker
        value={iconSection.icon ?? null}
        onPick={(name) => {
          const at = iconFor;
          if (!at) return;
          (at.root === 'top' ? setItems : setBottom)((all) => all.map((x, j) => {
            if (j !== at.index || x.type !== 'section') return x;
            const { icon: _old, ...rest } = x;
            return name ? { ...rest, icon: name } : rest;
          }));
          setIconFor(null);
        }}
        onClose={() => setIconFor(null)}
      />
    )}
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
      <div className="tabs" role="tablist" aria-label="Part of the menu">
        {tabs.map((t) => (
          <div key={t.key} className={`tab${tab === t.key ? ' active' : ''}`}>
            <button role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>
          </div>
        ))}
      </div>

      {tab === 'sidebar' && (
      <SettingsSection title="Sidebar" description={sidebarDescription()}>
        {!loaded ? <TableSkeleton rows={5} /> : items.length === 0
          ? <EmptyState icon={<PanelLeft size={18} />} title="This menu is empty">Add objects, views and sections with + Add.</EmptyState>
          : <div className="nav-tree">{renderList(items, 'top')}</div>}
        {loaded && addButton('sidebar')}
        {addPicker('sidebar')}
      </SettingsSection>
      )}

      {tab === 'hotbar' && (
      <SettingsSection title="Mobile hotbar" description={`Shown along the bottom of the screen on mobile: Menu or Home first, so Settings and Mentions stay reachable (Home turns into Menu on the home page), then up to ${BOTTOM_MAX - 1} items in any order, then Search, which is always last. A section opens a list of its links.`}>
        <BottomBarPreview items={bottom} />
        {loaded && bottom.length === 0
          ? <p className="muted">Only Search is on the hotbar.</p>
          : <div className="nav-tree">{renderList(bottom, 'bottom')}</div>}
        {loaded && addButton('bottom')}
        {addPicker('bottom')}
      </SettingsSection>
      )}

      {tab === 'more' && (
      <SettingsSection title="More menu" description="Every object you can open is listed under More in the sidebar. Switch one off to leave it out of More, or turn More off for this menu altogether. Objects still open from search, links and any sidebar item.">
        {!loaded ? <TableSkeleton rows={4} /> : (
          <>
          <label className="nav-more-master">
            <span>
              <strong>Show More in the sidebar</strong>
              <span className="muted small">{moreOff ? 'Off: this menu has no More button.' : 'On: the sidebar ends with a More button listing the objects switched on below.'}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={!moreOff}
              onChange={(e) => setMoreHidden((h) => (e.target.checked ? h.filter((o) => o !== MORE_OFF) : [...h, MORE_OFF]))}
              aria-label="Show More in the sidebar"
            />
          </label>
          <fieldset className={`nav-more-groups${moreOff ? ' off' : ''}`} disabled={moreOff}>
            {moreGroups(objects.map((o) => o.api_name)).map((g) => {
              const shownCount = g.objects.filter((o) => !moreHidden.includes(o)).length;
              return (
                <div key={g.label} className="nav-more-group">
                  <label className="nav-more-head">
                    <span>{g.label}</span>
                    <span className="muted small push-right">{shownCount} of {g.objects.length} shown</span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={shownCount > 0}
                      ref={(el) => { if (el) el.indeterminate = shownCount > 0 && shownCount < g.objects.length; }}
                      onChange={(e) => setMoreHidden((h) => (e.target.checked ? h.filter((o) => !g.objects.includes(o)) : [...new Set([...h, ...g.objects])]))}
                      aria-label={`Show all of ${g.label} in More`}
                    />
                  </label>
                  {g.objects.map((o) => {
                    const Icon = objectIcon(o);
                    const shown = !moreHidden.includes(o);
                    return (
                      <label key={o} className={`nav-more-row${shown ? '' : ' off'}`}>
                        <Icon size={16} strokeWidth={1.75} />
                        <span>{objectLabel(o)}</span>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={shown}
                          onChange={(e) => setMoreHidden((h) => (e.target.checked ? h.filter((x) => x !== o) : [...h, o]))}
                          aria-label={`Show ${objectLabel(o)} in More`}
                        />
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </fieldset>
          </>
        )}
      </SettingsSection>
      )}

      {tab === 'groups' && isAdmin && loaded && (
        <NavGroups
          groups={groups}
          users={users}
          myId={myId}
          everyoneCan={everyoneCan}
          menuSources={menuSources}
          onChanged={async () => { await loadMenus(); await reloadNav(); }}
          onEditMenu={(t) => { pickTarget(t); setTab('sidebar'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
        />
      )}

      {(tab !== 'groups' || dirty) && <SaveBar dirty={dirty} message={message} error={error}>
        {hasOwn && <button className="btn" onClick={resetUser}>Reset to {fallbackName} menu</button>}
        <button className="btn primary" onClick={save} disabled={!dirty}>Save menu</button>
      </SaveBar>}

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
    </>
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
        Replaces the sidebar, mobile hotbar and More menu of {into} with a copy. For a user without their own menu, this copies the menu they see now.
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

  // a rename needs a different name; a new group just a name
  const ready = !!name.trim() && (!!menuSources || name.trim() !== initialName.trim());

  async function submit() {
    if (!ready) return;
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
          <SaveHint missing={[!name.trim() && 'a name']} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !ready}>{menuSources ? 'Create group' : 'Save'}</button>
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
  const { dirty } = useDirty(picked);

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
          <button className="btn primary" onClick={submit} disabled={busy || !dirty}>Save members</button>
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
function BottomBarPreview({ items }: { items: NavItem[] }) {
  const { objectByName, customViews } = useApp();
  return (
    <div className="bottom-bar-preview" aria-label="Mobile hotbar preview">
      <div className="bottom-bar">
        {items.map((item, i) => {
          if (item.type === 'menu' || item.type === 'section') {
            return (
              <span key={i} className="bottom-item">
                {item.type === 'menu' ? <MenuIcon size={22} strokeWidth={1.75} /> : <ViewIcon icon={item.icon} fallback={Folder} size={22} strokeWidth={1.75} />}
                <span>{item.type === 'menu' ? 'Menu' : item.label}</span>
              </span>
            );
          }
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
