import {
  Component, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent, type ReactNode
} from 'react';
import { call, getInit, getParams, getViewport, post, report, subscribeParams, subscribeViewport } from './bridge';
import type { Params, ViewFile, Viewport } from './protocol';
import { Select as Dropdown } from '../components/Select';
import { DatePicker } from '../components/DatePicker';
import { Markdown as BaseMarkdown } from '../components/Markdown';
import { CodeBlock as BaseCodeBlock, setCopyText } from '../components/CodeBlock';
import { langFor, type CodeLang } from '../lib/code-folds';
import { MultiValueEditor } from '../components/MultiValueField';
import { AdvancedFilters as BaseAdvancedFilters } from '../components/AdvancedFilters';
import type { FilterField, FilterGroup } from '../lib/filters';
import { decodeEntries, encodeEntries, entriesOf, labelText } from '../lib/multi-values';
import { PhoneInput as BasePhoneInput, type PhoneResult, type PhoneSource } from '../components/PhoneInput';
import { decorateRegions, type PhoneRegions, type RawPhoneRegions } from '../public/phone-regions';
import { dateTimeFmt, friendlyDate } from '../lib/date-format';
import { displayPhone } from '../lib/phone-display';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, Lock, Pencil, Search, X } from 'lucide-react';

// What views import from '@pcrm/view': data hooks, actions, layout and UI
// pieces styled like the CRM, and formatters. Documented for the AI in
// api/src/views-guide.ts; keep the two in step.

// ---- data -------------------------------------------------------------------------

export interface QueryState<Row = Record<string, any>> {
  data: Row[];
  columns: { name: string; type: string }[];
  loading: boolean;
  error: Error | null;
  truncated: boolean;
  refresh: () => void;
}

// Runs one of the view's named queries. Re-runs when name or params change;
// { enabled: false } waits (say, until a row is picked).
export function useQuery<Row = Record<string, any>>(name: string, params: Record<string, unknown> = {}, opts: { enabled?: boolean } = {}): QueryState<Row> {
  const enabled = opts.enabled ?? true;
  const key = JSON.stringify(params);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Omit<QueryState<Row>, 'refresh'>>({ data: [], columns: [], loading: enabled, error: null, truncated: false });
  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    call<{ rows: Row[]; columns: { name: string; type: string }[]; truncated: boolean }>('query', [name, JSON.parse(key)])
      .then((r) => live && setState({ data: r.rows, columns: r.columns, loading: false, error: null, truncated: r.truncated }))
      .catch((e: Error) => live && setState((s) => ({ ...s, loading: false, error: e })));
    return () => {
      live = false;
    };
  }, [name, key, enabled, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}

// Values after the slug in the address: /view/#my-view?stage=won -> { stage: 'won' }
export function useParams(): Params {
  return useSyncExternalStore(subscribeParams, getParams);
}

// Where the view is on screen. The frame grows to fit its content and the CRM
// page scrolls, so the view cannot see its own scroll: scrollTop is how many
// pixels of the view are scrolled out of sight above, viewportHeight how tall
// the visible area is. The visible part of the view is therefore
// scrollTop to scrollTop + viewportHeight. In a fill view (export const
// frame = 'fill') it is the view's own scroll.
const isFill = () => document.documentElement.classList.contains('v-fill');
let ownViewport: Viewport = { scrollTop: 0, viewportHeight: window.innerHeight };
function subscribeOwn(fn: () => void): () => void {
  const update = () => {
    const next = { scrollTop: window.scrollY, viewportHeight: window.innerHeight };
    if (next.scrollTop === ownViewport.scrollTop && next.viewportHeight === ownViewport.viewportHeight) return;
    ownViewport = next;
    fn();
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
  return () => {
    window.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
  };
}

export function useViewport(): Viewport {
  const fill = isFill();
  return useSyncExternalStore(fill ? subscribeOwn : subscribeViewport, fill ? () => ownViewport : getViewport);
}

// value, once it has stopped changing for ms (for search boxes that set
// params or run queries)
export function useDebounced<T>(value: T, ms = 300): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

// Save stays disabled until the form differs from what it opened with (the
// CRM's rule): const { dirty, markSaved } = useDirty({ name, notes }, record?.id).
// A changed resetKey, or markSaved() after a save, makes the current values
// the new starting point; changing a field back makes it clean again.
export { useDirty } from '../lib/use-dirty';

export function useMe() {
  return getInit()?.me ?? { id: null, name: null, is_admin: false };
}

export function useView() {
  const init = getInit();
  return init ? { ...init.view, crm_url: init.crm_url ?? '' } : null;
}

// A full link to a page of this CRM, for openUrl, copyText or showing to
// people: crmUrl('/p/page/launch') is https://<the CRM>/p/page/launch. The
// frame has no web address of its own, so views cannot build these otherwise.
// openUrl opens the CRM's own pages without asking about leaving the CRM.
export function crmUrl(path = '/'): string {
  const base = getInit()?.crm_url ?? '';
  const p = String(path ?? '/');
  return `${base}${p.startsWith('/') ? p : `/${p}`}`;
}

// ---- actions (run by the CRM page with the viewer's permissions) ------------------

export const openRecord = (object: string, id: string) => call<void>('openRecord', [object, id]);
// paths inside the CRM, like '/objects/deals' or '/view/#other-view'
export const navigate = (path: string) => call<void>('navigate', [path]);
// merges into the address params; undefined or '' removes a param
export const setParams = (next: Record<string, string | number | undefined | null>) => call<void>('setParams', [next]);
export const createRecord = (object: string, properties: Record<string, unknown>, associations?: { object: string; id: string }[]) =>
  call<{ id: string; properties: Record<string, unknown> }>('createRecord', [object, properties, associations ?? []]);
export const updateRecord = (object: string, id: string, properties: Record<string, unknown>) =>
  call<{ id: string; properties: Record<string, unknown> }>('updateRecord', [object, id, properties]);
export const associateRecords = (object: string, id: string, toObject: string, toId: string) => call<void>('associateRecords', [object, id, toObject, toId]);
// the old name, kept so views saved before the rename keep working
export const linkRecords = associateRecords;
// Opens the CRM's own line items editor (the record page's Line items +) over
// the view, for a record with line items (deals, quotes, invoices, ...).
// Resolves when the viewer closes it: saved says whether lines were saved.
export const editLineItems = (object: string, id: string) => call<{ saved: boolean }>('editLineItems', [object, id]);

// The CRM's own Edit all (set one property on every record) and Delete all
// (archive, to the recycle bin) dialogs, over the ids a view picked. Resolve
// with how many records changed: 0 when the viewer cancelled.
export const bulkEdit = (object: string, ids: string[]) => call<{ updated: number }>('bulkEdit', [object, ids]);
export const bulkDelete = (object: string, ids: string[]) => call<{ deleted: number }>('bulkDelete', [object, ids]);
// Choices of a dropdown that lets users add them (allow_user_add, like a
// library's Folder): anyone who may edit the object's records may add, rename
// and archive them; other dropdowns need an admin. addOption makes the
// internal value from the label unless one is given, and resolves with it.
export const addOption = (object: string, property: string, label: string, value?: string) =>
  call<{ value: string; label: string }>('addOption', [object, property, label, value ?? null]);
export const renameOption = (object: string, property: string, value: string, label: string) => call<void>('updateOption', [object, property, value, { label }]);
// archived: no longer offered, but records keep the value until changed
export const archiveOption = (object: string, property: string, value: string) => call<void>('updateOption', [object, property, value, { record_status: 'archived' }]);
// Sends data to an integration an admin set up (an n8n webhook, say); the
// API makes the request and resolves with the endpoint's answer.
export const callIntegration = <T = unknown>(key: string, data?: unknown) => call<{ status: number; data: T }>('callIntegration', [key, data ?? null]);
// Opens a web page (http or https only) in a new tab. Call it from a click:
// the CRM opens the tab with the viewer's tap, and asks "You're leaving the
// CRM for <domain>" unless the viewer said not to ask again for that domain.
// Resolves with { opened: false } when the viewer cancels.
export const openUrl = (url: string) => call<{ opened: boolean }>('openUrl', [url]);

// Puts text on the viewer's clipboard (the frame has no clipboard access of
// its own): a link, a generated document, an id.
export const copyText = (text: string) => call<{ copied: boolean }>('copyText', [String(text ?? '')]);

// ---- the viewer's own settings (kept per user and view on the server) -----------------

// All of the viewer's saved settings in this view, as { key: value }.
export const getViewSettings = () => call<Record<string, unknown>>('getSettings', []);
// Saves one setting for the viewer (any JSON up to 32 KB); null removes it.
export const setViewSetting = (key: string, value: unknown) => call<{ key: string; saved: boolean }>('setSetting', [key, value ?? null]);

let settingsCache: Promise<Record<string, unknown>> | null = null;
const settingsValues: Record<string, unknown> = {};
const settingsListeners = new Set<() => void>();
const settingsTimers = new Map<string, ReturnType<typeof setTimeout>>();

function loadSettings(): Promise<Record<string, unknown>> {
  if (!settingsCache) {
    settingsCache = getViewSettings().then((all) => {
      for (const [k, v] of Object.entries(all)) if (!(k in settingsValues)) settingsValues[k] = v;
      settingsListeners.forEach((f) => f());
      return settingsValues;
    }, (err) => {
      settingsCache = null;
      throw err;
    });
  }
  return settingsCache;
}

// Like useState, but remembered for this viewer in this view, on any device:
//   const [cards, setCards] = useViewSetting('cards', ['pipeline', 'weighted']);
// Starts as fallback until the saved value loads (loading is true meanwhile).
// Saves a moment after the last change, so typing or dragging is one save.
export function useViewSetting<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void, { loading: boolean; error: Error | null }] {
  const [, rerender] = useState(0);
  const [loading, setLoading] = useState(!settingsCache);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const f = () => rerender((n) => n + 1);
    settingsListeners.add(f);
    loadSettings().then(() => setLoading(false), (err: Error) => { setError(err); setLoading(false); });
    return () => { settingsListeners.delete(f); };
  }, []);
  const value = (key in settingsValues ? settingsValues[key] : fallback) as T;
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const prev = (key in settingsValues ? settingsValues[key] : fallback) as T;
    const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
    settingsValues[key] = v;
    settingsListeners.forEach((f) => f());
    clearTimeout(settingsTimers.get(key));
    settingsTimers.set(key, setTimeout(() => {
      settingsTimers.delete(key);
      setViewSetting(key, v).catch((err: Error) => setError(err));
    }, 400));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, set, { loading, error }];
}

