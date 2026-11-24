import { useMemo, useRef, useState, type ReactNode } from 'react';
import { FileSpreadsheet, History, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ObjectDef, type Property } from '../lib/api';
import { useApp } from '../lib/app-context';
import { MAX_IMPORT_ROWS, cellText, parseFile, parseText, type Sheet } from '../lib/import-parse';
import {
  IMPORTABLE_TYPES, convertCell, detectDateOrder, dropdownParts, guessProperty, isMultiValue, matchOption, newApiValue, toCsv,
  type DateOrder
} from '../lib/import-values';
import { Modal, isEditable } from './ui';
import { Select } from './Select';
import { Loading } from './Loading';
import '../import.css';

// Import records of one object from a CSV, TSV, .xls or .xlsx file or pasted
// rows (tabs, else commas). Steps: pick the rows, match columns to
// properties (and the one unique property that finds existing records),
// settle values that wouldn't be accepted (phones, emails, patterns, numbers,
// dates: fix, leave empty or skip the row) and dropdown values that match no
// choice, check every row with a dry
// run, then import in batches. No associations: one object at a time.

type Step = 'source' | 'map' | 'values' | 'review' | 'running' | 'done';

const ADD = '__add';
const SKIP = '__skip';
const BATCH = 1000;

interface Problem { row: number; error: string }
interface Outcome { created: number; updated: number; problems: Problem[] }
interface ImportResult { created_rows: number; updated_rows: number; error_rows: number; errors: { row: number; error: string }[] | null }

interface Built {
  rows: Record<string, unknown>[];
  // the sheet row number (headings are row 1) of each row sent
  rowNumbers: number[];
  problems: Problem[];
  newOptions: Record<string, { api_value: string; label: string }[]>;
}

const key = (v: string) => v.trim().toLowerCase();

// a bad cell: typed again (text, and why it is still refused, if it is), left
// empty, or its rows skipped; '' while nothing is picked
type Fix = { action: 'fix'; text: string; error?: string | null } | { action: 'empty' } | { action: 'skip' } | { action: '' };
const CHECK_CHUNK = 20000;

