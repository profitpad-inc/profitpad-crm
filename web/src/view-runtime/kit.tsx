import {
  Component, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ErrorInfo, type ReactNode
} from 'react';
import { call, getInit, getParams, getViewport, report, subscribeParams, subscribeViewport } from './bridge';
import type { Params, ViewFile, Viewport } from './protocol';
import { Select as Dropdown } from '../components/Select';
import { PhoneInput as BasePhoneInput, type PhoneResult, type PhoneSource } from '../components/PhoneInput';
import { decorateRegions, type PhoneRegions, type RawPhoneRegions } from '../public/phone-regions';

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

export function useMe() {
  return getInit()?.me ?? { id: null, name: null, is_admin: false };
}

export function useView() {
  return getInit()?.view ?? null;
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
export const linkRecords = (object: string, id: string, toObject: string, toId: string) => call<void>('linkRecords', [object, id, toObject, toId]);
// Sends data to an integration an admin set up (an n8n webhook, say); the
// API makes the request and resolves with the endpoint's answer.
export const callIntegration = <T = unknown>(key: string, data?: unknown) => call<{ status: number; data: T }>('callIntegration', [key, data ?? null]);
// Opens a web page (http or https only) in a new tab. Call it from a click:
// the CRM opens the tab with the viewer's tap, and asks "You're leaving the
// CRM for <domain>" unless the viewer said not to ask again for that domain.
// Resolves with { opened: false } when the viewer cancels.
export const openUrl = (url: string) => call<{ opened: boolean }>('openUrl', [url]);

// ---- files (the page uploads and reads them as the viewer) -------------------------

export type { ViewFile };

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

// dates as YYYY-MM-DD and datetimes as YYYY-MM-DD HH:MM (local), like the CRM
export function formatDate(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDateTime(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return `${formatDate(d.toISOString())} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Series colors that read on white, in order; the first follows the theme.
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
  stickyHeader = true, style, className
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
}) {
  const [ownSort, setOwnSort] = useState<TableSort | null>(defaultSort ?? null);
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
  return (
    <div className={cx('v-table-wrap', className)} style={{ ...(maxHeight ? { maxHeight } : {}), ...style }}>
      <table ref={tableRef} className={cx('v-table', follow && 'v-follow-head', !stickyHeader && 'v-no-sticky')}>
        <thead ref={headRef}>
          <tr>
            {columns.map((c) => {
              const canSort = sortable && c.sortable !== false;
              const dir = current?.key === c.key ? current.direction : null;
              return (
                <th
                  key={c.key}
                  style={{ textAlign: c.align ?? 'left', width: c.width, ...(follow && shift ? { transform: `translateY(${shift}px)` } : {}) }}
                  className={cx(c.hideOnMobile && 'v-hide-mobile', canSort && 'v-sortable', dir && 'v-sorted', follow && shift > 0 && 'stuck') || undefined}
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                  onClick={canSort ? () => sortBy(c) : undefined}
                >
                  {c.label}
                  {canSort && <span className="v-sort-mark" aria-hidden="true">{dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={columns.length}><Loading /></td></tr>
          ) : shown.length === 0 ? (
            <tr><td colSpan={columns.length} className="muted v-empty-cell">{empty}</td></tr>
          ) : (
            shown.map((r, i) => (
              <tr key={r.id ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={`${onRowClick ? 'clickable' : ''}${selected?.(r) ? ' selected' : ''}`}>
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={cx(c.align === 'right' && 'figures', c.hideOnMobile && 'v-hide-mobile') || undefined}>
                    {c.render ? c.render(r) : r[c.key] == null || r[c.key] === '' ? <span className="muted">--</span> : String(r[c.key])}
                  </td>
                ))}
              </tr>
            ))
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

// debounce (ms): onChange waits until typing stops; the box itself updates at once
export function TextInput({ value, onChange, placeholder, type = 'text', debounce, small, style, className }: {
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
  return <input className={cx('v-input', small && 'small', className)} style={style} type={type} value={debounce ? text : value} placeholder={placeholder} onChange={(e) => change(e.target.value)} />;
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
      options={placeholder !== undefined ? [{ value: '', label: placeholder }, ...options] : options}
    />
  );
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
// (+1 123-456-7890 ext1) when the viewer leaves it, with a message under it
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
  return <div className="v-loading muted">{label}</div>;
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