// ---- files (the page uploads and reads them as the viewer) -------------------------

export type { ViewFile };

// Markdown text (a markdown property, an AI answer), drawn as elements, never
// as HTML: the CRM's own renderer (the knowledge base uses it too). Links go
// through openUrl, so the viewer confirms the site as with ExternalLink.
export function Markdown({ text, style, className }: { text: string | null | undefined } & Styled) {
  return <div className={cx('v-md', className)} style={style}><BaseMarkdown onLink={(url) => void openUrl(url)}>{String(text ?? '')}</BaseMarkdown></div>;
}

// Code (SQL, HTML, JSON, a script) with line numbers, VS Code style folding
// and a copy button. lang: 'html' | 'js' (also JSON, CSS) | 'sql' | 'text', or
// a file name or extension ('page.html', 'json'); default 'text'.
setCopyText((text) => call('copyText', [text]));
export function CodeBlock({ code, lang, wrap = false, maxHeight, style, className }: {
  code: string | null | undefined; lang?: CodeLang | string; wrap?: boolean; maxHeight?: number | string;
} & Styled) {
  const l: CodeLang = lang === 'html' || lang === 'js' || lang === 'sql' || lang === 'text' ? lang : langFor(lang);
  return <BaseCodeBlock text={String(code ?? '')} lang={l} wrap={wrap} className={cx('v-code', className)} style={{ ...(maxHeight !== undefined ? { maxHeight } : {}), ...style }} />;
}

export interface UploadOptions {
  // the file's name in the CRM (default: the File's own name, else "file")
  name?: string;
  // the record and file property it is meant for: then edit access to that
  // record is enough, without Create on files (attach it with updateRecord)
  object?: string;
  id?: string;
  property?: string;
  onProgress?: (fraction: number) => void;
}

// Uploads a File or Blob as the viewer and resolves with the new file once it
// is stored. Put file.id in a file property with createRecord / updateRecord.
export function uploadFile(file: Blob, options: string | UploadOptions = {}): Promise<ViewFile> {
  const o = typeof options === 'string' ? { name: options } : options;
  if (!(file instanceof Blob)) return Promise.reject(new Error('uploadFile takes a File or Blob'));
  const target = o.object || o.id || o.property ? { object: o.object, id: o.id, property: o.property } : null;
  return call<ViewFile>('uploadFile', [file, o.name ?? null, target], o.onProgress);
}

// Name, type and size of files the viewer can open (others are left out).
export const getFiles = (ids: string[]) => call<ViewFile[]>('getFiles', [ids]);
// The file's bytes (up to 25 MB), e.g. for URL.createObjectURL; useFileUrl does that for you.
export const getFileBlob = (id: string) => call<Blob>('fileBlob', [id]);
// Opens the file in a new tab (images, PDF, video, audio, text), or downloads it.
export const openFile = (id: string, options: { download?: boolean } = {}) => call<void>('openFile', [id, options.download === true]);

// Bytes already read, kept for the frame's life (at most 40 files) so a list
// of thumbnails re-renders without reading them again.
const blobs = new Map<string, Promise<Blob>>();
function cachedBlob(id: string): Promise<Blob> {
  let p = blobs.get(id);
  if (!p) {
    p = getFileBlob(id);
    blobs.set(id, p);
    p.catch(() => blobs.delete(id));
    if (blobs.size > 40) blobs.delete(blobs.keys().next().value!);
  }
  return p;
}