export function ImportModal({ object, onClose, onImported }: { object: ObjectDef; onClose: () => void; onImported: () => void }) {
  const { me } = useApp();
  const [step, setStep] = useState<Step>('source');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [paste, setPaste] = useState('');
  // the picked file's name, for the import history (null for pasted rows)
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [mapping, setMapping] = useState<string[]>([]);
  const [dedupe, setDedupe] = useState('');
  const [dateOrders, setDateOrders] = useState<Record<number, DateOrder>>({});
  // property -> lower-cased typed value -> ADD, SKIP, a choice's api_value or '' (not picked yet)
  const [resolutions, setResolutions] = useState<Record<string, Record<string, string>>>({});
  // cells a write would refuse or that aren't usable (phones, emails, patterns,
  // numbers, dates), found right after the columns are matched:
  // property -> cell text -> why and how many rows
  const [formatProblems, setFormatProblems] = useState<Map<string, Map<string, { error: string; count: number }>>>(new Map());
  // property -> cell text -> what to do with it
  const [fixes, setFixes] = useState<Record<string, Record<string, Fix>>>({});
  const [scanning, setScanning] = useState(false);

  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<Outcome | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const sheet = sheets?.[sheetIdx] ?? null;
  const singular = object.label_singular.toLowerCase();
  const plural = object.label_plural.toLowerCase();

  const props = useMemo(
    () => object.properties
      .filter((p) => isEditable(p) && (IMPORTABLE_TYPES as readonly string[]).includes(p.type))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [object]
  );
  const propByName = useMemo(() => new Map(props.map((p) => [p.api_name, p])), [props]);
  const canAddTo = (p: Property) => p.options.auto_append_users !== true && (me.scopes.includes('schema') || p.options.allow_user_add === true);

  // ---- step 1: the rows -------------------------------------------------------
  function takeSheets(list: Sheet[], idx = 0) {
    const s = list[idx];
    if (!s || s.rows.length === 0) throw new Error('No rows under the headings. The first row must be the column headings.');
    if (s.rows.length > MAX_IMPORT_ROWS) throw new Error(`That is ${s.rows.length.toLocaleString()} rows; an import takes at most ${MAX_IMPORT_ROWS.toLocaleString()}.`);
    setSheets(list);
    setSheetIdx(idx);
    startMapping(s);
    setStep('map');
  }

  function startMapping(s: Sheet) {
    const used = new Set<string>();
    const m = s.headers.map((h) => {
      const g = guessProperty(h, props, used);
      if (g) used.add(g);
      return g;
    });
    setMapping(m);
    const unique = m.find((n) => isDedupeProp(propByName.get(n)));
    setDedupe(unique ?? '');
    const orders: Record<number, DateOrder> = {};
    s.headers.forEach((_, i) => {
      const found = detectDateOrder(s.rows.map((r) => r[i]));
      if (found) orders[i] = found;
    });
    setDateOrders(orders);
    setResolutions({});
    setFixes({});
  }

  async function readFile(file: File) {
    setError(null);
    setReading(true);
    try {
      takeSheets(await parseFile(file));
      setFileName(file.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function readPaste() {
    setError(null);
    try {
      takeSheets([parseText(paste)]);
      setFileName(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function pickSheet(idx: number) {
    if (!sheets) return;
    setError(null);
    try {
      takeSheets(sheets, idx);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---- step 2: columns ----------------------------------------------------------
  function isDedupeProp(p: Property | undefined): boolean {
    return !!p && (p.type === 'text' || p.type === 'email' || p.type === 'phone') && p.options.unique === true;
  }

  const dedupeChoices = mapping.filter((n) => isDedupeProp(propByName.get(n)));
  const mappedCount = mapping.filter(Boolean).length;

  // dropdown values that match no choice, per property, in sheet order
  const unmatched = useMemo(() => {
    const out = new Map<string, Map<string, { text: string; count: number }>>();
    if (!sheet) return out;
    mapping.forEach((name, col) => {
      const p = propByName.get(name);
      if (!p || p.type !== 'dropdown') return;
      for (const r of sheet.rows) {
        for (const v of dropdownParts(p, r[col])) {
          if (matchOption(p, v) !== null) continue;
          const m = out.get(name) ?? new Map();
          const k = key(v);
          const cur = m.get(k);
          m.set(k, { text: cur?.text ?? v, count: (cur?.count ?? 0) + 1 });
          out.set(name, m);
        }
      }
    });
    return out;
  }, [sheet, mapping, propByName]);

  // the API's verdict on text cells (phone numbers, email addresses, patterns)
  async function checkTexts(name: string, texts: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < texts.length; i += CHECK_CHUNK) {
      const res = await api<{ problems: Record<string, { value: string; error: string }[]> }>(
        'POST', `/v1/objects/${object.api_name}/imports/check-values`, { values: { [name]: texts.slice(i, i + CHECK_CHUNK) } }
      );
      for (const pr of res.problems[name] ?? []) out.set(pr.value, pr.error);
    }
    return out;
  }

  // every mapped column's cells, checked before anything else: numbers and
  // dates here, text cells by the API
  async function scanFormats(): Promise<Map<string, Map<string, { error: string; count: number }>>> {
    const s = sheet!;
    const found = new Map<string, Map<string, { error: string; count: number }>>();
    const add = (name: string, text: string, error: string) => {
      const m = found.get(name) ?? new Map<string, { error: string; count: number }>();
      const cur = m.get(text);
      m.set(text, { error, count: (cur?.count ?? 0) + 1 });
      found.set(name, m);
    };
    for (const [col, name] of mapping.entries()) {
      const p = propByName.get(name);
      if (!p || p.type === 'dropdown') continue;
      if (p.type === 'text' || p.type === 'email' || p.type === 'phone') {
        const counts = new Map<string, number>();
        for (const r of s.rows) {
          const t = cellText(r[col]);
          if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const bad = await checkTexts(name, [...counts.keys()]);
        for (const [t, error] of bad) {
          const m = found.get(name) ?? new Map<string, { error: string; count: number }>();
          m.set(t, { error, count: counts.get(t) ?? 1 });
          found.set(name, m);
        }
        continue;
      }
      for (const r of s.rows) {
        const c = convertCell(p, r[col], dateOrders[col] ?? 'mdy');
        if (!c.ok) add(name, cellText(r[col]), c.error.replace(/^".*?" is /, 'is '));
      }
    }
    return found;
  }

  async function goToValues() {
    setError(null);
    setScanning(true);
    let found: Map<string, Map<string, { error: string; count: number }>>;
    try {
      found = await scanFormats();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      return;
    } finally {
      setScanning(false);
    }
    setFormatProblems(found);
    // keep earlier picks for the same values; new ones start unpicked
    const nextFixes: Record<string, Record<string, Fix>> = {};
    for (const [name, values] of found) {
      nextFixes[name] = {};
      for (const t of values.keys()) nextFixes[name][t] = fixes[name]?.[t] ?? { action: '' };
    }
    setFixes(nextFixes);
    // dropdowns: add the value when allowed, otherwise ask
    const next: Record<string, Record<string, string>> = {};
    for (const [name, values] of unmatched) {
      const p = propByName.get(name)!;
      next[name] = {};
      for (const k of values.keys()) next[name][k] = resolutions[name]?.[k] ?? (canAddTo(p) ? ADD : '');
    }
    setResolutions(next);
    if (unmatched.size > 0 || found.size > 0) setStep('values');
    else void startReview();
  }

  // a typed fix: checked like the cell it replaces
  async function checkFix(name: string, text: string, typed: string) {
    const p = propByName.get(name)!;
    const col = mapping.indexOf(name);
    let why: string | null = null;
    if (typed.trim() === '') why = 'type a value, or pick Leave empty';
    else if (p.type === 'text' || p.type === 'email' || p.type === 'phone') why = (await checkTexts(name, [typed.trim()]).catch(() => new Map<string, string>())).get(typed.trim()) ?? null;
    else {
      const c = convertCell(p, typed, dateOrders[col] ?? 'mdy');
      why = c.ok ? null : c.error;
    }
    setFixes((cur) => {
      const f = cur[name]?.[text];
      if (!f || f.action !== 'fix' || f.text !== typed) return cur;
      return { ...cur, [name]: { ...cur[name], [text]: { action: 'fix', text: typed, error: why } } };
    });
  }

  const setFix = (name: string, text: string, fix: Fix) => setFixes((cur) => ({ ...cur, [name]: { ...cur[name], [text]: fix } }));
  const setAllFixes = (name: string, action: 'empty' | 'skip') =>
    setFixes((cur) => ({ ...cur, [name]: Object.fromEntries(Object.keys(cur[name] ?? {}).map((t) => [t, { action }])) }));

  const unresolved =
    [...unmatched].some(([name, values]) => [...values.keys()].some((k) => !resolutions[name]?.[k])) ||
    Object.values(fixes).some((m) => Object.values(m).some((f) => f.action === '' || (f.action === 'fix' && (f.error !== null || f.text.trim() === ''))));

  // ---- step 4: build, check, import ------------------------------------------
  function build(): Built {
    const s = sheet!;
    const newOptions: Record<string, { api_value: string; label: string }[]> = {};
    const newValue = new Map<string, Map<string, string>>();
    for (const [name, values] of unmatched) {
      const p = propByName.get(name)!;
      const taken = new Set((p.dropdown_options ?? []).map((o) => o.api_value.toLowerCase()));
      for (const [k, { text }] of values) {
        if (resolutions[name]?.[k] !== ADD) continue;
        const api_value = newApiValue(text, taken);
        (newOptions[name] ??= []).push({ api_value, label: text.trim() });
        const m = newValue.get(name) ?? new Map<string, string>();
        m.set(k, api_value);
        newValue.set(name, m);
      }
    }
    const rows: Record<string, unknown>[] = [];
    const rowNumbers: number[] = [];
    const problems: Problem[] = [];
    s.rows.forEach((r, i) => {
      const rowNo = i + 2;
      const out: Record<string, unknown> = {};
      const errs: string[] = [];
      mapping.forEach((name, col) => {
        const p = propByName.get(name);
        if (!p) return;
        if (p.type === 'dropdown') {
          const vals: string[] = [];
          for (const v of dropdownParts(p, r[col])) {
            const hit = matchOption(p, v);
            if (hit) { vals.push(hit); continue; }
            const pick = resolutions[name]?.[key(v)];
            if (pick === ADD) vals.push(newValue.get(name)!.get(key(v))!);
            else if (pick && pick !== SKIP) vals.push(pick);
          }
          const unique = [...new Set(vals)];
          if (unique.length === 0) return;
          if (!isMultiValue(p) && unique.length > 1) { errs.push(`${p.label}: only one value is allowed`); return; }
          out[name] = isMultiValue(p) ? unique : unique[0];
          return;
        }
        const raw = cellText(r[col]);
        const fix = raw ? fixes[name]?.[raw] : undefined;
        if (fix?.action === 'empty') return;
        if (fix?.action === 'skip') {
          errs.push(`${p.label}: "${raw}" ${formatProblems.get(name)?.get(raw)?.error ?? 'was skipped'}`);
          return;
        }
        const c = convertCell(p, fix?.action === 'fix' ? fix.text.trim() : r[col], dateOrders[col] ?? 'mdy');
        if (!c.ok) errs.push(`${p.label}: ${c.error}`);
        else if (c.value !== undefined) out[name] = c.value;
      });
      if (errs.length > 0) { problems.push({ row: rowNo, error: errs.join('; ') }); return; }
      if (Object.keys(out).length === 0) return;
      rows.push(out);
      rowNumbers.push(rowNo);
    });
    return { rows, rowNumbers, problems, newOptions };
  }

  function body(b: Built, offset: number, rows: Record<string, unknown>[], extra: Record<string, unknown>) {
    return {
      format: 'json', data: rows, row_numbers: b.rowNumbers.slice(offset, offset + rows.length),
      mode: dedupe ? 'upsert' : 'create', ...(dedupe ? { id_property: dedupe } : {}),
      ...(Object.keys(b.newOptions).length > 0 ? { new_options: b.newOptions } : {}), ...extra
    };
  }

  // errors carry the sheet's row numbers (row_numbers); rows skipped here are counted already
  const serverProblems = (b: Built, errors: ImportResult['errors']): Problem[] => {
    const skipped = new Set(b.problems.map((x) => x.row));
    return (errors ?? []).filter((e) => !skipped.has(e.row)).map((e) => ({ row: e.row, error: e.error }));
  };

  async function startReview() {
    setStep('review');
    setError(null);
    setCheck(null);
    const b = build();
    setBuilt(b);
    if (b.rows.length === 0) {
      setCheck({ created: 0, updated: 0, problems: b.problems });
      return;
    }
    setChecking(true);
    try {
      const res = await api<ImportResult>('POST', `/v1/objects/${object.api_name}/imports`, body(b, 0, b.rows, { dry_run: true }));
      setCheck({
        created: res.created_rows, updated: res.updated_rows,
        problems: [...b.problems, ...serverProblems(b, res.errors)].sort((x, y) => x.row - y.row)
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function runImport() {
    const b = built!;
    setStep('running');
    setProgress(0);
    setError(null);
    const total: Outcome = { created: 0, updated: 0, problems: [...b.problems] };
    // one entry in the import history for all the batches
    const history = { batch_id: crypto.randomUUID(), ...(fileName ? { file_name: fileName.slice(0, 255) } : {}) };
    try {
      for (let i = 0; i < b.rows.length; i += BATCH) {
        const chunk = b.rows.slice(i, i + BATCH);
        // new choices and the rows skipped here go with the first batch; later batches already carry the new values
        const req = i === 0
          ? body(b, i, chunk, { ...history, ...(b.problems.length > 0 ? { skipped: b.problems } : {}) })
          : { ...body(b, i, chunk, history), new_options: undefined };
        const res = await api<ImportResult>('POST', `/v1/objects/${object.api_name}/imports`, req);
        total.created += res.created_rows;
        total.updated += res.updated_rows;
        total.problems.push(...serverProblems(b, res.errors));
        setProgress(Math.min(b.rows.length, i + BATCH));
      }
    } catch (e) {
      setError(`${e instanceof ApiError ? e.message : (e as Error).message}. Rows before this batch were imported.`);
    }
    total.problems.sort((x, y) => x.row - y.row);
    setOutcome(total);
    setStep('done');
    onImported();
  }

  function downloadProblems(problems: Problem[]) {
    const s = sheet!;
    const lines = [[...s.headers, 'Row', 'Problem']];
    for (const pr of problems) {
      const r = s.rows[pr.row - 2] ?? [];
      lines.push([...s.headers.map((_, i) => cellText(r[i] ?? '')), String(pr.row), pr.error]);
    }
    const url = URL.createObjectURL(new Blob([toCsv(lines)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${object.api_name}-import-problems.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- rendering ----------------------------------------------------------------
  const sample = (col: number) => {
    const vals: string[] = [];
    for (const r of sheet?.rows ?? []) {
      const t = cellText(r[col]);
      if (t && !vals.includes(t)) vals.push(t);
      if (vals.length === 3) break;
    }
    return vals;
  };

  const propOptions = (col: number) => [
    { value: '', label: "Don't import" },
    ...props.map((p) => ({ value: p.api_name, label: p.label, disabled: mapping.some((n, i) => i !== col && n === p.api_name) }))
  ];

  const problemList = (problems: Problem[]) => problems.length > 0 && (
    <div className="import-problems">
      <div className="import-problems-head">
        <strong>{problems.length.toLocaleString()} {problems.length === 1 ? 'row has a problem' : 'rows have problems'}</strong>
        <button className="btn small" onClick={() => downloadProblems(problems)}>Download as CSV</button>
      </div>
      <ul>
        {problems.slice(0, 100).map((pr, i) => <li key={i}><span className="muted">Row {pr.row}</span> {pr.error}</li>)}
      </ul>
      {problems.length > 100 && <p className="muted small">The download has all of them.</p>}
    </div>
  );

  let content: ReactNode = null;
  let footer: ReactNode = null;

  if (step === 'source') {
    content = (
      <div className="import-source">
        <div
          className={`import-drop${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) void readFile(f);
          }}
        >
          {reading ? <Loading label="Reading the file" /> : (
            <>
              <FileSpreadsheet size={28} strokeWidth={1.5} aria-hidden />
              <p>Drop a CSV, TSV, .xls or .xlsx file here</p>
              <button className="btn" onClick={() => fileRef.current?.click()}><Upload size={16} /> Choose a file</button>
            </>
          )}
          <input
            ref={fileRef} type="file" hidden accept=".csv,.tsv,.txt,.xls,.xlsx,text/csv,text/tab-separated-values,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }}
          />
        </div>
        <label className="import-paste">
          <span>Or paste rows (copied from a spreadsheet, or comma separated)</span>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={6} placeholder={'Name\tEmail\nAda Lovelace\tada@example.com'} spellCheck={false} />
        </label>
        <p className="muted small">
          The first row must be the column headings. Up to {MAX_IMPORT_ROWS.toLocaleString()} rows.{' '}
          <Link to={`/settings/imports?object=${object.api_name}`}><History size={13} className="import-link-icon" /> Past imports</Link>
        </p>
      </div>
    );
    footer = (
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={paste.trim() === ''} onClick={readPaste}>Use pasted rows</button>
      </>
    );
  } else if (step === 'map' && sheet) {
    content = (
      <div className="import-map">
        <div className="import-map-top">
          <p>{sheet.rows.length.toLocaleString()} {sheet.rows.length === 1 ? 'row' : 'rows'} from <strong>{sheet.name}</strong>. Pick the property each column goes into.</p>
          {sheets && sheets.length > 1 && (
            <label className="import-inline">Sheet
              <Select value={sheetIdx} onChange={(v) => pickSheet(Number(v))} options={sheets.map((s, i) => ({ value: String(i), label: s.name }))} aria-label="Sheet" />
            </label>
          )}
        </div>
        <table className="import-table">
          <thead><tr><th>Column</th><th>Sample values</th><th>Property</th></tr></thead>
          <tbody>
            {sheet.headers.map((h, col) => {
              const p = propByName.get(mapping[col]);
              const dates = p && (p.type === 'date' || p.type === 'datetime') && detectDateOrder(sheet.rows.map((r) => r[col])) !== undefined;
              return (
                <tr key={col}>
                  <td className="import-col">{h}</td>
                  <td className="import-sample">{sample(col).join(', ') || <span className="muted">empty</span>}</td>
                  <td>
                    <Select
                      value={mapping[col] ?? ''} search
                      onChange={(v) => {
                        const next = [...mapping];
                        next[col] = v;
                        setMapping(next);
                        if (dedupe && !next.includes(dedupe)) setDedupe(next.find((n) => isDedupeProp(propByName.get(n))) ?? '');
                        if (!dedupe && isDedupeProp(propByName.get(v))) setDedupe(v);
                      }}
                      options={propOptions(col)} aria-label={`Property for ${h}`}
                    />
                    {p && p.type === 'dropdown' && isMultiValue(p) && <div className="muted small">Separate values with ;</div>}
                    {dates && (
                      <div className="import-date-order">
                        <Select
                          value={dateOrders[col] ?? 'mdy'}
                          onChange={(v) => setDateOrders({ ...dateOrders, [col]: v as DateOrder })}
                          options={[{ value: 'mdy', label: 'Dates are month/day/year' }, { value: 'dmy', label: 'Dates are day/month/year' }]}
                          aria-label={`Date order for ${h}`}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="import-dedupe">
          <label htmlFor="import-dedupe">Find existing {plural} by</label>
          <Select
            id="import-dedupe" value={dedupe} onChange={setDedupe}
            options={[
              { value: '', label: `Nothing: every row is a new ${singular}` },
              ...dedupeChoices.map((n) => ({ value: n, label: propByName.get(n)!.label }))
            ]}
          />
          <p className="muted small">
            {dedupe
              ? `Rows whose ${propByName.get(dedupe)!.label} matches a ${singular} update it (empty cells leave its values alone); other rows become new ${plural}.`
              : dedupeChoices.length === 0 ? 'Map a column to a unique property (such as email) to update existing records instead of adding duplicates.' : 'Every row is added, even if it matches an existing record.'}
          </p>
        </div>
      </div>
    );
    footer = (
      <>
        <button className="btn" onClick={() => setStep('source')}>Back</button>
        <button className="btn primary" disabled={mappedCount === 0 || scanning} onClick={() => void goToValues()}>
          {scanning ? <Loading inline label="Checking values" /> : 'Next'}
        </button>
      </>
    );
  } else if (step === 'values') {
    content = (
      <div className="import-values">
        {formatProblems.size > 0 && <p>Some values wouldn't be accepted as they are. Fix each one, leave it empty, or skip its rows.</p>}
        {[...formatProblems].map(([name, values]) => {
          const p = propByName.get(name)!;
          const list = [...values];
          return (
            <section key={`f-${name}`} className="import-values-prop">
              <div className="import-values-head">
                <h3>{p.label}</h3>
                {list.length > 1 && (
                  <Select
                    value="" face="For all of them…" aria-label={`Every ${p.label} value`}
                    onChange={(v) => setAllFixes(name, v as 'empty' | 'skip')}
                    options={[{ value: 'empty', label: 'Leave them all empty' }, { value: 'skip', label: 'Skip all their rows' }]}
                  />
                )}
              </div>
              <table className="import-table">
                <tbody>
                  {list.slice(0, 200).map(([text, { error: why, count }]) => {
                    const f = fixes[name]?.[text] ?? { action: '' };
                    return (
                      <tr key={text}>
                        <td className="import-col">
                          {text} <span className="muted small">({count.toLocaleString()} {count === 1 ? 'row' : 'rows'})</span>
                          <div className="import-why">{why}</div>
                        </td>
                        <td>
                          <Select
                            value={f.action}
                            onChange={(v) => setFix(name, text, v === 'fix' ? { action: 'fix', text, error: undefined } : { action: v as 'empty' | 'skip' })}
                            options={[
                              { value: '', label: 'Pick one', disabled: true },
                              { value: 'fix', label: 'Fix it' },
                              { value: 'empty', label: 'Leave empty' },
                              { value: 'skip', label: count === 1 ? 'Skip the row' : 'Skip these rows' }
                            ]}
                            aria-label={`What to do with ${text}`}
                          />
                          {f.action === 'fix' && (
                            <>
                              <input
                                className="import-fix" value={f.text} autoFocus aria-label={`New value for ${text}`}
                                onChange={(e) => {
                                  const typed = e.target.value;
                                  setFix(name, text, { action: 'fix', text: typed, error: undefined });
                                  window.setTimeout(() => void checkFix(name, text, typed), 400);
                                }}
                                onBlur={(e) => void checkFix(name, text, e.target.value)}
                              />
                              {f.error && <div className="error prop-error">{f.error}</div>}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {list.length > 200 && <p className="muted small">{(list.length - 200).toLocaleString()} more values not shown; "For all of them" covers them too.</p>}
            </section>
          );
        })}
        {unmatched.size > 0 && <p>Some dropdown values don't match a choice by internal value or label. Pick what each one becomes.</p>}
        {[...unmatched].map(([name, values]) => {
          const p = propByName.get(name)!;
          const canAdd = canAddTo(p);
          const choices = (p.dropdown_options ?? []).filter((o) => o.record_status === 'active');
          return (
            <section key={name} className="import-values-prop">
              <h3>{p.label}</h3>
              {!canAdd && <p className="muted small">You can't add choices to {p.label}; match each value to an existing one or leave it empty.</p>}
              <table className="import-table">
                <tbody>
                  {[...values].map(([k, { text, count }]) => (
                    <tr key={k}>
                      <td className="import-col">{text} <span className="muted small">({count.toLocaleString()} {count === 1 ? 'row' : 'rows'})</span></td>
                      <td>
                        <Select
                          value={resolutions[name]?.[k] ?? ''}
                          onChange={(v) => setResolutions({ ...resolutions, [name]: { ...resolutions[name], [k]: v } })}
                          options={[
                            { value: '', label: 'Pick one', disabled: true },
                            ...(canAdd ? [{ value: ADD, label: `Add "${text.trim()}" as a new choice` }] : []),
                            { value: SKIP, label: 'Leave empty' },
                            ...choices.map((o) => ({ value: o.api_value, label: o.label }))
                          ]}
                          aria-label={`Choice for ${text}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
    );
    footer = (
      <>
        <button className="btn" onClick={() => setStep('map')}>Back</button>
        <button className="btn primary" disabled={unresolved} onClick={() => void startReview()}>Next</button>
      </>
    );
  } else if (step === 'review') {
    const added = built ? Object.entries(built.newOptions) : [];
    content = (
      <div className="import-review">
        {checking && <Loading label="Checking every row" />}
        {check && (
          <>
            <div className="import-counts">
              <div><strong>{check.created.toLocaleString()}</strong><span>new {check.created === 1 ? singular : plural}</span></div>
              <div><strong>{check.updated.toLocaleString()}</strong><span>{check.updated === 1 ? `${singular} updated` : `${plural} updated`}</span></div>
              <div><strong>{check.problems.length.toLocaleString()}</strong><span>{check.problems.length === 1 ? 'row skipped' : 'rows skipped'}</span></div>
            </div>
            {added.length > 0 && (
              <p className="muted">
                New choices: {added.map(([name, list]) => `${propByName.get(name)!.label} (${list.map((o) => o.label).join(', ')})`).join('; ')}.
              </p>
            )}
            {problemList(check.problems)}
            <p className="muted small">Nothing has been saved yet.</p>
          </>
        )}
      </div>
    );
    const ready = !!check && check.created + check.updated > 0;
    footer = (
      <>
        <button className="btn" disabled={checking} onClick={() => setStep(unmatched.size > 0 || formatProblems.size > 0 ? 'values' : 'map')}>Back</button>
        <button className="btn primary" disabled={!ready || checking} onClick={() => void runImport()}>
          Import {check ? (check.created + check.updated).toLocaleString() : ''} {check && check.created + check.updated === 1 ? 'row' : 'rows'}
        </button>
      </>
    );
  } else if (step === 'running') {
    content = <Loading label={`Imported ${progress.toLocaleString()} of ${(built?.rows.length ?? 0).toLocaleString()} rows`} />;
    footer = <span className="muted">Imported {progress.toLocaleString()} of {(built?.rows.length ?? 0).toLocaleString()} rows…</span>;
  } else if (step === 'done' && outcome) {
    content = (
      <div className="import-review">
        <div className="import-counts">
          <div><strong>{outcome.created.toLocaleString()}</strong><span>new {outcome.created === 1 ? singular : plural}</span></div>
          <div><strong>{outcome.updated.toLocaleString()}</strong><span>{outcome.updated === 1 ? `${singular} updated` : `${plural} updated`}</span></div>
          <div><strong>{outcome.problems.length.toLocaleString()}</strong><span>{outcome.problems.length === 1 ? 'row skipped' : 'rows skipped'}</span></div>
        </div>
        {problemList(outcome.problems)}
      </div>
    );
    footer = (
      <>
        <Link className="btn" to={`/settings/imports?object=${object.api_name}`}><History size={16} /> Import history</Link>
        <button className="btn primary" onClick={onClose}>Done</button>
      </>
    );
  }

  return (
    <Modal
      title={step !== 'done' ? `Import ${plural}` : error ? 'Import stopped partway' : `${object.label_plural} imported successfully`}
      onClose={onClose} wide locked={step === 'running' || checking} className="import-modal" footer={footer}>
      {error && <div className="error">{error}</div>}
      {content}
    </Modal>
  );
}
