import { useState } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { api, ApiError, type ObjectDef } from '../lib/api';
import { Modal } from './ui';
import { Select } from './Select';
import '../import.css';

// Export a table's records as CSV or Excel (POST /v1/objects/{object}/exports,
// logged in the export history). Records: the view's (its search, sorts and
// the recycle bin), only the picked rows, or all. Columns: the view's
// properties in order, or every property. Labels as headings (and choice
// labels for dropdowns) read well and import straight back; internal names
// suit the API.

const MAX_EXPORT = 10000;

export interface ExportView {
  query?: string;
  status?: 'archived';
  sorts: { property: string; direction?: 'asc' | 'desc' }[];
  // property columns shown in the view (association columns are left out)
  properties: string[];
  total: number | null;
  picked: string[];
}

interface XlsxRows { columns: { key: string; label: string; type: string }[]; rows: unknown[][] }

const pad = (n: number) => String(n).padStart(2, '0');
const DAY = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// typed cells: numbers as numbers, dates and datetimes (in local time) as Excel dates
async function workbook(data: XlsxRows, sheetName: string): Promise<Blob> {
  const XLSX = await import('xlsx');
  const aoa: unknown[][] = [data.columns.map((c) => c.label)];
  for (const r of data.rows) {
    aoa.push(r.map((v, i) => {
      if (v === null || v === undefined) return null;
      const t = data.columns[i].type;
      if (t === 'number') { const n = Number(v); return Number.isFinite(n) ? n : v; }
      if (t === 'date' && typeof v === 'string') {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
        return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH) / DAY : v;
      }
      if (t === 'datetime' && typeof v === 'string') {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return v;
        return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - EPOCH) / DAY;
      }
      return String(v);
    }));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  data.columns.forEach((c, i) => {
    const z = c.type === 'date' ? 'yyyy-mm-dd' : c.type === 'datetime' ? 'yyyy-mm-dd hh:mm' : null;
    if (!z) return;
    for (let r = 1; r < aoa.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: i })];
      if (cell && cell.t === 'n') cell.z = z;
    }
  });
  ws['!cols'] = data.columns.map((c) => ({ wch: Math.min(40, Math.max(10, c.label.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Records');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function ExportModal({ object, view, onClose }: { object: ObjectDef; view: ExportView; onClose: () => void }) {
  const plural = object.label_plural.toLowerCase();
  const [records, setRecords] = useState<'view' | 'picked' | 'all'>(view.picked.length > 0 ? 'picked' : 'view');
  const [columns, setColumns] = useState<'view' | 'all'>('view');
  const [headings, setHeadings] = useState<'labels' | 'names'>('labels');
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const filtered = !!view.query || view.status === 'archived';

  async function run() {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      headings, format,
      sorts: view.sorts,
      ...(columns === 'view' && view.properties.length > 0 ? { properties: view.properties } : {}),
      ...(records !== 'all' && view.status ? { status: view.status } : {}),
      ...(records === 'view' && view.query ? { query: view.query } : {}),
      ...(records === 'picked' ? { filter_groups: [{ filters: [{ property: 'id', operator: 'in', values: view.picked }] }] } : {})
    };
    const d = new Date();
    const name = `${object.api_name}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    try {
      if (format === 'xlsx') {
        const data = await api<XlsxRows>('POST', `/v1/objects/${object.api_name}/exports`, body);
        save(await workbook(data, object.label_plural), `${name}.xlsx`);
        setDone(data.rows.length);
      } else {
        const csv = await api<string>('POST', `/v1/objects/${object.api_name}/exports`, body);
        // the byte order mark makes Excel read the file as UTF-8
        save(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
        setDone(Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const count = records === 'picked' ? view.picked.length : records === 'view' ? view.total : null;

  return (
    <Modal
      title={`Export ${plural}`}
      onClose={onClose}
      locked={busy}
      className="export-modal"
      footer={done === null ? (
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void run()} disabled={busy}>{busy ? 'Exporting…' : 'Export'}</button>
        </>
      ) : (
        <>
          <Link className="btn" to={`/settings/imports?tab=exports&object=${object.api_name}`}><History size={16} /> Export history</Link>
          <button className="btn primary" onClick={onClose}>Done</button>
        </>
      )}
    >
      {error && <div className="error">{error}</div>}
      {done !== null ? (
        <p>Exported {done.toLocaleString()} {done === 1 ? 'record' : 'records'}. The file is in your downloads.</p>
      ) : (
        <div className="export-form">
          <label className="field">
            <span>Records</span>
            <Select
              value={records} onChange={(v) => setRecords(v as typeof records)} aria-label="Records"
              options={[
                ...(view.picked.length > 0 ? [{ value: 'picked', label: `The ${view.picked.length.toLocaleString()} picked ${view.picked.length === 1 ? 'row' : 'rows'}` }] : []),
                { value: 'view', label: filtered ? `This view's records${view.total !== null ? ` (${view.total.toLocaleString()})` : ''}` : `All ${plural}${view.total !== null ? ` (${view.total.toLocaleString()})` : ''}` },
                ...(filtered ? [{ value: 'all', label: view.status === 'archived' ? `All ${plural} in the recycle bin` : `All ${plural}, without the search` }] : [])
              ]}
            />
          </label>
          <label className="field">
            <span>Columns</span>
            <Select
              value={columns} onChange={(v) => setColumns(v as typeof columns)} aria-label="Columns"
              options={[{ value: 'view', label: 'The columns in this view' }, { value: 'all', label: 'Every property' }]}
            />
          </label>
          <label className="field">
            <span>Headings</span>
            <Select
              value={headings} onChange={(v) => setHeadings(v as typeof headings)} aria-label="Headings"
              options={[{ value: 'labels', label: 'Labels (easy to read, imports back)' }, { value: 'names', label: 'Internal names and values (for the API)' }]}
            />
          </label>
          <label className="field">
            <span>Format</span>
            <Select
              value={format} onChange={(v) => setFormat(v as typeof format)} aria-label="Format"
              options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel (.xlsx)' }]}
            />
          </label>
          {count !== null && count > MAX_EXPORT && <p className="muted small">Only the first {MAX_EXPORT.toLocaleString()} records are exported.</p>}
          <p className="muted small">Every record gets its Record ID first. Exports are listed in Settings, Imports and exports.</p>
        </div>
      )}
    </Modal>
  );
}
