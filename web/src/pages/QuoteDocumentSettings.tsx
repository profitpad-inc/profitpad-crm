import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { api, type ObjectDef, type Property } from '../lib/api';
import { useApp } from '../lib/app-context';
import { SaveBar, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';

// Settings -> Quote document (admins): what quotes show beyond the title,
// parties, lines and total, on the PDF and the customer's quote page alike.
// Stored in ui.settings key 'quote_document' and checked by the API
// (api/src/quote-document.ts, which also lists the rules mirrored here).

interface Column { property: string; label?: string | null; width?: number | null }
interface Field { property: string; label?: string | null; place: 'details' | 'terms' }
interface Table { title: string; object: string; columns: Column[]; sort?: { property: string; direction: 'asc' | 'desc' } | null }
interface Config {
  orientation: 'portrait' | 'landscape';
  item_label: string | null;
  item_width: number | null;
  line_columns: Column[] | null;
  fields: Field[];
  terms_title: string | null;
  tables: Table[];
}

const EMPTY: Config = { orientation: 'portrait', item_label: null, item_width: null, line_columns: null, fields: [], terms_title: null, tables: [] };
const BUILTIN: Record<string, { label: string; width: number }> = {
  quantity: { label: 'Qty', width: 10 },
  unit_price: { label: 'Unit price', width: 17 },
  discount: { label: 'Discount', width: 15 },
  amount: { label: 'Amount', width: 18 }
};
const DEFAULT_COLUMNS: Column[] = Object.keys(BUILTIN).map((property) => ({ property }));
const HIDDEN = new Set(['public_key', 'customer_signature', 'countersigner_signature', 'signing_fields', 'signed_fields', 'customer_ip', 'responder_email']);
const ITEM_PROPS = new Set(['name', 'sku']);
const EXTRA_WIDTH = 12;

const showable = (p: Property) => p.record_status === 'active' && !HIDDEN.has(p.api_name) && !['file', 'id', 'id_list'].includes(p.type);

function move<T>(list: T[], i: number, by: number): T[] {
  const next = [...list];
  const [x] = next.splice(i, 1);
  next.splice(i + by, 0, x);
  return next;
}

// '' -> null, else a whole number from 1 to 100
const widthOf = (raw: string): number | null => {
  if (!raw.trim()) return null;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : null;
};

export function QuoteDocumentSettings() {
  const { toast, objectByName } = useApp();
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [schemas, setSchemas] = useState<Record<string, ObjectDef>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<Record<string, unknown>>('GET', '/v1/ui/settings'),
      api<ObjectDef>('GET', '/v1/schema/quotes'),
      api<ObjectDef>('GET', '/v1/schema/lines')
    ]).then(([settings, quotes, lines]) => {
      const c = { ...EMPTY, ...((settings.quote_document as Partial<Config> | undefined) ?? {}) };
      setSaved(c);
      setDraft(c);
      setSchemas({ quotes, lines });
    }).catch((err) => setError((err as Error).message));
  }, []);

  // the schemas of objects the extra tables read
  const tableObjects = draft?.tables.map((t) => t.object).join(',') ?? '';
  useEffect(() => {
    for (const name of tableObjects.split(',').filter(Boolean)) {
      if (schemas[name]) continue;
      api<ObjectDef>('GET', `/v1/schema/${name}`)
        .then((s) => setSchemas((m) => ({ ...m, [name]: s })))
        .catch(() => undefined);
    }
  }, [tableObjects, schemas]);

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);

  const description = 'Choose what quotes show besides the title, who it is for, the lines and the total. The PDF and the customer\'s quote page both follow it.';
  if (!draft || !saved || !schemas.quotes || !schemas.lines) {
    return <SettingsPage title="Quote document" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={4} />}</SettingsPage>;
  }
  const quotes = schemas.quotes;
  const lines = schemas.lines;
  const set = (patch: Partial<Config>) => setDraft({ ...draft, ...patch });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const c = await api<Config>('PUT', '/v1/ui/settings/quote_document', draft);
      const next = { ...EMPTY, ...c };
      setSaved(next);
      setDraft(next);
      toast('Quote document saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns = draft.line_columns ?? DEFAULT_COLUMNS;
  const setColumns = (next: Column[]) => set({ line_columns: next });
  const linePicks = lines.properties.filter((p) => showable(p) && !ITEM_PROPS.has(p.api_name) && !columns.some((c) => c.property === p.api_name));
  const fieldPicks = quotes.properties.filter((p) => showable(p) && !draft.fields.some((f) => f.property === p.api_name));
  const linkable = quotes.links_to
    .filter((name) => !quotes.system_links.includes(name))
    .map((name) => objectByName.get(name))
    .filter((o): o is NonNullable<typeof o> => !!o)
    .sort((a, b) => a.label_plural.localeCompare(b.label_plural));

  return (
    <SettingsPage title="Quote document" description={description}>
      <SettingsSection title="Page">
        <SettingRow
          label="Orientation"
          htmlFor="quote-orientation"
          hint="Landscape gives a line table with many columns more room. The customer's page gets wider too."
        >
          <Select
            id="quote-orientation"
            value={draft.orientation}
            onChange={(v) => set({ orientation: v as Config['orientation'] })}
            options={[{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Line columns"
        description="The item column (name, with the SKU under it) always comes first. Widths are shares of the table: a column with 20 is twice as wide as one with 10. With more than six columns the type gets smaller."
        actions={draft.line_columns && (
          <button className="btn small ghost" onClick={() => set({ line_columns: null, item_label: null, item_width: null })}>Use the default columns</button>
        )}
      >
        <ColumnTable
          obj={lines}
          first={{ name: 'Item (name and SKU)', label: draft.item_label, width: draft.item_width, defaultLabel: 'Item', defaultWidth: 40,
            onChange: (label, width) => set({ item_label: label, item_width: width }) }}
          columns={columns}
          defaults={(p) => ({ label: BUILTIN[p]?.label, width: BUILTIN[p]?.width ?? EXTRA_WIDTH })}
          onChange={setColumns}
        />
        <AddPicker
          label="Add column"
          options={linePicks.map((p) => ({ value: p.api_name, label: p.label }))}
          onPick={(v) => setColumns([...columns, { property: v }])}
        />
      </SettingsSection>

      <SettingsSection
        title="Quote fields"
        description="Quote properties to show. Details sit under who the quote is for; terms come after the total, under their own heading. Empty values are left out."
      >
        {draft.fields.length > 0 && (
          <div className="access-table">
            <table className="grid">
              <thead><tr><th>Property</th><th>Label</th><th>Where</th><th /></tr></thead>
              <tbody>
                {draft.fields.map((f, i) => {
                  const p = quotes.properties.find((x) => x.api_name === f.property);
                  const name = p?.label ?? f.property;
                  return (
                    <tr key={f.property}>
                      <td className="primary-cell">{name}{!p || !showable(p) ? <> <StatusPill tone="failed">Missing</StatusPill></> : null}</td>
                      <td>
                        <input type="text" maxLength={80} value={f.label ?? ''} placeholder={p?.label ?? ''} aria-label={`Label for ${name}`}
                          onChange={(e) => set({ fields: draft.fields.map((x, j) => (j === i ? { ...x, label: e.target.value || null } : x)) })} />
                      </td>
                      <td>
                        <Select
                          value={f.place}
                          aria-label={`Where ${name} shows`}
                          onChange={(v) => set({ fields: draft.fields.map((x, j) => (j === i ? { ...x, place: v as Field['place'] } : x)) })}
                          options={[{ value: 'details', label: 'Details, under the header' }, { value: 'terms', label: 'Terms, after the total' }]}
                        />
                      </td>
                      <td className="row-actions">
                        <RowButtons label={name} index={i} count={draft.fields.length}
                          onMove={(by) => set({ fields: move(draft.fields, i, by) })}
                          onRemove={() => set({ fields: draft.fields.filter((_, j) => j !== i) })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <AddPicker
          label="Add field"
          options={fieldPicks.map((p) => ({ value: p.api_name, label: p.label }))}
          onPick={(v) => set({ fields: [...draft.fields, { property: v, place: 'details' }] })}
        />
        {draft.fields.some((f) => f.place === 'terms') && (
          <SettingRow label="Terms heading" htmlFor="quote-terms-title">
            <input id="quote-terms-title" type="text" maxLength={80} value={draft.terms_title ?? ''} placeholder="Terms"
              onChange={(e) => set({ terms_title: e.target.value || null })} />
          </SettingRow>
        )}
      </SettingsSection>

      <SettingsSection
        title="Linked tables"
        description="Tables of records linked to the quote, such as a kit or bill of materials, shown after the terms. A quote with no linked records of that kind leaves the table out. Up to 200 rows each."
      >
        {draft.tables.map((t, ti) => {
          const obj = schemas[t.object];
          const setTable = (patch: Partial<Table>) => set({ tables: draft.tables.map((x, j) => (j === ti ? { ...x, ...patch } : x)) });
          const picks = obj ? obj.properties.filter((p) => showable(p) && !t.columns.some((c) => c.property === p.api_name)) : [];
          return (
            <div className="rule-card quote-table-card" key={ti}>
              <div className="rule-head">
                <strong>{objectByName.get(t.object)?.label_plural ?? t.object}</strong>
                <span className="push-right" />
                <RowButtons label={t.title || 'table'} index={ti} count={draft.tables.length}
                  onMove={(by) => set({ tables: move(draft.tables, ti, by) })}
                  onRemove={() => set({ tables: draft.tables.filter((_, j) => j !== ti) })} />
              </div>
              <SettingRow label="Title" htmlFor={`quote-table-${ti}`}>
                <input id={`quote-table-${ti}`} type="text" maxLength={80} value={t.title} onChange={(e) => setTable({ title: e.target.value })} />
              </SettingRow>
              {obj ? (
                <>
                  <SettingRow label="Order rows by">
                    <div className="quote-sort">
                      <Select
                        value={t.sort?.property ?? ''}
                        aria-label="Order rows by"
                        onChange={(v) => setTable({ sort: v ? { property: v, direction: t.sort?.direction ?? 'asc' } : null })}
                        options={[{ value: '', label: 'When they were created' }, ...obj.properties.filter(showable).map((p) => ({ value: p.api_name, label: p.label }))]}
                      />
                      {t.sort && (
                        <Select
                          value={t.sort.direction}
                          aria-label="Direction"
                          onChange={(v) => setTable({ sort: { ...t.sort!, direction: v as 'asc' | 'desc' } })}
                          options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]}
                        />
                      )}
                    </div>
                  </SettingRow>
                  <ColumnTable
                    obj={obj}
                    columns={t.columns}
                    defaults={() => ({ width: EXTRA_WIDTH })}
                    onChange={(columns) => setTable({ columns })}
                  />
                  <AddPicker
                    label="Add column"
                    options={picks.map((p) => ({ value: p.api_name, label: p.label }))}
                    onPick={(v) => setTable({ columns: [...t.columns, { property: v }] })}
                  />
                </>
              ) : <TableSkeleton rows={2} />}
            </div>
          );
        })}
        {draft.tables.length < 4 && (
          <AddPicker
            label="Add table"
            options={linkable.map((o) => ({ value: o.api_name, label: o.label_plural }))}
            onPick={(v) => set({ tables: [...draft.tables, { title: objectByName.get(v)?.label_plural ?? v, object: v, columns: [{ property: 'name' }], sort: null }] })}
          />
        )}
      </SettingsSection>

      <SaveBar dirty={dirty} error={error}>
        <button className="btn ghost" disabled={!dirty || busy} onClick={() => setDraft(saved)}>Discard</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Save'}</button>
      </SaveBar>
    </SettingsPage>
  );
}

// Up, down and remove for a row.
function RowButtons({ label, index, count, onMove, onRemove }: { label: string; index: number; count: number; onMove: (by: number) => void; onRemove: () => void }) {
  return (
    <>
      <button className="icon-btn" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${label} up`}><ArrowUp size={14} /></button>
      <button className="icon-btn" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move ${label} down`}><ArrowDown size={14} /></button>
      <button className="icon-btn" onClick={onRemove} aria-label={`Remove ${label}`}><Trash2 size={14} /></button>
    </>
  );
}

// A menu-style picker that adds the chosen choice and goes back to its face.
function AddPicker({ label, options, onPick }: { label: string; options: { value: string; label: string }[]; onPick: (value: string) => void }) {
  if (!options.length) return null;
  return (
    <div className="quote-add">
      <Select value="" aria-label={label} face={<><Plus size={14} /> {label}</>} options={options} onChange={(v) => v && onPick(v)} />
    </div>
  );
}

// Columns with a label and a width each, plus an optional fixed first row.
function ColumnTable({ obj, first, columns, defaults, onChange }: {
  obj: ObjectDef;
  first?: { name: string; label: string | null; width: number | null; defaultLabel: string; defaultWidth: number; onChange: (label: string | null, width: number | null) => void };
  columns: Column[];
  defaults: (property: string) => { label?: string; width: number };
  onChange: (columns: Column[]) => void;
}) {
  const widths = [...(first ? [first.width ?? first.defaultWidth] : []), ...columns.map((c) => c.width ?? defaults(c.property).width)];
  const total = widths.reduce((s, w) => s + w, 0) || 1;
  const share = (w: number) => `${Math.round((w / total) * 100)}%`;
  if (!first && !columns.length) return null;
  return (
    <div className="access-table">
      <table className="grid">
        <thead><tr><th>Property</th><th>Label</th><th>Width</th><th /></tr></thead>
        <tbody>
          {first && (
            <tr>
              <td className="primary-cell">{first.name}</td>
              <td>
                <input type="text" maxLength={80} value={first.label ?? ''} placeholder={first.defaultLabel} aria-label="Label for the item column"
                  onChange={(e) => first.onChange(e.target.value || null, first.width)} />
              </td>
              <td>
                <WidthInput value={first.width} placeholder={first.defaultWidth} share={share(widths[0])} label="the item column"
                  onChange={(w) => first.onChange(first.label, w)} />
              </td>
              <td className="row-actions" />
            </tr>
          )}
          {columns.map((c, i) => {
            const p = obj.properties.find((x) => x.api_name === c.property);
            const name = p?.label ?? c.property;
            const d = defaults(c.property);
            const update = (patch: Partial<Column>) => onChange(columns.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <tr key={c.property}>
                <td className="primary-cell">{name}{!p || !showable(p) ? <> <StatusPill tone="failed">Missing</StatusPill></> : null}</td>
                <td>
                  <input type="text" maxLength={80} value={c.label ?? ''} placeholder={d.label ?? p?.label ?? ''} aria-label={`Label for ${name}`}
                    onChange={(e) => update({ label: e.target.value || null })} />
                </td>
                <td>
                  <WidthInput value={c.width ?? null} placeholder={d.width} share={share(widths[i + (first ? 1 : 0)])} label={name}
                    onChange={(w) => update({ width: w })} />
                </td>
                <td className="row-actions">
                  <RowButtons label={name} index={i} count={columns.length}
                    onMove={(by) => onChange(move(columns, i, by))}
                    onRemove={() => onChange(columns.filter((_, j) => j !== i))} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WidthInput({ value, placeholder, share, label, onChange }: { value: number | null; placeholder: number; share: string; label: string; onChange: (w: number | null) => void }) {
  return (
    <span className="quote-width">
      <input type="number" min={1} max={100} className="input-narrow" value={value ?? ''} placeholder={String(placeholder)}
        aria-label={`Width of ${label}`} onChange={(e) => onChange(widthOf(e.target.value))} />
      <span className="muted small">{share}</span>
    </span>
  );
}
