import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, EllipsisVertical, GripVertical, Pencil, Plus, Search, X } from 'lucide-react';
import {
  api, getSchema, type AssociatedRecord, type AssociationLabel, type Column, type CrmRecord, type ObjectDef,
  type Property, type SearchResult, type Sort, type View
} from '../lib/api';
import { useApp } from '../lib/app-context';
import { defaultSortDirection, displayName, formatValue, nameProperties, objectIcon, recordName, valueType } from '../lib/display';
import { CreateRecordModal } from '../components/CreateRecordModal';
import { FileUploadButton } from '../components/FileUploadButton';
import { ColumnPicker, associationColumnLabel, moveTo } from '../components/ColumnPicker';
import { Menu, Modal, PropertyInput, fromInput, isEditable, toInput } from '../components/ui';

const PAGE = 50;
const MIN_WIDTH = 60;
const MAX_WIDTH = 1000;

// Keyed by object so switching tables starts fresh instead of sending one
// search with the previous object's schema, columns and sorts.
export function ObjectTable() {
  const { object = '' } = useParams();
  return <ObjectTableFor key={object} object={object} />;
}

function ObjectTableFor({ object }: { object: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { objectByName, toast } = useApp();

  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [views, setViews] = useState<View[]>([]);
  const [labels, setLabels] = useState<AssociationLabel[]>([]);
  const [otherSchemas, setOtherSchemas] = useState<Record<string, ObjectDef>>({});
  const [columns, setColumns] = useState<Column[]>([]);
  const [sorts, setSorts] = useState<Sort[]>([]);
  const [appliedViewId, setAppliedViewId] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [debounced, setDebounced] = useState(query);
  const [data, setData] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [viewDialog, setViewDialog] = useState<null | { mode: 'create' | 'rename'; name: string }>(null);
  const [editing, setEditing] = useState<null | { record: CrmRecord; property: Property; rect: DOMRect }>(null);
  const dragFrom = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [sel, setSel] = useState<{ anchor: Cell; focus: Cell } | null>(null);
  const selecting = useRef(false);

  const viewId = searchParams.get('view');
  const activeView = views.find((v) => String(v.id) === viewId) ?? views[0];
  const activeViewId = activeView?.id;

  // schema, views and labels for this object
  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setViews([]);
    setData(null);
    setError(null);
    Promise.all([
      getSchema(object),
      api<{ results: View[] }>('GET', `/v1/ui/views?object=${object}`),
      api<{ results: AssociationLabel[] }>('GET', `/v1/association-labels?object=${object}`)
    ])
      .then(([s, v, l]) => {
        if (cancelled) return;
        setSchema(s);
        setViews(v.results);
        setLabels(l.results);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [object]);

  // the active view's columns and sorts become the working copy
  useEffect(() => {
    if (!activeView) return;
    setColumns(activeView.columns);
    setSorts(activeView.sorts);
    setAppliedViewId(activeView.id);
    setDirty(false);
  }, [activeView?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  // What the search needs from the columns, as sorted string keys so that
  // resizing or reordering columns doesn't fetch the records again.
  const assocKey = [...new Set(columns.filter((c) => c.type === 'association').map((c) => (c as { object: string }).object))].sort().join(',');
  const propKey = schema
    ? [...new Set(columns.filter((c) => c.type === 'property' && schema.properties.some((p) => p.api_name === c.property)).map((c) => (c as { property: string }).property))].sort().join(',')
    : '';

  // schemas of objects shown in association columns (for record names)
  const assocObjects = useMemo(() => (assocKey ? assocKey.split(',') : []), [assocKey]);
  useEffect(() => {
    assocObjects.filter((o) => !otherSchemas[o]).forEach((o) =>
      getSchema(o).then((s) => setOtherSchemas((m) => ({ ...m, [o]: s }))).catch(() => undefined)
    );
  }, [assocObjects, otherSchemas]);

  const columnProperties = useMemo(() => (propKey ? propKey.split(',') : []), [propKey]);

  const fetchPage = useCallback(
    async (after?: string) => {
      if (!schema) return;
      if (activeViewId !== undefined && appliedViewId !== activeViewId) return; // view's columns not applied yet
      if (assocObjects.some((o) => !otherSchemas[o])) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api<SearchResult>('POST', `/v1/objects/${object}/search`, {
          query: debounced || undefined,
          sorts,
          limit: PAGE,
          after,
          properties: [...new Set([...nameProperties(schema.properties), ...columnProperties])],
          associations: assocObjects.map((o) => ({ object: o, properties: nameProperties(otherSchemas[o].properties) }))
        });
        setData((prev) => (after && prev ? { ...res, results: [...prev.results, ...res.results] } : res));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [schema, activeViewId, appliedViewId, object, debounced, sorts, columnProperties, assocObjects, otherSchemas]
  );

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  // persist column/sort changes to the view when the user may edit it
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function changeView(next: { columns?: Column[]; sorts?: Sort[] }) {
    if (next.columns) setColumns(next.columns);
    if (next.sorts) setSorts(next.sorts);
    if (!activeView) return;
    if (!activeView.editable) {
      setDirty(true);
      return;
    }
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const updated = await api<View>('PATCH', `/v1/ui/views/${activeView.id}`, next).catch(() => null);
      if (updated) setViews((vs) => vs.map((v) => (v.id === updated.id ? updated : v)));
    }, 400);
  }

  // Drag a header's right edge to resize; the width is saved on mouse up.
  function startResize(e: React.MouseEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest('th')!;
    const startX = e.clientX;
    const startWidth = th.getBoundingClientRect().width;
    let latest = columns;
    const onMove = (ev: MouseEvent) => {
      const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX)));
      latest = columns.map((c, j) => (j === i ? { ...c, width } : c));
      setColumns(latest);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('col-resizing');
      if (latest !== columns) changeView({ columns: latest });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.classList.add('col-resizing');
  }

  function dropColumn() {
    const from = dragFrom.current;
    if (from !== null && dropAt !== null && dropAt !== from && dropAt !== from + 1) changeView({ columns: moveTo(columns, from, dropAt) });
    dragFrom.current = null;
    setDropAt(null);
  }

  // drag handle, drop target and resize handle shared by every header cell
  function headerProps(i: number) {
    return {
      className: `${dropAt === i ? 'drop-before' : ''}${dropAt === columns.length && i === columns.length - 1 ? ' drop-after' : ''}`,
      style: widthStyle(columns[i]),
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        if (dragFrom.current === null) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        dropColumn();
      }
    };
  }
  function headerHandles(i: number) {
    return (
      <>
        <span
          className="grip th-grip"
          draggable
          title="Drag to move column"
          onDragStart={(e) => {
            dragFrom.current = i;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setDragImage(e.currentTarget.closest('th')!, 16, 16);
          }}
          onDragEnd={() => { dragFrom.current = null; setDropAt(null); }}
        >
          <GripVertical size={14} />
        </span>
        <span className="col-resize" onMouseDown={(e) => startResize(e, i)} onClick={(e) => e.stopPropagation()} title="Drag to resize" />
      </>
    );
  }

  function startEdit(e: React.MouseEvent, record: CrmRecord, property: Property) {
    setSel(null);
    setEditing({ record, property, rect: (e.currentTarget as HTMLElement).closest('td')!.getBoundingClientRect() });
  }

  // ---- cell selection: drag over cells, then copy them as TSV like a spreadsheet

  const bounds = sel && {
    r0: Math.min(sel.anchor.row, sel.focus.row), r1: Math.max(sel.anchor.row, sel.focus.row),
    c0: Math.min(sel.anchor.col, sel.focus.col), c1: Math.max(sel.anchor.col, sel.focus.col)
  };
  const isSelected = (row: number, col: number) => !!bounds && row >= bounds.r0 && row <= bounds.r1 && col >= bounds.c0 && col <= bounds.c1;

  // row and column positions change on reload, sort, search and column edits
  useEffect(() => setSel(null), [data?.results.length, sorts, debounced, columns]);

  function cellText(r: CrmRecord, c: Column, col: number): string {
    if (c.type === 'association') return associatedItems(r, c).map((a) => displayName(a.properties, a.id)).join(', ');
    const prop = schema?.properties.find((p) => p.api_name === c.property);
    if (!prop) return '';
    if (prop.api_name === 'name') return recordName(r);
    return formatValue(prop, r.properties[prop.api_name]) || (col === 0 ? recordName(r) : '');
  }

  useEffect(() => {
    const onUp = () => {
      selecting.current = false;
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('.grid tbody')) setSel(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !editing && setSel(null);
    const onCopy = (e: ClipboardEvent) => {
      if (!sel || !bounds || !data || editing) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (window.getSelection()?.isCollapsed === false) return; // ordinary text selection elsewhere
      const cols = columns.slice(bounds.c0, bounds.c1 + 1);
      const rows = data.results.slice(bounds.r0, bounds.r1 + 1).map((r) => cols.map((c, k) => cellText(r, c, bounds.c0 + k)));
      e.preventDefault();
      e.clipboardData?.setData('text/plain', rows.map((l) => l.map(tsvField).join('\t')).join('\n'));
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

  // props shared by every body cell: width, selection and editing state
  function cellProps(row: number, col: number, c: Column, extra: string[] = []) {
    const classes = [...extra];
    if (isSelected(row, col)) classes.push('selected');
    if (sel && sel.anchor.row === row && sel.anchor.col === col) classes.push('sel-anchor');
    return {
      className: classes.join(' ') || undefined,
      style: widthStyle(c),
      onMouseDown: (e: React.MouseEvent) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('.cell-edit')) return;
        e.preventDefault(); // no text selection; links still open on click
        (document.activeElement as HTMLElement | null)?.blur();
        selecting.current = true;
        const here = { row, col };
        setSel((s) => (e.shiftKey && s ? { anchor: s.anchor, focus: here } : { anchor: here, focus: here }));
      },
      onMouseEnter: () => {
        if (selecting.current) setSel((s) => s && { ...s, focus: { row, col } });
      }
    };
  }

  function editButton(r: CrmRecord, prop: Property) {
    return (
      <button className="cell-edit" onClick={(e) => startEdit(e, r, prop)} aria-label={`Edit ${prop.label.toLowerCase()}`} title={`Edit ${prop.label.toLowerCase()}`}>
        <Pencil size={13} />
      </button>
    );
  }

  function recordSaved(updated: CrmRecord) {
    setData((prev) =>
      prev && { ...prev, results: prev.results.map((r) => (r.id === updated.id ? { ...r, properties: { ...r.properties, ...updated.properties } } : r)) }
    );
  }

  function clickHeader(property: string) {
    const prop = schema?.properties.find((p) => p.api_name === property);
    if (!prop || (prop.type === 'dropdown' && prop.options.single_value !== true) || prop.type === 'file') return;
    const current = sorts[0]?.property === property ? sorts[0].direction : null;
    const direction = current ? (current === 'asc' ? 'desc' : 'asc') : defaultSortDirection(prop);
    changeView({ sorts: [{ property, direction }] });
  }

  async function saveViewDialog() {
    if (!viewDialog || !viewDialog.name.trim()) return;
    if (viewDialog.mode === 'create') {
      const created = await api<View>('POST', '/v1/ui/views', { object, name: viewDialog.name.trim(), columns, sorts });
      setViews((vs) => [...vs, created]);
      setSearchParams({ view: String(created.id) });
    } else if (activeView) {
      const updated = await api<View>('PATCH', `/v1/ui/views/${activeView.id}`, { name: viewDialog.name.trim() });
      setViews((vs) => vs.map((v) => (v.id === updated.id ? updated : v)));
    }
    setViewDialog(null);
  }

  async function deleteView(view: View) {
    if (!confirm(`Delete the view "${view.name}"?`)) return;
    await api('DELETE', `/v1/ui/views/${view.id}`);
    const rest = views.filter((v) => v.id !== view.id);
    setViews(rest);
    setSearchParams(rest[0] ? { view: String(rest[0].id) } : {});
  }

  const summary = objectByName.get(object);
  if (error && !schema) return <div className="page"><div className="error">{error}</div></div>;
  if (!schema || !summary) return <div className="page muted">Loading…</div>;
  const Icon = objectIcon(object);

  return (
    <div className="page table-page">
      <header className="page-head">
        <div className="title-row">
          <Icon size={22} strokeWidth={1.75} />
          <h1>{schema.label_plural}</h1>
          {data && <span className="count">{data.total.toLocaleString()} {data.total === 1 ? 'record' : 'records'}</span>}
        </div>
        {object === 'files' ? (
          // a file record without bytes is no use, so files are uploaded instead of created
          <FileUploadButton
            onError={setError}
            onUploaded={(ids) => {
              if (ids.length === 1) {
                navigate(`/objects/files/${ids[0]}`);
                return;
              }
              toast(`${ids.length} files uploaded`);
              fetchPage();
            }}
          />
        ) : (
          <button className="btn primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> Create {schema.label_singular.toLowerCase()}
          </button>
        )}
      </header>

      <div className="tabs">
        {views.map((v) => (
          <div key={v.id} className={`tab${v.id === activeView?.id ? ' active' : ''}`}>
            <button onClick={() => setSearchParams({ view: String(v.id) })}>{v.name}</button>
            {v.id === activeView?.id && (
              <Menu
                align="left"
                trigger={(toggle) => (
                  <button className="tab-menu" onClick={toggle} aria-label="View options">
                    <EllipsisVertical size={14} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <button onClick={() => { close(); setViewDialog({ mode: 'create', name: `${v.name} copy` }); }}>Save as new view</button>
                    {v.editable && <button onClick={() => { close(); setViewDialog({ mode: 'rename', name: v.name }); }}>Rename</button>}
                    {v.editable && views.length > 1 && <button className="danger" onClick={() => { close(); deleteView(v); }}>Delete</button>}
                  </>
                )}
              </Menu>
            )}
          </div>
        ))}
        <button className="tab-add" onClick={() => setViewDialog({ mode: 'create', name: '' })}>
          <Plus size={14} /> Add view
        </button>
      </div>

      <div className="toolbar">
        <div className="searchbox">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${schema.label_plural.toLowerCase()}`}
            title={`Searches ${schema.search_properties.map((n) => schema.properties.find((p) => p.api_name === n)?.label.toLowerCase() ?? n).join(', ')}`} />
          {query && (
            <button className="icon-btn" onClick={() => setQuery('')} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
        {dirty && <span className="muted small">Changes aren't saved: this shared view is admin-managed. Use "Save as new view" to keep them.</span>}
        <button className="btn" onClick={() => setShowColumns(true)}>
          <Columns3 size={16} /> Edit columns
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              {columns.map((c, i) => {
                if (c.type === 'association') {
                  const other = objectByName.get(c.object);
                  if (!other) return null;
                  const hp = headerProps(i);
                  return (
                    <th key={i} {...hp}>
                      {headerHandles(i)}
                      <div className="th">
                        <span className="th-text">{associationColumnLabel(c, other, labels, object, objectByName)}</span>
                        <ColumnMenu onRemove={() => changeView({ columns: columns.filter((_, j) => j !== i) })} />
                      </div>
                    </th>
                  );
                }
                const prop = schema.properties.find((p) => p.api_name === c.property);
                if (!prop) return null;
                const sorted = sorts[0]?.property === prop.api_name ? sorts[0].direction : null;
                const hp = headerProps(i);
                return (
                  <th key={i} {...hp} className={`${hp.className}${sorted ? ' sorted' : ''}`}>
                    {headerHandles(i)}
                    <div className="th">
                      <button className="th-label" onClick={() => clickHeader(prop.api_name)}>
                        {prop.label}
                        {sorted === 'asc' ? <ArrowUp size={14} /> : sorted === 'desc' ? <ArrowDown size={14} /> : <ArrowUpDown size={14} className="faint" />}
                      </button>
                      <ColumnMenu
                        onSort={(direction) => changeView({ sorts: [{ property: prop.api_name, direction }] })}
                        onRemove={() => changeView({ columns: columns.filter((_, j) => j !== i) })}
                      />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data?.results.map((r, ri) => (
              <tr key={r.id}>
                {columns.map((c, i) => {
                  if (c.type === 'association') {
                    const other = objectByName.get(c.object);
                    if (!other) return null;
                    return (
                      <td key={i} {...cellProps(ri, i, c)}>
                        <AssociationCell record={r} column={c} pluralLabel={other.label_plural} />
                      </td>
                    );
                  }
                  const prop = schema.properties.find((p) => p.api_name === c.property);
                  if (!prop) return null;
                  const editable = isEditable(prop);
                  const extra = [editable ? 'editable' : '', editing?.record.id === r.id && editing.property.api_name === prop.api_name ? 'editing' : ''].filter(Boolean);
                  if (i === 0 || prop.api_name === 'name') {
                    return (
                      <td key={i} {...cellProps(ri, i, c, ['primary-cell', ...extra])}>
                        <Link to={`/objects/${object}/${r.id}`}>{cellText(r, c, i)}</Link>
                        {editable && editButton(r, prop)}
                      </td>
                    );
                  }
                  return (
                    <td key={i} {...cellProps(ri, i, c, extra)}>
                      {formatValue(prop, r.properties[prop.api_name]) || <span className="muted empty-value">--</span>}
                      {editable && editButton(r, prop)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.results.length === 0 && !loading && (
          <div className="empty">{debounced ? `No ${schema.label_plural.toLowerCase()} match "${debounced}".` : `No ${schema.label_plural.toLowerCase()} yet.`}</div>
        )}
        {loading && <div className="empty muted">Loading…</div>}
        {data?.next && !loading && (
          <div className="load-more">
            <button className="btn" onClick={() => fetchPage(data.next!)}>
              Load more ({data.results.length.toLocaleString()} of {data.total.toLocaleString()})
            </button>
          </div>
        )}
      </div>

      {editing && (
        <CellEditor
          key={`${editing.record.id}:${editing.property.api_name}`}
          object={object}
          record={editing.record}
          property={editing.property}
          rect={editing.rect}
          onClose={() => setEditing((cur) => (cur === editing ? null : cur))}
          onSaved={recordSaved}
        />
      )}
      {showCreate && (
        <CreateRecordModal
          object={schema}
          onClose={() => setShowCreate(false)}
          onCreated={(r) => {
            setShowCreate(false);
            navigate(`/objects/${object}/${r.id}`);
          }}
        />
      )}
      {showColumns && (
        <ColumnPicker
          schema={schema}
          labels={labels}
          columns={columns}
          onClose={() => setShowColumns(false)}
          onSave={(cols) => {
            changeView({ columns: cols });
            setShowColumns(false);
          }}
        />
      )}
      {viewDialog && (
        <Modal
          title={viewDialog.mode === 'create' ? 'New view' : 'Rename view'}
          onClose={() => setViewDialog(null)}
          footer={
            <>
              <button className="btn" onClick={() => setViewDialog(null)}>Cancel</button>
              <button className="btn primary" onClick={saveViewDialog} disabled={!viewDialog.name.trim()}>Save</button>
            </>
          }
        >
          <label className="field">
            <span>View name</span>
            <input autoFocus value={viewDialog.name} maxLength={63} onChange={(e) => setViewDialog({ ...viewDialog, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveViewDialog()} />
          </label>
          {viewDialog.mode === 'create' && <p className="muted small">The new view starts with the current columns and sort, and only you can see it.</p>}
        </Modal>
      )}
    </div>
  );
}

type Cell = { row: number; col: number };

// a field Google Sheets reads back as one cell: quoted when it has tabs, line breaks or quotes
function tsvField(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function associatedItems(record: CrmRecord, column: { object: string; label_id: string | null }): AssociatedRecord[] {
  const all = record.associations?.[column.object] ?? [];
  return column.label_id ? all.filter((a) => a.labels.some((l) => l.label_id === column.label_id)) : all;
}

function widthStyle(c: Column): React.CSSProperties | undefined {
  return c.width ? { width: c.width, minWidth: c.width, maxWidth: c.width } : undefined;
}

// Edits one property of one row in a small box over the cell. Saves on Enter,
// on picking a single-choice option or on clicking elsewhere; Escape cancels.
function CellEditor({ object, record, property, rect, onClose, onSaved }: {
  object: string; record: CrmRecord; property: Property; rect: DOMRect; onClose: () => void; onSaved: (r: CrmRecord) => void;
}) {
  const { toast } = useApp();
  const [draft, setDraft] = useState(() => toInput(property, record.properties[property.api_name]));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  const done = useRef(false);
  const singleChoice = property.type === 'dropdown' && property.options.single_value === true;
  // multi-choice dropdowns and long text (a textarea) save with a button
  const needsSave = property.type === 'dropdown'
    ? !singleChoice
    : !['number', 'date', 'datetime'].includes(valueType(property)) && property.options.single_line !== true && !property.is_base;

  const commit = useCallback(async (final?: string) => {
    if (done.current) return;
    done.current = true;
    if (final !== undefined) draftRef.current = final;
    const value = fromInput(property, draftRef.current);
    if (JSON.stringify(value) === JSON.stringify(record.properties[property.api_name] ?? null)) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await api<CrmRecord>('PATCH', `/v1/objects/${object}/${record.id}`, { properties: { [property.api_name]: value } }));
      onClose();
      toast('Saved');
    } catch (err) {
      done.current = false;
      setSaving(false);
      setError((err as Error).message);
    }
  }, [object, record, property, onClose, onSaved]);

  useEffect(() => {
    // the date calendar is rendered on <body>, so clicks in it count as inside
    const outside = (e: Event) => !boxRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.flatpickr-calendar');
    const onDown = (e: MouseEvent) => {
      if (outside(e)) commit();
    };
    const onScroll = (e: Event) => {
      if (outside(e)) commit();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      done.current = true;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    const onResize = () => commit();
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [commit, onClose]);

  const width = Math.max(rect.width, 240);
  const style: React.CSSProperties = {
    top: Math.max(8, Math.min(rect.top, window.innerHeight - 240)),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    width
  };
  return createPortal(
    <div className="cell-editor" ref={boxRef} style={style}>
      <PropertyInput
        property={property}
        value={draft}
        autoFocus
        onChange={(v) => {
          draftRef.current = v;
          setDraft(v);
          if (singleChoice) commit();
        }}
        onCommit={needsSave ? undefined : commit}
      />
      {(needsSave || error || saving) && (
        <div className="cell-editor-foot">
          {error && <span className="error-text">{error}</span>}
          {saving && <span className="muted small">Saving…</span>}
          {needsSave && !saving && (
            <>
              <button className="btn small" onClick={() => { done.current = true; onClose(); }}>Cancel</button>
              <button className="btn small primary" onClick={() => commit()}>Save</button>
            </>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}

function ColumnMenu({ onSort, onRemove }: { onSort?: (d: 'asc' | 'desc') => void; onRemove: () => void }) {
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button className="th-menu" onClick={toggle} aria-label="Column options">
          <EllipsisVertical size={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          {onSort && (
            <>
              <button onClick={() => { close(); onSort('asc'); }}><ArrowUp size={14} /> Sort ascending</button>
              <button onClick={() => { close(); onSort('desc'); }}><ArrowDown size={14} /> Sort descending</button>
              <div className="menu-sep" />
            </>
          )}
          <button onClick={() => { close(); onRemove(); }}><X size={14} /> Remove column</button>
        </>
      )}
    </Menu>
  );
}

// One associated record shows its name; several show "3 Deals" with the
// names in a floating card on hover (rendered on <body> so the table's
// clipping can't hide it).
function AssociationCell({ record, column, pluralLabel }: { record: CrmRecord; column: { object: string; label_id: string | null }; pluralLabel: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const items = associatedItems(record, column);
  if (items.length === 0) return <span className="muted empty-value">--</span>;
  if (items.length === 1) {
    return <Link to={`/objects/${column.object}/${items[0].id}`}>{displayName(items[0].properties, items[0].id)}</Link>;
  }
  const show = (el: HTMLElement) => {
    clearTimeout(hideTimer.current);
    setAnchor(el.getBoundingClientRect());
  };
  const hide = () => {
    hideTimer.current = setTimeout(() => setAnchor(null), 150);
  };
  return (
    <>
      <span className="assoc-many" tabIndex={0} onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={hide} onFocus={(e) => show(e.currentTarget)} onBlur={hide}>
        {items.length} {pluralLabel}
      </span>
      {anchor &&
        createPortal(
          <div
            className="hovercard"
            style={{ top: anchor.bottom + 4, left: Math.min(anchor.left, window.innerWidth - 260) }}
            onMouseEnter={() => clearTimeout(hideTimer.current)}
            onMouseLeave={hide}
          >
            {items.slice(0, 10).map((a) => (
              <Link key={a.id} to={`/objects/${column.object}/${a.id}`}>{displayName(a.properties, a.id)}</Link>
            ))}
            {items.length > 10 && <span className="muted">and {items.length - 10} more</span>}
          </div>,
          document.body
        )}
    </>
  );
}
