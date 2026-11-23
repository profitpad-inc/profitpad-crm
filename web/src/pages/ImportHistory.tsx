import { Fragment, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { toCsv } from '../lib/import-values';
import { EmptyState, SettingsPage, StatusPill, TableSkeleton, type Tone } from '../components/settings';
import { Select } from '../components/Select';
import { Loading } from '../components/Loading';
import '../import.css';

// Settings, Imports and exports: the history of imports (one entry per
// import, however many batches it was sent in) and exports. Everyone sees
// their own; Super Admins see everyone's (GET /v1/imports, /v1/exports).
// ?tab=exports and ?object=<api_name> keep the choice in the address.

interface ObjectRef { api_name: string; label: string }
interface ImportEntry {
  key: string; id: string; object: ObjectRef | null; file_name: string | null; mode: 'create' | 'upsert' | null; match_property: string | null;
  format: string; total_rows: number; created_rows: number; updated_rows: number; error_rows: number; batches: number;
  status: 'completed' | 'running' | 'failed'; started_at: string; finished_at: string | null; created_by: string; user_name: string | null;
}
interface ExportEntry {
  id: string; object: ObjectRef | null; format: string; row_count: number; filters: Record<string, unknown>;
  created_by: string; user_name: string | null; created_at: string;
}
interface Problem { row?: number; error: string }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');
const STATUS: Record<ImportEntry['status'], [Tone, string]> = {
  completed: ['on', 'Done'], running: ['pending', 'Running'], failed: ['failed', 'Failed']
};

function who(e: { created_by: string; user_name: string | null }): string {
  if (e.user_name) return e.created_by.startsWith('user:') ? e.user_name : `${e.user_name} (API)`;
  return e.created_by;
}

function filterSummary(f: Record<string, unknown>): string {
  const g = Array.isArray(f.filter_groups) ? (f.filter_groups as { filters?: { property?: string; operator?: string; values?: unknown[] }[] }[]) : [];
  // the Export button's "picked rows": one id filter
  const ids = g.length === 1 && g[0].filters?.length === 1 && g[0].filters[0].property === 'id' && g[0].filters[0].operator === 'in' ? g[0].filters[0].values?.length ?? 0 : null;
  const bin = f.status === 'archived' ? ' in the recycle bin' : '';
  if (ids !== null) return `${ids} picked ${ids === 1 ? 'row' : 'rows'}${bin}`;
  const groups = g.length;
  const q = typeof f.query === 'string' && f.query.trim() ? `search "${f.query.trim()}"` : '';
  const parts = [groups ? `${groups} filter ${groups === 1 ? 'group' : 'groups'}` : '', q].filter(Boolean);
  return (parts.length ? parts.join(', ') : 'All records') + bin;
}

export function ImportHistory() {
  const { objects, me } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'exports' ? 'exports' : 'imports';
  const object = params.get('object') ?? '';
  const [imports, setImports] = useState<ImportEntry[]>([]);
  const [exports, setExports] = useState<ExportEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, Problem[] | 'loading'>>({});

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };

  const load = useCallback(async (before?: string) => {
    const q = new URLSearchParams({ limit: '50' });
    if (object) q.set('object', object);
    if (before) q.set('before', before);
    if (tab === 'imports') {
      const res = await api<{ results: ImportEntry[]; next: string | null }>('GET', `/v1/imports?${q}`);
      setImports((cur) => (before ? [...cur, ...res.results] : res.results));
      setNext(res.next);
    } else {
      const res = await api<{ results: ExportEntry[]; next: string | null }>('GET', `/v1/exports?${q}`);
      setExports((cur) => (before ? [...cur, ...res.results] : res.results));
      setNext(res.next);
    }
    setLoaded(true);
  }, [tab, object]);

  useEffect(() => {
    setLoaded(false);
    setError(null);
    setOpen(null);
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function toggle(e: ImportEntry) {
    if (open === e.key) { setOpen(null); return; }
    setOpen(e.key);
    if (problems[e.key] || e.error_rows === 0) return;
    setProblems((p) => ({ ...p, [e.key]: 'loading' }));
    try {
      const res = await api<{ results: Problem[] }>('GET', `/v1/imports/history/${encodeURIComponent(e.key)}/errors`);
      setProblems((p) => ({ ...p, [e.key]: res.results }));
    } catch (err) {
      setError((err as Error).message);
      setProblems((p) => { const { [e.key]: _, ...rest } = p; return rest; });
    }
  }

  function download(e: ImportEntry, list: Problem[]) {
    const csv = toCsv([['Row', 'Problem'], ...list.map((x) => [x.row ? String(x.row) : '', x.error])]);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${e.object?.api_name ?? 'import'}-import-${e.id}-problems.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const objectOptions = [
    { value: '', label: 'All objects' },
    ...[...objects].sort((a, b) => a.label_plural.localeCompare(b.label_plural)).map((o) => ({ value: o.api_name, label: o.label_plural }))
  ];
  const rows = tab === 'imports' ? imports : exports;

  return (
    <SettingsPage
      className="wide"
      title="Imports and exports"
      description={me.is_admin
        ? 'Every import and export, newest first. Click an import to see the rows it skipped.'
        : 'Your imports and exports, newest first. Click an import to see the rows it skipped.'}
    >
      <div className="settings-toolbar">
        <Select
          value={tab} onChange={(v) => setParam('tab', v === 'exports' ? 'exports' : '')}
          options={[{ value: 'imports', label: 'Imports' }, { value: 'exports', label: 'Exports' }]} aria-label="Show"
        />
        <Select value={object} onChange={(v) => setParam('object', v)} options={objectOptions} aria-label="Object" />
      </div>
      {error && <div className="error">{error}</div>}
      {!loaded && !error && <TableSkeleton rows={6} />}
      {loaded && rows.length === 0 && (
        <EmptyState icon={<History size={18} />} title={tab === 'imports' ? 'No imports' : 'No exports'}>
          {tab === 'imports'
            ? 'Imports started from a table\'s Import button, or through the API, show up here.'
            : 'Exports from a table\'s Export button, or through the API, show up here.'}
        </EmptyState>
      )}
      {loaded && tab === 'imports' && imports.length > 0 && (
        <div className="access-table">
          <table className="grid history-table">
            <thead>
              <tr><th /><th>Started</th><th>Object</th><th>Source</th><th>By</th><th>New</th><th>Updated</th><th>Skipped</th><th>Status</th></tr>
            </thead>
            <tbody>
              {imports.map((e) => {
                const isOpen = open === e.key;
                const list = problems[e.key];
                const [tone, label] = STATUS[e.status];
                return (
                  <Fragment key={e.key}>
                    <tr className="history-row" onClick={() => void toggle(e)} aria-expanded={isOpen}>
                      <td className="history-chevron">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                      <td>{when(e.started_at)}</td>
                      <td>{e.object?.label ?? ''}</td>
                      <td className="wrap">{e.file_name ?? (e.format === 'csv' ? 'CSV (API)' : 'Pasted rows or API')}</td>
                      <td>{who(e)}</td>
                      <td>{e.created_rows.toLocaleString()}</td>
                      <td>{e.updated_rows.toLocaleString()}</td>
                      <td>{e.error_rows.toLocaleString()}</td>
                      <td><StatusPill tone={tone}>{label}</StatusPill></td>
                    </tr>
                    {isOpen && (
                      <tr className="history-detail">
                        <td />
                        <td colSpan={8}>
                          <div className="history-facts">
                            <span>{e.total_rows.toLocaleString()} {e.total_rows === 1 ? 'row' : 'rows'}</span>
                            <span>{e.mode === 'upsert' && e.match_property ? `Existing records found by ${e.match_property}` : 'Every row added as a new record'}</span>
                            {e.finished_at && <span>Finished {when(e.finished_at)}</span>}
                            {e.batches > 1 && <span>Sent in {e.batches} batches</span>}
                          </div>
                          {e.error_rows === 0 && <p className="muted">No rows were skipped.</p>}
                          {list === 'loading' && <Loading inline label="Loading skipped rows" />}
                          {Array.isArray(list) && list.length > 0 && (
                            <div className="import-problems">
                              <div className="import-problems-head">
                                <strong>Skipped rows</strong>
                                <button className="btn small" onClick={() => download(e, list)}>Download as CSV</button>
                              </div>
                              <ul>
                                {list.slice(0, 200).map((x, i) => (
                                  <li key={i}>{x.row ? <span className="muted">Row {x.row}</span> : null} {x.error}</li>
                                ))}
                              </ul>
                              {list.length > 200 && <p className="muted small">The download has all {list.length.toLocaleString()}.</p>}
                              {list.length < e.error_rows && <p className="muted small">Only the first 1,000 problems of each batch are kept.</p>}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {loaded && tab === 'exports' && exports.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead><tr><th>When</th><th>Object</th><th>Rows</th><th>Records</th><th>Format</th><th>By</th></tr></thead>
            <tbody>
              {exports.map((e) => (
                <tr key={e.id}>
                  <td>{when(e.created_at)}</td>
                  <td>{e.object?.label ?? ''}</td>
                  <td>{e.row_count.toLocaleString()}</td>
                  <td className="wrap" title={JSON.stringify(e.filters)}>{filterSummary(e.filters)}</td>
                  <td>{e.format === 'xlsx' ? 'Excel' : 'CSV'}{e.filters.headings === 'labels' ? ', labels' : ''}</td>
                  <td>{who(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loaded && next && (
        <div className="load-more"><button className="btn" onClick={() => load(next).catch((err) => setError((err as Error).message))}>Load more</button></div>
      )}
    </SettingsPage>
  );
}
