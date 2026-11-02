import {
  Component, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ErrorInfo, type ReactNode
} from 'react';
import { call, getInit, getParams, getViewport, report, subscribeParams, subscribeViewport } from './bridge';
import type { Params, Viewport } from './protocol';

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
interface Styled {
  style?: CSSProperties;
  className?: string;
}
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

export function Stat({ label, value, hint, tone, style, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'money' | 'danger' | 'muted' } & Styled) {
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
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  render?: (row: Row) => ReactNode;
}

export function Table<Row extends Record<string, any>>({
  columns, rows, loading, error, onRowClick, selected, empty = 'Nothing to show', maxHeight, style, className
}: Styled & {
  columns: Column<Row>[];
  rows: Row[];
  loading?: boolean;
  error?: Error | null;
  onRowClick?: (row: Row) => void;
  selected?: (row: Row) => boolean;
  empty?: ReactNode;
  maxHeight?: number;
}) {
  if (error) return <ErrorBox error={error} />;
  return (
    <div className={cx('v-table-wrap', className)} style={{ ...(maxHeight ? { maxHeight } : {}), ...style }}>
      <table className="v-table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={{ textAlign: c.align ?? 'left', width: c.width }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={columns.length}><Loading /></td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="muted v-empty-cell">{empty}</td></tr>
          ) : (
            rows.map((r, i) => (
              <tr key={r.id ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={`${onRowClick ? 'clickable' : ''}${selected?.(r) ? ' selected' : ''}`}>
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={c.align === 'right' ? 'figures' : undefined}>
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

export function Badge({ tone, children, style, className }: { tone?: 'primary' | 'money' | 'danger' | 'warning' | 'muted'; children?: ReactNode } & Styled) {
  return <span className={cx('v-badge', tone && 'tone-' + tone, className)} style={style}>{children}</span>;
}

export function Button({ variant, small, disabled, onClick, children, type = 'button', style, className }: {
  variant?: 'primary' | 'danger'; small?: boolean; disabled?: boolean; onClick?: () => void; children?: ReactNode; type?: 'button' | 'submit';
} & Styled) {
  return <button type={type} className={cx('v-btn', variant, small && 'small', className)} style={style} disabled={disabled} onClick={onClick}>{children}</button>;
}

// debounce (ms): onChange waits until typing stops; the box itself updates at once
export function TextInput({ value, onChange, placeholder, type = 'text', debounce, style, className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: 'text' | 'number' | 'date' | 'search'; debounce?: number;
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
  return <input className={cx('v-input', className)} style={style} type={type} value={debounce ? text : value} placeholder={placeholder} onChange={(e) => change(e.target.value)} />;
}

export function Select({ value, onChange, options, placeholder, style, className }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string;
} & Styled) {
  return (
    <select className={cx('v-input v-select', className)} style={style} value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function RecordLink({ object, id, children, style, className }: { object: string; id: string; children?: ReactNode } & Styled) {
  return <a className={cx('v-link', className)} style={style} href="#" onClick={(e) => { e.preventDefault(); openRecord(object, id); }}>{children}</a>;
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