// A blob: URL for a file (to show in <img>, <video> or <iframe>), revoked when
// the component goes away. url is null while loading, on error, or without id.
export function useFileUrl(id: string | null | undefined): { url: string | null; type: string | null; loading: boolean; error: Error | null } {
  const [state, setState] = useState<{ url: string | null; type: string | null; error: Error | null; for: string | null }>({ url: null, type: null, error: null, for: null });
  useEffect(() => {
    if (!id) return;
    let live = true;
    let url: string | null = null;
    cachedBlob(id)
      .then((b) => {
        if (!live) return;
        url = URL.createObjectURL(b);
        setState({ url, type: b.type || null, error: null, for: id });
      })
      .catch((e: Error) => live && setState({ url: null, type: null, error: e, for: id }));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  const current = state.for === (id ?? null);
  return { url: current ? state.url : null, type: current ? state.type : null, loading: !!id && !current, error: current ? state.error : null };
}

// ---- formatters ---------------------------------------------------------------------

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

export function formatNumber(v: unknown, decimals?: number): string {
  const n = num(v);
  if (n === null || !Number.isFinite(n)) return '';
  return n.toLocaleString(undefined, decimals === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatMoney(v: unknown, currency = 'USD'): string {
  const n = num(v);
  if (n === null || !Number.isFinite(n)) return '';
  try {
    return n.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${formatNumber(n, 2)}`;
  }
}

export function formatPercent(v: unknown, decimals = 0): string {
  const n = num(v);
  if (n === null || !Number.isFinite(n)) return '';
  return (n * 100).toFixed(decimals) + '%';
}

// Dates and datetimes as the CRM shows them: "Nov 24, 2026" and "Nov 24, 2026,
// 7:20 PM" in the viewer's locale and time zone. A plain date ("2026-11-24")
// never shifts a day; a datetime gives its local date.
const localDateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
export function formatDate(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return friendlyDate(s);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : localDateFmt.format(d);
}

export function formatDateTime(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : dateTimeFmt.format(d);
}

// A stored phone number (+18882345678ext9) as the CRM shows it: +1 888-234-5678 ext9.
export function formatPhone(v: unknown): string {
  return v === null || v === undefined || v === '' ? '' : displayPhone(String(v));
}

// Series colors that read on white, in order; the first follows the theme.
// ---- HTML previews ------------------------------------------------------------------

// The frame cannot show other pages (no frames, no network), so <HtmlPreview>
// keeps a box and the CRM page draws a sandboxed iframe exactly over it
// (pages/CustomView.tsx, and the renderer in api/src/render.ts). The boxes are
// measured here on every scroll, resize and layout change, clipped to what is
// visible, and hidden while something of the view (a menu, a side panel)
// covers them, since the iframe sits above the whole frame.
const previewEls = new Map<string, HTMLElement>();
let previewRaf = 0;
let previewTimer: ReturnType<typeof setInterval> | null = null;
let lastBoxes = '';

type Rect = { x: number; y: number; w: number; h: number };
const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};
const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

function measurePreviews() {
  previewRaf = 0;
  const boxes = [...previewEls].map(([id, el]) => {
    const rect = rectOf(el);
    let clip: Rect | null = rect.w > 0 && rect.h > 0 ? intersect(rect, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }) : null;
    for (let p = el.parentElement; clip && p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clip = intersect(clip, rectOf(p));
    }
    if (clip) {
      // covered by a menu, a dialog or a panel drawn over it: hide the whole preview
      const c = clip;
      const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]];
      const covered = points.some(([fx, fy]) => {
        const hit = document.elementFromPoint(c.x + c.w * fx, c.y + c.h * fy);
        return !!hit && hit !== el && !el.contains(hit);
      });
      if (covered) clip = null;
    }
    const round = (r: Rect) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    return { id, rect: round(rect), clip: clip && round(clip) };
  });
  const text = JSON.stringify(boxes);
  if (text === lastBoxes) return;
  lastBoxes = text;
  post({ type: 'pcrm:preview-boxes', boxes });
}
const schedulePreviews = () => {
  if (!previewRaf) previewRaf = requestAnimationFrame(measurePreviews);
};
function trackPreviews(on: boolean) {
  if (on && !previewTimer) {
    window.addEventListener('scroll', schedulePreviews, { capture: true, passive: true });
    window.addEventListener('resize', schedulePreviews);
    // menus opening and layout changes move nothing that fires an event
    previewTimer = setInterval(schedulePreviews, 250);
  } else if (!on && previewTimer) {
    window.removeEventListener('scroll', schedulePreviews, { capture: true });
    window.removeEventListener('resize', schedulePreviews);
    clearInterval(previewTimer);
    previewTimer = null;
  }
}

let previewIds = 0;
// html: drawn as it is, without running scripts (emails, documents, a page
// being written). landingPage: a landing page's slug, drawn by its own page
// as visitors see it (draft: the draft, for admins). height: the box's height.
export function HtmlPreview({ html, landingPage, draft = false, height = 560, title = 'Preview', style, className }: {
  html?: string | null; landingPage?: string | null; draft?: boolean; height?: number | string; title?: string;
} & Styled) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useRef(`p${++previewIds}`).current;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    previewEls.set(id, el);
    trackPreviews(true);
    schedulePreviews();
    return () => {
      previewEls.delete(id);
      post({ type: 'pcrm:preview', id, content: null });
      lastBoxes = '';
      if (!previewEls.size) trackPreviews(false);
      schedulePreviews();
    };
  }, [id]);
  useEffect(() => {
    const content = landingPage ? { page: { slug: String(landingPage), draft } } : typeof html === 'string' ? { html } : null;
    post({ type: 'pcrm:preview', id, content });
    lastBoxes = '';
    schedulePreviews();
  }, [id, html, landingPage, draft]);
  return (
    <div ref={ref} className={cx('v-preview', className)} style={{ height, ...style }} role="img" aria-label={title}>
      <span className="muted small">{html || landingPage ? title : 'Nothing to preview'}</span>
    </div>
  );
}

export const chartColors = ['var(--primary)', '#0e9f6e', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#64748b'];

// ---- layout ---------------------------------------------------------------------------

// Every UI piece takes style and className, added to its own.
export interface Styled {
  style?: CSSProperties;
  className?: string;
}

// Prop types views can import (types only: they are stripped, not checked),
// e.g. const toneFor: Record<string, BadgeTone> = { won: 'money', lost: 'danger' }
export type BadgeTone = 'primary' | 'money' | 'danger' | 'warning' | 'muted';
export type StatTone = 'money' | 'danger' | 'muted';
export type ButtonVariant = 'primary' | 'danger';
export type Align = 'left' | 'right' | 'center';
export type { Viewport };
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

export function Page({ title, subtitle, actions, children, style, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode } & Styled) {
  return (
    <div className={cx('v-page', className)} style={style}>
      {(title || actions) && (
        <header className="v-page-head">
          <div>
            {title && <h1>{title}</h1>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="v-row">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}

// columns: how many side by side on wide screens; one column on phones
export function Grid({ columns = 2, gap = 12, children, style, className }: { columns?: number; gap?: number; children?: ReactNode } & Styled) {
  return <div className={cx('v-grid', className)} style={{ '--v-cols': columns, gap, ...style } as CSSProperties}>{children}</div>;
}

export function Stack({ gap = 12, children, style, className }: { gap?: number; children?: ReactNode } & Styled) {
  return <div className={cx('v-stack', className)} style={{ gap, ...style }}>{children}</div>;
}

export function Row({ gap = 8, align = 'center', wrap = true, children, style, className }: { gap?: number; align?: CSSProperties['alignItems']; wrap?: boolean; children?: ReactNode } & Styled) {
  return <div className={cx('v-row', className)} style={{ gap, alignItems: align, flexWrap: wrap ? 'wrap' : 'nowrap', ...style }}>{children}</div>;
}

// Keeps its children in view at the top while its parent element scrolls past
// (column headers on a long board). Works in normal views, where the CRM page
// scrolls and CSS position: sticky cannot, and in fill views. top: the gap
// above it when stuck.
export function Sticky({ top = 0, children, style, className }: { top?: number; children?: ReactNode } & Styled) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollTop } = useViewport();
  const fill = isFill();
  const [shift, setShift] = useState(0);
  const [, setSize] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fill) return;
    const parent = el.parentElement;
    const naturalTop = el.getBoundingClientRect().top + window.scrollY - shift;
    const room = parent ? parent.getBoundingClientRect().bottom + window.scrollY - naturalTop - el.offsetHeight : 0;
    const next = Math.round(Math.max(0, Math.min(scrollTop + top - naturalTop, room)));
    if (next !== shift) setShift(next);
  });
  // re-measure when the content around it changes size
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent || fill) return;
    const ro = new ResizeObserver(() => setSize((n) => n + 1));
    ro.observe(parent);
    return () => ro.disconnect();
  }, [fill]);
  const stuck = fill ? { position: 'sticky' as const, top } : { position: 'relative' as const, transform: shift ? `translateY(${shift}px)` : undefined };
  return <div ref={ref} className={cx('v-sticky', (fill || shift > 0) && 'stuck', className)} style={{ zIndex: 5, ...stuck, ...style }}>{children}</div>;
}

// A wide area (a kanban board, a wide table) that scrolls sideways under a
// header that stays at the top of the screen while it scrolls down. The
// header sits outside the sideways scroller (an overflow container would
// stop it sticking) and follows its scrollLeft. Give header and body columns
// the same fixed widths so they line up. top: the gap above the stuck header.
export function ScrollX({ header, top = 0, children, style, className }: { header: ReactNode; top?: number; children?: ReactNode } & Styled) {
  const head = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const follow = () => {
    if (head.current && body.current) head.current.style.transform = `translateX(${-body.current.scrollLeft}px)`;
  };
  return (
    <div className={cx('v-scrollx', className)} style={style}>
      <Sticky top={top} className="v-scrollx-head">
        <div ref={head} className="v-scrollx-inner">{header}</div>
      </Sticky>
      <div ref={body} className="v-scrollx-body" onScroll={follow}>
        <div className="v-scrollx-inner">{children}</div>
      </div>
    </div>
  );
}

export function Card({ title, subtitle, actions, children, style, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode } & Styled) {
  return (
    <section className={cx('v-card', className)} style={style}>
      {(title || actions) && (
        <div className="v-card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <div className="muted small">{subtitle}</div>}
          </div>
          {actions && <div className="v-row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

// ---- side panels (the house style for adding and editing from a list) --------------

// The list (children) with the open record's panel beside it: two columns
// while panel is given, one when it is null. The list scrolls by itself, so
// give SplitView a height: in a fill view put it in <Page style={{ height:
// '100vh' }}> (it takes the rest of the page). Below 900px wide the panel
// covers the screen. panelWidth: CSS width of the panel column.
export function SplitView({ panel, panelWidth = 'min(520px, 46%)', children, style, className }: {
  panel?: ReactNode; panelWidth?: string; children?: ReactNode;
} & Styled) {
  const open = panel !== null && panel !== undefined && panel !== false;
  return (
    <div className={cx('v-split', open && 'open', className)} style={{ ...(open ? { gridTemplateColumns: `minmax(0, 1fr) ${panelWidth}` } : {}), ...style }}>
      <div className="v-split-main">{children}</div>
      {open && panel}
    </div>
  );
}

// One record in a panel: a header (title as typed, a badge, a muted line of
// context, Open record and Close), a body that scrolls by itself, and a footer
// (error on the left, then your buttons, usually Cancel and Save). Escape
// closes it (not while a date picker is open). Give it key={id} so opening
// another record starts a fresh form.
export function SidePanel({ title, badge, subtitle, onClose, onOpenRecord, actions, footer, error, children, style, className }: {
  title?: ReactNode; badge?: ReactNode; subtitle?: ReactNode; onClose?: () => void; onOpenRecord?: () => void;
  actions?: ReactNode; footer?: ReactNode; error?: ReactNode; children?: ReactNode;
} & Styled) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.flatpickr-calendar.open')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <section className={cx('v-panel', className)} style={style}>
      <header className="v-panel-head">
        <div style={{ minWidth: 0 }}>
          <div className="v-row" style={{ gap: 8 }}>
            {title && <h3 className="v-panel-title">{title}</h3>}
            {badge}
          </div>
          {subtitle && <div className="muted small" style={{ marginTop: 2 }}>{subtitle}</div>}
        </div>
        <div className="v-row" style={{ flexWrap: 'nowrap' }}>
          {actions}
          {onOpenRecord && <Button small onClick={onOpenRecord}>Open record</Button>}
          {onClose && <Button small onClick={onClose}>Close</Button>}
        </div>
      </header>
      <div className="v-panel-body">{children}</div>
      {(footer || error) && (
        <footer className="v-panel-foot">
          <div className="v-panel-error small">{error}</div>
          {footer}
        </footer>
      )}
    </section>
  );
}

// Form fields two to a row (one below 520px wide); wide fields take the row.
export function FieldGrid({ children, style, className }: { children?: ReactNode } & Styled) {
  return <div className={cx('v-fields', className)} style={style}>{children}</div>;
}

export function Field({ label, hint, wide, required, children, style, className }: {
  label: ReactNode; hint?: ReactNode; wide?: boolean; required?: boolean; children?: ReactNode;
} & Styled) {
  return (
    <div className={cx('v-field', wide && 'wide', className)} style={style}>
      <div className="v-field-label">{label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}</div>
      {children}
      {hint && <div className="muted small" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone, style, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: StatTone } & Styled) {
  return (
    <div className={cx('v-card v-stat', className)} style={style}>
      <div className="v-stat-label">{label}</div>
      <div className={`v-stat-value${tone ? ' tone-' + tone : ''}`}>{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

// ---- pieces ----------------------------------------------------------------------------

export interface Column<Row> {
  key: string;
  label: ReactNode;
  align?: Align;
  width?: number | string;
  render?: (row: Row) => ReactNode;
  // left out below 720px wide (phones), so wide tables fit without scrolling sideways
  hideOnMobile?: boolean;
  // false: clicking the header does not sort by this column
  sortable?: boolean;
  // what to sort by when it is not row[key] (a column drawn with render)
  sortValue?: (row: Row) => unknown;
  // how to show row[key] when there is no render: date and datetime as the
  // CRM shows them (Nov 24, 2026, 7:20 PM), phone formatted (+1 888-234-5678),
  // number, money (format money in USD, or row[key + '_currency']) and
  // percent (0.25 is 25%). email and phone add a muted "+2" when
  // row[key + '__all'] (the property's whole list) has more entries.
  format?: ColumnFormat;
  // cells stay on one line (cut with ... past 320px), like the CRM's tables;
  // true lets this column's text wrap (notes, descriptions)
  wrap?: boolean;
  // false leaves the column out of the cards a Table becomes on phones
  card?: boolean;
}

export type ColumnFormat = 'date' | 'datetime' | 'phone' | 'email' | 'number' | 'money' | 'percent';

function formatCell(row: Record<string, any>, key: string, format: ColumnFormat | undefined, full = false): ReactNode {
  const v = row[key];
  if (v === null || v === undefined || v === '') return <span className="muted">--</span>;
  if (format === 'phone' || format === 'email') {
    const first = format === 'phone' ? formatPhone(v) : String(v);
    const all = row[key + '__all'];
    const more = Array.isArray(all) ? all.length - 1 : 0;
    if (more <= 0) return first;
    // cards on phones list every entry, as the CRM's own cards do
    if (full) return all.map((e: any) => (format === 'phone' ? formatPhone(e?.value ?? e) : String(e?.value ?? e))).join(', ');
    const title = all.map((e: any) => (format === 'phone' ? formatPhone(e?.value ?? e) : String(e?.value ?? e))).join(', ');
    return <span>{first} <span className="muted" title={title}>+{more}</span></span>;
  }
  if (format === 'date') return formatDate(v);
  if (format === 'datetime') return formatDateTime(v);
  if (format === 'number') return formatNumber(v);
  if (format === 'money') return formatMoney(v, row[key + '_currency'] || 'USD');
  if (format === 'percent') return formatPercent(v);
  return String(v);
}

// A cell as text for copying, like the CRM's table: formatted, every email or
// phone in the list, phones with a leading ' so spreadsheets keep them as text.
function cellCopyText(row: Record<string, any>, key: string, format: ColumnFormat | undefined): string {
  const v = row[key];
  if (v === null || v === undefined || v === '') return '';
  if (format === 'phone' || format === 'email') {
    const all = row[key + '__all'];
    const list = Array.isArray(all) && all.length ? all.map((e: any) => String(e?.value ?? e)) : [String(v)];
    const text = list.map((x) => (format === 'phone' ? formatPhone(x) : x)).join(', ');
    return format === 'phone' ? `'${text}` : text;
  }
  if (format === 'date') return formatDate(v);
  if (format === 'datetime') return formatDateTime(v);
  if (format === 'number') return formatNumber(v);
  if (format === 'money') return formatMoney(v, row[key + '_currency'] || 'USD');
  if (format === 'percent') return formatPercent(v);
  return String(v);
}
const tsvField = (t: string) => (/[\t\n\r"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

interface CellPos { row: number; col: number }

function directionWords(c: Column<any>, dir: 'asc' | 'desc'): string {
  if (c.format === 'number' || c.format === 'money' || c.format === 'percent') return dir === 'asc' ? 'Low to high' : 'High to low';
  if (c.format === 'date' || c.format === 'datetime') return dir === 'asc' ? 'Oldest first' : 'Newest first';
  return dir === 'asc' ? 'A to Z' : 'Z to A';
}

// The sort button above a Table's cards on phones (the CRM list's Sort menu):
// picking a column sorts by it, picking it again flips it, then clears it.
function SortMenu<Row>({ columns, current, onPick }: { columns: Column<Row>[]; current: TableSort | null; onPick: (c: Column<Row>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="v-sort-menu-anchor" ref={ref}>
      <button type="button" className="v-btn small v-icon-btn" aria-label="Sort" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ArrowUpDown size={16} />
      </button>
      {open && (
        <div className="v-sort-menu" role="menu">
          <div className="v-sort-menu-label">Sort by</div>
          {columns.map((c) => {
            const dir = current?.key === c.key ? current.direction : null;
            return (
              <button key={c.key} type="button" role="menuitem" className={dir ? 'current' : undefined} onClick={() => { setOpen(false); onPick(c); }}>
                <span className="v-sort-menu-name">{c.label}</span>
                {dir && <span className="v-sort-menu-dir">{dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />} {directionWords(c, dir)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// a render that gives nothing shows "--", like an empty value
const orDash = (n: ReactNode) => (n === null || n === undefined || n === false || n === '' ? <span className="muted">--</span> : n);

// first and last name repeat the title on a card, so cards leave them out (as the CRM's do)
const CARD_NAME_PARTS = new Set(['first_name', 'last_name']);

const NARROW = '(max-width: 719px)';
// the CRM's phone breakpoint (lib/use-mobile.ts)
const PHONE = '(max-width: 767px)';
function useMediaMatch(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const change = () => setOn(mq.matches);
    change();
    mq.addEventListener('change', change);
    return () => mq.removeEventListener('change', change);
  }, [query]);
  return on;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export interface TableSort {
  key: string;
  direction: 'asc' | 'desc';
}

// Empty values last either way; numbers (and numeric text) by value, the rest
// as text with digits compared as numbers (ISO dates sort right as text).
function compareValues(a: unknown, b: unknown): number {
  const blankA = a === null || a === undefined || a === '';
  const blankB = b === null || b === undefined || b === '';
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
  const na = typeof a === 'number' ? a : typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a.trim()) ? Number(a) : NaN;
  const nb = typeof b === 'number' ? b : typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b.trim()) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// The CRM's table. By default the header row stays in view while the page
// scrolls past the table (stickyHeader), and clicking a column header sorts
// by it: ascending, descending, then back to the rows' own order (sortable;
// a column can opt out with sortable: false). sort and onSortChange make the
// sort controlled, to keep it in address params.
export function Table<Row extends Record<string, any>>({
  columns, rows, loading, error, onRowClick, selected, empty = 'Nothing to show', maxHeight, sortable = true, sort, defaultSort, onSortChange,
  stickyHeader = true, picked, onPickedChange, freezeFirst = true, cards = true, cardFields = 5, style, className
}: Styled & {
  columns: Column<Row>[];
  rows: Row[];
  loading?: boolean;
  error?: Error | null;
  onRowClick?: (row: Row) => void;
  selected?: (row: Row) => boolean;
  empty?: ReactNode;
  maxHeight?: number;
  sortable?: boolean;
  sort?: TableSort | null;
  defaultSort?: TableSort | null;
  onSortChange?: (sort: TableSort | null) => void;
  stickyHeader?: boolean;
  // row picking: a checkbox column first, ids from row.id
  picked?: string[];
  onPickedChange?: (ids: string[]) => void;
  // the first column (after the checkboxes) stays put when the table scrolls sideways
  freezeFirst?: boolean;
  // below 720px wide the rows become cards (the first column as the title, the
  // next cardFields columns that have a value as label and value lines), like
  // the CRM's tables on a phone; false keeps the table
  cards?: boolean;
  cardFields?: number;
}) {
  const [ownSort, setOwnSort] = useState<TableSort | null>(defaultSort ?? null);
  const narrow = useNarrow();
  // drag over cells to select them, then copy (Cmd/Ctrl+C) as tab-separated
  // text, like the CRM's table; a plain click still clicks the row
  const [cellSel, setCellSel] = useState<{ anchor: CellPos; focus: CellPos } | null>(null);
  const dragging = useRef(false);
  const dragged = useRef(false);
  // phones: checkboxes show only after Select (or a long press), as in the CRM's list
  const [selectMode, setSelectMode] = useState(false);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean; x: number; y: number }>({ fired: false, x: 0, y: 0 });
  const pickedCount = picked?.length ?? 0;
  const hadPicks = useRef(pickedCount > 0);
  // the view emptied the selection (Clear, after Delete all): leave select mode
  useEffect(() => {
    if (hadPicks.current && pickedCount === 0 && !press.current.fired) setSelectMode(false);
    hadPicks.current = pickedCount > 0;
  }, [pickedCount]);
  const current = sort !== undefined ? sort : ownSort;
  function sortBy(c: Column<Row>) {
    const next: TableSort | null = current?.key !== c.key ? { key: c.key, direction: 'asc' } : current.direction === 'asc' ? { key: c.key, direction: 'desc' } : null;
    if (sort === undefined) setOwnSort(next);
    onSortChange?.(next);
  }
  const sortColumn = current ? columns.find((c) => c.key === current.key) : undefined;
  const shown = sortColumn && current
    ? rows
      .map((r, i) => ({ r, i, v: sortColumn.sortValue ? sortColumn.sortValue(r) : r[sortColumn.key] }))
      .sort((x, y) => {
        const blank = (v: unknown) => v === null || v === undefined || v === '';
        // empty values stay last in both directions
        if (blank(x.v) || blank(y.v)) return compareValues(x.v, y.v) || x.i - y.i;
        return (current.direction === 'asc' ? 1 : -1) * compareValues(x.v, y.v) || x.i - y.i;
      })
      .map((x) => x.r)
    : rows;

  const selBox = cellSel && {
    r0: Math.min(cellSel.anchor.row, cellSel.focus.row), r1: Math.max(cellSel.anchor.row, cellSel.focus.row),
    c0: Math.min(cellSel.anchor.col, cellSel.focus.col), c1: Math.max(cellSel.anchor.col, cellSel.focus.col)
  };
  // positions change when the rows, their order or the columns change
  useEffect(() => setCellSel(null), [rows, current?.key, current?.direction, columns.length]);
  useEffect(() => {
    if (!cellSel) return;
    const onUp = () => { dragging.current = false; };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.v-table tbody td.v-cell')) setCellSel(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCellSel(null); };
    const onCopy = (e: ClipboardEvent) => {
      if (!selBox) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (window.getSelection()?.isCollapsed === false) return;
      const body = tableRef.current?.tBodies[0];
      const offset = onPickedChange ? 1 : 0;
      const lines = shown.slice(selBox.r0, selBox.r1 + 1).map((r, i) => columns.slice(selBox.c0, selBox.c1 + 1).map((c, k) => {
        if (!c.render) return cellCopyText(r, c.key, c.format);
        const td = body?.rows[selBox.r0 + i]?.cells[selBox.c0 + k + offset];
        const t = (td?.innerText ?? '').trim();
        return t === '--' ? '' : t;
      }).map(tsvField).join('\t'));
      const text = lines.join('\n');
      e.preventDefault();
      e.clipboardData?.setData('text/plain', text);
      // the frame's own clipboard may be blocked; the CRM page writes it too
      copyText(text).catch(() => undefined);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy);
    };
  });
  function cellMouse(row: number, col: number) {
    return {
      onMouseDown: (e: ReactMouseEvent) => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement;
        if (t.closest('a, button, input, textarea, select, label')) return;
        e.preventDefault(); // no text selection
        (document.activeElement as HTMLElement | null)?.blur();
        window.focus(); // so Cmd/Ctrl+C reaches this frame
        dragging.current = true;
        dragged.current = false;
        const here = { row, col };
        setCellSel((cur) => (e.shiftKey && cur ? { anchor: cur.anchor, focus: here } : { anchor: here, focus: here }));
      },
      onMouseEnter: () => {
        if (!dragging.current) return;
        dragged.current = true;
        setCellSel((cur) => cur && { ...cur, focus: { row, col } });
      }
    };
  }
  const inSel = (row: number, col: number) => !!selBox && row >= selBox.r0 && row <= selBox.r1 && col >= selBox.c0 && col <= selBox.c1;

  // the header row follows the page's scroll (as Sticky does); with maxHeight
  // the table scrolls itself and CSS sticky does it
  const tableRef = useRef<HTMLTableElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const { scrollTop } = useViewport();
  const follow = stickyHeader && !maxHeight;
  const [shift, setShift] = useState(0);
  const [, setSize] = useState(0);
  useLayoutEffect(() => {
    const table = tableRef.current;
    const head = headRef.current;
    if (!follow || !table || !head) {
      if (shift) setShift(0);
      return;
    }
    const box = table.getBoundingClientRect();
    const naturalTop = box.top + window.scrollY;
    const room = box.height - head.getBoundingClientRect().height;
    const next = Math.round(Math.max(0, Math.min(scrollTop - naturalTop, room)));
    if (next !== shift) setShift(next);
  });
  useEffect(() => {
    const table = tableRef.current;
    if (!follow || !table) return;
    const ro = new ResizeObserver(() => setSize((n) => n + 1));
    ro.observe(table);
    return () => ro.disconnect();
  }, [follow]);

  if (error) return <ErrorBox error={error} />;
  const picking = !!onPickedChange;
  const pickedSet = new Set((picked ?? []).map(String));
  const ids = shown.map((r) => String(r.id));
  const allPicked = ids.length > 0 && ids.every((id) => pickedSet.has(id));
  const somePicked = !allPicked && ids.some((id) => pickedSet.has(id));
  function togglePick(id: string) {
    onPickedChange?.(pickedSet.has(id) ? (picked ?? []).filter((x) => String(x) !== id) : [...(picked ?? []), id]);
  }
  const lift = follow && shift ? { transform: `translateY(${shift}px)` } : {};
  const colSpan = columns.length + (picking ? 1 : 0);
  const frozen = (i: number) => freezeFirst && i === 0 && columns.length > 1;
  if (cards && narrow) {
    const [lead, ...rest] = columns;
    const fields = rest.filter((c) => c.card !== false && !CARD_NAME_PARTS.has(c.key));
    const blank = (n: ReactNode) => n === null || n === undefined || n === false || n === '';
    const selecting = picking && (selectMode || pickedCount > 0);
    const sortableCols = sortable ? columns.filter((c) => c.sortable !== false) : [];
    const done = () => { setSelectMode(false); onPickedChange?.([]); };
    const touch = (id: string) => (picking ? {
      onTouchStart: (e: ReactTouchEvent) => {
        const t = e.touches[0];
        clearTimeout(press.current.timer);
        press.current = {
          fired: false, x: t.clientX, y: t.clientY,
          timer: setTimeout(() => {
            press.current.fired = true;
            navigator.vibrate?.(10);
            setSelectMode(true);
            if (!pickedSet.has(id)) togglePick(id);
          }, 450)
        };
      },
      onTouchMove: (e: ReactTouchEvent) => {
        const t = e.touches[0];
        if (Math.abs(t.clientX - press.current.x) > 10 || Math.abs(t.clientY - press.current.y) > 10) clearTimeout(press.current.timer);
      },
      onTouchEnd: () => clearTimeout(press.current.timer),
      onTouchCancel: () => clearTimeout(press.current.timer),
      onContextMenu: (e: ReactMouseEvent) => e.preventDefault()
    } : {});
    return (
      <div className={cx('v-cards-outer', className)} style={style}>
        {(picking || sortableCols.length > 0) && shown.length > 0 && (
          <div className="v-cards-bar">
            {!picking ? null : selecting ? (
              <>
                <Button small onClick={() => onPickedChange?.(allPicked ? (picked ?? []).filter((x) => !ids.includes(String(x))) : [...new Set([...(picked ?? []).map(String), ...ids])])}>
                  {allPicked ? 'Unselect all' : 'Select all'}
                </Button>
                <Button small onClick={done}>Done</Button>
              </>
            ) : <Button small onClick={() => setSelectMode(true)}>Select</Button>}
            {sortableCols.length > 0 && <SortMenu columns={sortableCols} current={current} onPick={sortBy} />}
          </div>
        )}
        <div className="v-table-wrap v-cards-wrap">
          {loading ? <div className="v-cards-note"><Loading /></div>
            : shown.length === 0 ? <div className="v-cards-note muted">{empty}</div> : (
              <ul className="v-cards">
                {shown.map((r, i) => {
                  const id = String(r.id);
                  const isPicked = selecting && pickedSet.has(id);
                  const title = lead ? (lead.render ? lead.render(r) : formatCell(r, lead.key, lead.format)) : null;
                  const lines = fields
                    .filter((c) => (c.render ? true : !(r[c.key] === null || r[c.key] === undefined || r[c.key] === '')))
                    .map((c) => ({ c, node: c.render ? c.render(r) : formatCell(r, c.key, c.format, true) }))
                    .filter((l) => !blank(l.node))
                    .slice(0, cardFields);
                  const tap = () => {
                    // the long press already picked it
                    if (press.current.fired) { press.current.fired = false; return; }
                    if (selecting) togglePick(id);
                    else onRowClick?.(r);
                  };
                  return (
                    <li key={r.id ?? i} {...touch(id)}
                      className={cx('v-card-row', (onRowClick || selecting) && 'clickable', (selected?.(r) || isPicked) && 'selected', isPicked && 'picked') || undefined}
                      onClick={onRowClick || selecting ? tap : undefined}
                      role={selecting ? 'checkbox' : undefined} aria-checked={selecting ? isPicked : undefined}>
                      {selecting && <span className="v-card-check" aria-hidden="true">{isPicked && <Check size={14} strokeWidth={3} />}</span>}
                      <span className="v-card-body">
                        <span className="v-card-title">{title}</span>
                        {lines.map(({ c, node }) => (
                          <span key={c.key} className="v-card-field">
                            <span className="v-card-label">{c.label}</span>
                            <span className="v-card-value">{node}</span>
                          </span>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>
      </div>
    );
  }
  return (
    <div className={cx('v-table-wrap', className)} style={{ ...(maxHeight ? { maxHeight } : {}), ...style }}>
      <table ref={tableRef} className={cx('v-table', follow && 'v-follow-head', !stickyHeader && 'v-no-sticky', picking && 'v-picking')}>
        <thead ref={headRef}>
          <tr>
            {picking && (
              <th className={cx('v-pick-cell', follow && shift > 0 && 'stuck')} style={lift}>
                <input type="checkbox" aria-label="Select all" checked={allPicked}
                  ref={(el) => { if (el) el.indeterminate = somePicked; }}
                  onChange={() => onPickedChange?.(allPicked ? (picked ?? []).filter((x) => !ids.includes(String(x))) : [...new Set([...(picked ?? []).map(String), ...ids])])} />
              </th>
            )}
            {columns.map((c, i) => {
              const canSort = sortable && c.sortable !== false;
              const dir = current?.key === c.key ? current.direction : null;
              return (
                <th
                  key={c.key}
                  style={{ textAlign: c.align ?? 'left', width: c.width, ...lift }}
                  className={cx(c.hideOnMobile && 'v-hide-mobile', canSort && 'v-sortable', dir && 'v-sorted', frozen(i) && 'v-lead', follow && shift > 0 && 'stuck') || undefined}
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                  onClick={canSort ? () => sortBy(c) : undefined}
                >
                  <span className="v-th">
                    {c.label}
                    {canSort && (dir === 'asc' ? <ArrowUp size={13} className="v-sort-mark" aria-hidden />
                      : dir === 'desc' ? <ArrowDown size={13} className="v-sort-mark" aria-hidden />
                        : <ArrowUpDown size={13} className="v-sort-mark v-sort-idle" aria-hidden />)}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={colSpan}><Loading /></td></tr>
          ) : shown.length === 0 ? (
            <tr><td colSpan={colSpan} className="muted v-empty-cell">{empty}</td></tr>
          ) : (
            shown.map((r, i) => {
              const id = String(r.id);
              const isPicked = picking && pickedSet.has(id);
              return (
                <tr key={r.id ?? i}
                  onClick={onRowClick ? (e) => {
                    // a drag over cells, or a shift-click that extends the selection, is not a row click
                    if (dragged.current || e.shiftKey) { dragged.current = false; return; }
                    onRowClick(r);
                  } : undefined}
                  className={cx(onRowClick && 'clickable', (selected?.(r) || isPicked) && 'selected') || undefined}>
                  {picking && (
                    <td className="v-pick-cell" onClick={(e) => { e.stopPropagation(); togglePick(id); }}>
                      <input type="checkbox" aria-label="Select row" checked={isPicked} onClick={(e) => e.stopPropagation()} onChange={() => togglePick(id)} />
                    </td>
                  )}
                  {columns.map((c, ci) => (
                    <td key={c.key} style={{ textAlign: c.align ?? 'left' }} {...cellMouse(i, ci)}
                      className={cx('v-cell', inSel(i, ci) && 'v-cell-sel', cellSel && cellSel.anchor.row === i && cellSel.anchor.col === ci && 'v-cell-anchor', (c.align === 'right' || c.format === 'number' || c.format === 'money' || c.format === 'percent') && 'figures', c.hideOnMobile && 'v-hide-mobile', frozen(ci) && 'v-lead', c.wrap && 'v-wrap') || undefined}>
                      {c.render ? orDash(c.render(r)) : formatCell(r, c.key, c.format)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, value, onChange, style, className }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (key: string) => void } & Styled) {
  return (
    <div className={cx('v-tabs', className)} style={style} role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === value} className={t.key === value ? 'active' : ''} onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Badge({ tone, children, style, className }: { tone?: BadgeTone; children?: ReactNode } & Styled) {
  return <span className={cx('v-badge', tone && 'tone-' + tone, className)} style={style}>{children}</span>;
}

export function Button({ variant, small, disabled, onClick, children, type = 'button', style, className }: {
  variant?: ButtonVariant; small?: boolean; disabled?: boolean; onClick?: () => void; children?: ReactNode; type?: 'button' | 'submit';
} & Styled) {
  return <button type={type} className={cx('v-btn', variant, small && 'small', className)} style={style} disabled={disabled} onClick={onClick}>{children}</button>;
}

// The CRM's date picker (the calendar used on record pages and everywhere else
// in the CRM), never the browser's own: value and onChange use "YYYY-MM-DD",
// or "YYYY-MM-DDTHH:MM" (local time) with withTime. "" is no date.
export function DateInput({ value, onChange, withTime, small, style, className }: {
  value: string; onChange: (v: string) => void; withTime?: boolean; small?: boolean;
} & Styled) {
  return (
    <span className="v-date">
      <DatePicker value={value ?? ''} onChange={onChange} withTime={withTime} inputClassName={cx('v-input', small && 'small', className)} inputStyle={style} />
    </span>
  );
}

// debounce (ms): onChange waits until typing stops; the box itself updates at once.
// type="date" draws DateInput (the CRM's date picker).
export function TextInput(props: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: 'text' | 'number' | 'date' | 'search'; debounce?: number; small?: boolean;
} & Styled) {
  if (props.type === 'date') return <DateInput value={props.value} onChange={props.onChange} small={props.small} style={props.style} className={props.className} />;
  return <PlainInput {...props} />;
}

function PlainInput({ value, onChange, placeholder, type = 'text', debounce, small, style, className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: 'text' | 'number' | 'date' | 'search'; debounce?: number; small?: boolean;
} & Styled) {
  const [text, setText] = useState(value);
  const sent = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // a new value from outside (cleared, back button) replaces what is typed
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  function change(v: string) {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    const emit = () => {
      sent.current = v;
      onChange(v);
    };
    if (debounce && debounce > 0) timer.current = setTimeout(emit, debounce);
    else emit();
  }
  const shownText = debounce ? text : value;
  // type="search": the CRM's table search box (magnifier, grey until focused, x to clear)
  if (type === 'search') {
    return (
      <div className={cx('v-search', small && 'small', className)} style={style}>
        <Search size={15} aria-hidden />
        <input type="text" value={shownText} placeholder={placeholder} aria-label={placeholder || 'Search'} onChange={(e) => change(e.target.value)} />
        {shownText ? <button type="button" className="v-search-clear" aria-label="Clear search" onClick={() => change('')}><X size={14} /></button> : null}
      </div>
    );
  }
  return <input className={cx('v-input', small && 'small', className)} style={style} type={type} value={shownText} placeholder={placeholder} onChange={(e) => change(e.target.value)} />;
}

// Several lines of text. When the view allows snippets (its "Allow snippets"
// setting, on unless turned off), typing # offers them, as in any <textarea>;
// snippets={false} turns that off for this box.
export function TextArea({ value, onChange, placeholder, rows = 4, snippets = true, style, className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; snippets?: boolean;
} & Styled) {
  return <textarea className={cx('v-input', 'v-textarea', className)} style={style} rows={rows} value={value} placeholder={placeholder}
    data-snippets={snippets ? undefined : 'off'} onChange={(e) => onChange(e.target.value)} />;
}

export function Select({ value, onChange, options, placeholder, small, style, className }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string; small?: boolean;
} & Styled) {
  return (
    <Dropdown
      className={cx('v-input v-select', small && 'small', className)}
      style={style}
      value={value}
      onChange={onChange}
      // the placeholder is the empty choice, unless the view lists its own ("All regions")
      options={placeholder !== undefined && !options.some((o) => o.value === '') ? [{ value: '', label: placeholder }, ...options] : options}
    />
  );
}

// ---- advanced filters --------------------------------------------------------------
// The CRM's table filters (HubSpot style: groups of conditions, AND inside a
// group, OR between groups; text has a case-sensitivity switch, off by
// default). value is the filter_groups list; filterRows applies it to query
// rows in the browser. Fields come from useObjectFields(object) or are
// written by hand ({ key, label, type, options? }).

export type { Filter, FilterField, FilterFieldType, FilterGroup } from '../lib/filters';
export { completeGroups, countFilters, describeFilter, filterRows, matchesFilters } from '../lib/filters';

// An object's properties as filter fields (the ones the viewer may see),
// optionally only some, in that order.
export function useObjectFields(object: string, opts: { only?: string[] } = {}): { fields: FilterField[]; loading: boolean; error: Error | null } {
  const only = opts.only?.join(',') ?? '';
  const [state, setState] = useState<{ fields: FilterField[]; loading: boolean; error: Error | null }>({ fields: [], loading: true, error: null });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    call<FilterField[]>('objectFields', [object])
      .then((all) => {
        if (!live) return;
        const keys = only ? only.split(',') : null;
        const fields = keys ? keys.flatMap((k) => all.filter((f) => f.key === k)) : all;
        setState({ fields, loading: false, error: null });
      })
      .catch((e: Error) => live && setState({ fields: [], loading: false, error: e }));
    return () => {
      live = false;
    };
  }, [object, only]);
  return state;
}

export function AdvancedFilters({ fields, value, onChange, placeholder, style, className }: {
  fields: FilterField[]; value: FilterGroup[]; onChange: (groups: FilterGroup[]) => void; placeholder?: string;
} & Styled) {
  return (
    <div className={cx('v-advanced-filters', className)} style={style}>
      <BaseAdvancedFilters kit fields={fields} groups={value ?? []} onChange={onChange} searchPlaceholder={placeholder} />
    </div>
  );
}

// An email or phone property's whole list, as on the CRM's record page: one
// row per address or number with its label (Work, Personal, Cell, ... or
// custom), a star to make one the primary (the first, which the CRM sends to),
// remove, and "+ Add". value is the property's list as the query gives it
// (<name>__all: [{ value, label }]); onChange gets the new list to save as
// the property (updateRecord(object, id, { email: list })), [] when empty.
export function MultiValueInput({ type, value, onChange, style, className }: {
  type: 'email' | 'phone'; value: unknown; onChange: (list: { value: string; label?: string }[]) => void;
} & Styled) {
  // the editor keeps its own rows; it starts from the first value it gets
  const [start] = useState(() => encodeEntries(decodeEntries(typeof value === 'string' ? value : JSON.stringify(Array.isArray(value) ? value : []))));
  return (
    <div className={cx('v-multi', className)} style={style}>
      <MultiValueEditor
        type={type}
        value={start}
        onChange={(text) => onChange(decodeEntries(text))}
        phoneSource={VIEW_PHONE}
        classes={{ input: 'v-input', select: 'v-input v-select', error: 'v-field-error' }}
      />
    </div>
  );
}

// ---- record fields ------------------------------------------------------------------

export type PropertyFieldType = 'text' | 'longtext' | 'number' | 'email' | 'phone' | 'dropdown' | 'date' | 'datetime';

// "2026-11-24T19:20:00Z" as the DateInput's local "2026-11-24T14:20"
function localDateTime(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// One property shown and edited as on a CRM record page's About card: the
// label, the value under it, Edit and Copy on hover (a lock when readOnly),
// and a click that opens the editor in place, saving the way the record page
// does (see the click-outside effect below). email and phone take the whole
// list (<name>__all) and edit it with MultiValueInput. onSave gets the value
// to store (null for empty) and should save it (updateRecord) and refresh;
// if it throws, the error shows under the box and the editor stays open.
// Only one PropertyField in the view edits at a time, as on a record page:
// opening one closes the one that was open.
let activeProp: string | null = null;
const propListeners = new Set<() => void>();
function setActiveProp(id: string | null) {
  activeProp = id;
  propListeners.forEach((l) => l());
}
function subscribeActiveProp(l: () => void) {
  propListeners.add(l);
  return () => { propListeners.delete(l); };
}

export function PropertyField({ label, description, type = 'text', value, options = [], readOnly, onSave, style, className }: {
  label: ReactNode;
  // the property's description, shown when hovering the label
  description?: string | null; type?: PropertyFieldType; value: unknown; options?: { value: string; label: string }[]; readOnly?: boolean;
  onSave?: (value: unknown) => Promise<unknown> | unknown;
} & Styled) {
  const multi = type === 'email' || type === 'phone';
  const list = multi ? entriesOf(Array.isArray(value) ? value : value ? [{ value: String(value) }] : []) : [];
  const start = multi ? list : type === 'datetime' ? localDateTime(value) : type === 'date' ? String(value ?? '').slice(0, 10) : value === null || value === undefined ? '' : String(value);
  const id = useId();
  const editing = useSyncExternalStore(subscribeActiveProp, () => activeProp === id);
  const setEditing = (on: boolean) => { if (on) setActiveProp(id); else if (activeProp === id) setActiveProp(null); };
  const boxRef = useRef<HTMLDivElement>(null);
  // a phone (the CRM's own breakpoint): every field saves with its button,
  // Cancel and Save sit on the label line, and taps outside do nothing
  const phone = useMediaMatch(PHONE);
  const [draft, setDraft] = useState<unknown>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = !readOnly && !!onSave;
  const changed = JSON.stringify(draft) !== JSON.stringify(start);

  const text = multi ? list.map((e) => (type === 'phone' ? formatPhone(e.value) : e.value)).join(', ')
    : type === 'dropdown' ? options.find((o) => o.value === String(value ?? ''))?.label ?? (value ? String(value) : '')
      : type === 'date' ? formatDate(value) : type === 'datetime' ? formatDateTime(value)
        : type === 'number' ? formatNumber(value) : value === null || value === undefined ? '' : String(value);

  function open() {
    if (!canEdit || editing) return;
    setDraft(start);
    setError(null);
    setEditing(true);
  }
  async function save(next: unknown = draft) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let out: unknown = next;
      if (multi) out = (next as unknown[]).length ? next : null;
      else if (typeof next === 'string') out = next.trim() === '' ? null : type === 'number' ? Number(next) : type === 'datetime' ? new Date(next).toISOString() : next.trim();
      await onSave?.(out);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message || String(e));
      // a refused value reopens with the reason under it
      setActiveProp(id);
    } finally {
      setBusy(false);
    }
  }
  // On a computer, as on a record page: a click outside the open field closes
  // it when nothing changed and saves a changed one-value field (those have no
  // buttons: Enter or leaving saves, Escape cancels); a changed email or phone
  // list stays open for its Save or Cancel. On a phone it closes only with them.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!editing || phone) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // dropdown lists, calendars and dialogs are drawn on <body>
      if (boxRef.current?.contains(t) || t.closest?.('.select-menu, .menu, .modal, [role="dialog"], .flatpickr-calendar')) return;
      if (!changed) setEditing(false);
      else if (!multi) void saveRef.current();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editing, changed, multi, phone]);
  // the box gets the cursor when the field opens
  useEffect(() => {
    if (editing) boxRef.current?.querySelector<HTMLElement>('.v-prop-edit input:not([type=hidden]), .v-prop-edit textarea')?.focus();
  }, [editing]);
  // a field that unmounts while open lets the next one open
  useEffect(() => () => { if (activeProp === id) setActiveProp(null); }, [id]);

  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
    if (e.key === 'Enter' && type !== 'longtext' && !multi && !phone && changed) { e.preventDefault(); void save(); }
  };

  const actions = (
    <div className="v-prop-actions">
      <Button small className="v-btn-ghost" onClick={() => setEditing(false)}>Cancel</Button>
      <Button small disabled={busy || !changed} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
    </div>
  );

  return (
    <div ref={boxRef} className={cx('v-prop', canEdit && 'editable', editing && 'editing', className)} style={style}
      onClick={editing ? undefined : (e) => { if (!(e.target as HTMLElement).closest('button, a')) open(); }}>
      <div className="v-prop-label">
        <span title={description || undefined}>{label}</span>
        {!editing && (
          <span className="v-prop-tools">
            {canEdit && <button type="button" className="v-prop-tool" title="Edit" aria-label="Edit" onClick={open}><Pencil size={13} /></button>}
            {text !== '' && <button type="button" className="v-prop-tool" title="Copy" aria-label="Copy" onClick={() => void copyText(text)}><Copy size={13} /></button>}
          </span>
        )}
        {/* on a phone Cancel and Save sit on the label line, above the box,
            so its dropdown list or calendar never covers them */}
        {editing && phone && actions}
        {!canEdit && <Lock className="v-prop-lock" size={12} aria-label="Read only" />}
      </div>
      {editing ? (
        <div className={cx('v-prop-edit', multi && 'multi')} onKeyDown={keys}>
          {multi ? <MultiValueInput type={type as 'email' | 'phone'} value={draft} onChange={setDraft} />
            : type === 'dropdown' ? <Select value={String(draft ?? '')} onChange={(v) => { setDraft(v); if (!phone) void save(v); }} options={options} placeholder="--" />
              : type === 'date' || type === 'datetime' ? <DateInput value={String(draft ?? '')} onChange={setDraft} withTime={type === 'datetime'} />
                : type === 'longtext' ? <TextArea value={String(draft ?? '')} onChange={setDraft} rows={4} />
                  : <TextInput value={String(draft ?? '')} onChange={setDraft} type={type === 'number' ? 'number' : 'text'} />}
          {error && <div className="v-field-error">{error}</div>}
          {!phone && multi && actions}
        </div>
      ) : (
        <div className="v-prop-value">
          {multi && list.length ? (
            <table className="v-prop-list"><tbody>
              {list.map((e, i) => (
                <tr key={i}>
                  <td>{type === 'phone' ? formatPhone(e.value) : e.value}</td>
                  <td className="v-prop-list-label">{labelText(e.label)}</td>
                </tr>
              ))}
            </tbody></table>
          ) : text === '' ? <span className="muted">--</span>
            : type === 'longtext' ? <Markdown text={text} /> : text}
        </div>
      )}
    </div>
  );
}

// A column of PropertyFields, as on a record page's About card.
export function PropertyList({ children, style, className }: { children?: ReactNode } & Styled) {
  return <div className={cx('v-props', className)} style={style}>{children}</div>;
}

// The frame has no network: the page reads the country list and checks
// numbers for it.
let regionsOnce: Promise<PhoneRegions> | null = null;
const VIEW_PHONE: PhoneSource = {
  regions: () => {
    regionsOnce ??= call<RawPhoneRegions>('phoneRegions', []).then(decorateRegions);
    regionsOnce.catch(() => (regionsOnce = null));
    return regionsOnce;
  },
  check: (number) => call<PhoneResult>('checkPhone', [number])
};

// The CRM's phone box: a country picker and the number, checked and formatted
// (+1 888-234-5678 ext9) when the viewer leaves it, with a message under it
// when it is not a valid number. onChange gets what to save: +<code> and the
// number as typed, then the formatted number once checked. Use it for every
// phone property (describe_object shows display: phone).
export function PhoneInput({ value, onChange, small, style, className }: { value: string; onChange: (v: string) => void; small?: boolean } & Styled) {
  return (
    <div className={cx('v-phone', className)} style={style}>
      <BasePhoneInput
        value={value}
        onChange={onChange}
        source={VIEW_PHONE}
        check
        classes={{ input: cx('v-input', small && 'small'), select: cx('v-input v-select', small && 'small'), error: 'v-field-error' }}
      />
    </div>
  );
}

// Whether a dropped file matches accept (the picker filters by itself).
function accepts(accept: string | undefined, f: File): boolean {
  if (!accept) return true;
  const name = f.name.toLowerCase();
  const type = (f.type || '').toLowerCase();
  return accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((a) =>
    a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a
  );
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

// A drop zone with a button that opens the file picker (on phones, capture
// opens the camera: 'environment' the back one, 'user' the front one). With
// onUpload the files are uploaded as the viewer, with progress, and onUpload
// gets them (id, name, mime_type, size_bytes) to put in a file property; with
// only onFiles the view gets the picked File objects and does the rest.
export function FileInput({
  onUpload, onFiles, accept, multiple, capture, label, hint, disabled, small, compact, object, id, property, style, className
}: Styled & {
  onUpload?: (files: ViewFile[]) => void;
  onFiles?: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  capture?: 'environment' | 'user' | boolean;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  small?: boolean;
  // the button alone, without the drop zone
  compact?: boolean;
  // the record and file property the files are for (see uploadFile)
  object?: string;
  id?: string;
  property?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<{ name: string; index: number; count: number; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  async function take(list: FileList | File[] | null) {
    const all = Array.from(list ?? []);
    if (input.current) input.current.value = '';
    if (all.length === 0 || disabled || busy) return;
    const ok = all.filter((f) => accepts(accept, f));
    const picked = multiple ? ok : ok.slice(0, 1);
    setError(ok.length < all.length ? `${all.length - ok.length === 1 ? 'One file is' : 'Some files are'} not a type this accepts${accept ? ` (${accept})` : ''}` : null);
    if (picked.length === 0) return;
    onFiles?.(picked);
    if (!onUpload) return;
    const done: ViewFile[] = [];
    try {
      for (const [index, f] of picked.entries()) {
        setProgress({ name: f.name, index, count: picked.length, fraction: 0 });
        done.push(await uploadFile(f, { object, id, property, onProgress: (fraction) => setProgress({ name: f.name, index, count: picked.length, fraction }) }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
    if (done.length) onUpload(done);
  }

  const text = label ?? (capture ? 'Take photo' : multiple ? 'Choose files' : 'Choose file');
  const button = (
    <Button small={small} disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : text}</Button>
  );
  const status = busy ? (
    <div className="v-file-progress muted small">
      {progress.count > 1 ? `${progress.index + 1} of ${progress.count}: ` : ''}{progress.name} · {Math.round(progress.fraction * 100)}%
      <div className="v-file-bar"><div style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
    </div>
  ) : null;
  return (
    <div className={cx('v-file-input', className)} style={style}>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        {...(capture ? { capture: capture === true ? 'environment' : capture } : {})}
        onChange={(e) => take(e.target.files)}
      />
      {compact ? (
        <div className="v-row" style={{ gap: 8 }}>{button}{status}</div>
      ) : (
        <div
          className={cx('v-file-drop', over && 'over', (disabled || busy) && 'disabled')}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled && !busy) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer.files);
          }}
        >
          {button}
          <span className="muted small v-file-drop-text">or drop {multiple ? 'files' : 'a file'} here</span>
          {hint && <span className="muted small">{hint}</span>}
          {status}
        </div>
      )}
      {error && <div className="v-field-error">{error}</div>}
    </div>
  );
}

// An uploaded image, read through the page (views cannot load links). Files
// that are not images show as a link that opens them.
export function FileImage({ id, alt = '', fit = 'cover', width, height, style, className }: {
  id: string; alt?: string; fit?: 'cover' | 'contain'; width?: number | string; height?: number | string;
} & Styled) {
  const { url, type, loading, error } = useFileUrl(id);
  const box: CSSProperties = { width, height, ...style };
  if (loading) return <div className={cx('v-file-image loading', className)} style={box} />;
  if (error) return <div className={cx('v-file-image missing muted small', className)} style={box} title={error.message}>Cannot show this file</div>;
  if (!url || !type?.startsWith('image/')) return <FileLink id={id} className={className} style={style}>{alt || 'Open file'}</FileLink>;
  return <img className={cx('v-file-image', className)} src={url} alt={alt} style={{ objectFit: fit, ...box }} />;
}

// A link that opens a file in a new tab (or downloads it).
export function FileLink({ id, download, children, style, className }: { id: string; download?: boolean; children?: ReactNode } & Styled) {
  return (
    <a className={cx('v-link', className)} style={style} href="#" onClick={(e) => {
      e.preventDefault();
      openFile(id, { download }).catch((err: Error) => report('error', `openFile: ${err.message}`));
    }}>{children ?? 'Open file'}</a>
  );
}

export function RecordLink({ object, id, children, style, className }: { object: string; id: string; children?: ReactNode } & Styled) {
  return <a className={cx('v-link', className)} style={style} href="#" onClick={(e) => { e.preventDefault(); openRecord(object, id); }}>{children}</a>;
}

// A link to a page outside the CRM, opened in a new tab through openUrl
// (a plain <a href="https://..."> in a view does the same).
export function ExternalLink({ href, children, style, className }: { href: string; children?: ReactNode } & Styled) {
  return (
    <a
      className={cx('v-link', className)}
      style={style}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch((err: Error) => report('error', err.message));
      }}
    >
      {children ?? href}
    </a>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="v-loading muted" role="status" aria-live="polite">
      <span className="v-spinner" aria-hidden="true" />
      <span className="v-sr-only">{label}</span>
    </div>
  );
}

export function Empty({ children = 'Nothing to show' }: { children?: ReactNode }) {
  return <div className="v-empty muted">{children}</div>;
}

export function ErrorBox({ error }: { error: Error | string | null | undefined }) {
  if (!error) return null;
  return <div className="v-error" role="alert">{typeof error === 'string' ? error : error.message}</div>;
}

export class ErrorBoundary extends Component<{ children?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    report('crash', error.message, [error.stack, info.componentStack].filter(Boolean).join('\n'));
  }
  render() {
    if (this.state.error) return <div className="v-page"><ErrorBox error={`This view crashed: ${this.state.error.message}`} /></div>;
    return this.props.children;
  }
}
