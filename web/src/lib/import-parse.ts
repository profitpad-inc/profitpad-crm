// Reading rows for an import: pasted text, CSV/TSV files and Excel workbooks
// (.xls, .xlsx). The first row of every sheet holds the column headings.
// Excel is read with SheetJS, loaded only when a workbook is picked.

// A date cell from a workbook, kept as its parts so no time zone shifts it.
export interface SheetDate { kind: 'date'; y: number; m: number; d: number; h: number; mi: number; s: number; hasTime: boolean }
export type Cell = string | number | boolean | SheetDate;

export interface Sheet { name: string; headers: string[]; rows: Cell[][] }

export const MAX_IMPORT_ROWS = 10000;

export function isSheetDate(c: Cell): c is SheetDate {
  return typeof c === 'object' && c !== null && c.kind === 'date';
}

export function cellText(c: Cell): string {
  if (isSheetDate(c)) {
    const p = (n: number) => String(n).padStart(2, '0');
    const date = `${c.y}-${p(c.m)}-${p(c.d)}`;
    return c.hasTime ? `${date} ${p(c.h)}:${p(c.mi)}${c.s ? `:${p(c.s)}` : ''}` : date;
  }
  return String(c).trim();
}

// RFC 4180: quoted fields may hold the separator, newlines and "" for a quote.
export function parseDelimited(text: string, sep: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Tabs mean TSV (what a spreadsheet copies); otherwise CSV.
export function sniffSeparator(text: string): string {
  return text.includes('\t') ? '\t' : ',';
}

function blankRow(r: Cell[]): boolean {
  return r.every((c) => cellText(c) === '');
}

// Headings from the first row (blank ones become "Column N"), the rest as
// rows, without blank rows and padded to the heading count.
export function toSheet(name: string, grid: Cell[][]): Sheet {
  const all = grid.filter((r) => !blankRow(r));
  const first = all[0] ?? [];
  const width = Math.max(first.length, ...all.map((r) => r.length));
  // trailing columns with no heading and no values are dropped
  let cols = width;
  while (cols > 0 && cellText(first[cols - 1] ?? '') === '' && all.every((r) => cellText(r[cols - 1] ?? '') === '')) cols--;
  const headers = Array.from({ length: cols }, (_, i) => cellText(first[i] ?? '') || `Column ${i + 1}`);
  const rows = all.slice(1).map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  return { name, headers, rows };
}

export function parseText(text: string, name = 'Pasted rows'): Sheet {
  return toSheet(name, parseDelimited(text, sniffSeparator(text)));
}

export async function parseFile(file: File): Promise<Sheet[]> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'xls' || ext === 'xlsx') return parseWorkbook(await file.arrayBuffer());
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const text = await file.text();
    const sep = ext === 'tsv' ? '\t' : ext === 'csv' ? (firstLine(text).includes('\t') && !firstLine(text).includes(',') ? '\t' : ',') : sniffSeparator(text);
    return [toSheet(file.name, parseDelimited(text, sep))];
  }
  throw new Error('Pick a .csv, .tsv, .xls or .xlsx file.');
}

function firstLine(text: string): string {
  const i = text.search(/\r|\n/);
  return i < 0 ? text : text.slice(0, i);
}

async function parseWorkbook(buf: ArrayBuffer): Promise<Sheet[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array', cellNF: true, cellDates: false, dense: false });
  const sheets: Sheet[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const grid: Cell[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: Cell[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })] as { t: string; v?: unknown; z?: string; w?: string } | undefined;
        if (!cell || cell.v === undefined || cell.v === null) { row.push(''); continue; }
        if (cell.t === 'n' && typeof cell.v === 'number' && cell.z && XLSX.SSF.is_date(cell.z)) {
          const p = XLSX.SSF.parse_date_code(cell.v);
          if (p) {
            const hasTime = p.H !== 0 || p.M !== 0 || Math.floor(p.S) !== 0;
            row.push({ kind: 'date', y: p.y, m: p.m, d: p.d, h: p.H, mi: p.M, s: Math.floor(p.S), hasTime });
            continue;
          }
        }
        if (cell.t === 'n' || cell.t === 'b') row.push(cell.v as number | boolean);
        else if (cell.t === 'e') row.push('');
        else row.push(String(cell.v));
      }
      grid.push(row);
    }
    const sheet = toSheet(name, grid);
    if (sheet.headers.length > 0) sheets.push(sheet);
  }
  if (sheets.length === 0) throw new Error('That workbook has no rows.');
  return sheets;
}
