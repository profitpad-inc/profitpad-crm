import { Component, useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { call, getInit, getParams, subscribeParams } from './bridge';
import type { Params } from './protocol';

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

export function Page({ title, subtitle, actions, children }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="v-page">
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
export function Grid({ columns = 2, gap = 12, children }: { columns?: number; gap?: number; children?: ReactNode }) {
  return <div className="v-grid" style={{ '--v-cols': columns, gap } as CSSProperties}>{children}</div>;
}

export function Stack({ gap = 12, children }: { gap?: number; children?: ReactNode }) {
  return <div className="v-stack" style={{ gap }}>{children}</div>;
}

export function Row({ gap = 8, align = 'center', wrap = true, children }: { gap?: number; align?: CSSProperties['alignItems']; wrap?: boolean; children?: ReactNode }) {
  return <div className="v-row" style={{ gap, alignItems: align, flexWrap: wrap ? 'wrap' : 'nowrap' }}>{children}</div>;
}

export function Card({ title, subtitle, actions, children }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="v-card">
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

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'money' | 'danger' | 'muted' }) {
  return (
    <div className="v-card v-stat">
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
  columns, rows, loading, error, onRowClick, selected, empty = 'Nothing to show', maxHeight
}: {
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
    <div className="v-table-wrap" style={maxHeight ? { maxHeight } : undefined}>
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

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="v-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === value} className={t.key === value ? 'active' : ''} onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Badge({ tone, children }: { tone?: 'primary' | 'money' | 'danger' | 'warning' | 'muted'; children?: ReactNode }) {
  return <span className={`v-badge${tone ? ' tone-' + tone : ''}`}>{children}</span>;
}

export function Button({ variant, small, disabled, onClick, children, type = 'button' }: {
  variant?: 'primary' | 'danger'; small?: boolean; disabled?: boolean; onClick?: () => void; children?: ReactNode; type?: 'button' | 'submit';
}) {
  return <button type={type} className={`v-btn${variant ? ' ' + variant : ''}${small ? ' small' : ''}`} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function TextInput({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: 'text' | 'number' | 'date' | 'search' }) {
  return <input className="v-input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Select({ value, onChange, options, placeholder }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select className="v-input v-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function RecordLink({ object, id, children }: { object: string; id: string; children?: ReactNode }) {
  return <a className="v-link" href="#" onClick={(e) => { e.preventDefault(); openRecord(object, id); }}>{children}</a>;
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
  render() {
    if (this.state.error) return <div className="v-page"><ErrorBox error={`This view crashed: ${this.state.error.message}`} /></div>;
    return this.props.children;
  }
}
