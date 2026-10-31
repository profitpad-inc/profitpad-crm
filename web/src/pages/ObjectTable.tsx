import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, EllipsisVertical, Plus, Search, X } from 'lucide-react';
import {
  api, getSchema, type AssociatedRecord, type AssociationLabel, type Column, type CrmRecord, type ObjectDef,
  type SearchResult, type Sort, type View
} from '../lib/api';
import { useApp } from '../lib/app-context';
import { defaultSortDirection, displayName, formatValue, nameProperties, objectIcon, recordName } from '../lib/display';
import { CreateRecordModal } from '../components/CreateRecordModal';
import { ColumnPicker, associationColumnLabel } from '../components/ColumnPicker';
import { Menu, Modal } from '../components/ui';

const PAGE = 50;

export function ObjectTable() {
  const { object = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { objectByName } = useApp();

  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [views, setViews] = useState<View[]>([]);
  const [labels, setLabels] = useState<AssociationLabel[]>([]);
  const [otherSchemas, setOtherSchemas] = useState<Record<string, ObjectDef>>({});
  const [columns, setColumns] = useState<Column[]>([]);
  const [sorts, setSorts] = useState<Sort[]>([]);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [debounced, setDebounced] = useState(query);
  const [data, setData] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [viewDialog, setViewDialog] = useState<null | { mode: 'create' | 'rename'; name: string }>(null);

  const viewId = searchParams.get('view');
  const activeView = views.find((v) => String(v.id) === viewId) ?? views[0];

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
    setDirty(false);
  }, [activeView?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  // schemas of objects shown in association columns (for record names)
  const assocObjects = useMemo(() => [...new Set(columns.filter((c) => c.type === 'association').map((c) => (c as { object: string }).object))], [columns]);
  useEffect(() => {
    assocObjects.filter((o) => !otherSchemas[o]).forEach((o) =>
      getSchema(o).then((s) => setOtherSchemas((m) => ({ ...m, [o]: s }))).catch(() => undefined)
    );
  }, [assocObjects, otherSchemas]);

  const propertyColumns = useMemo(
    () => (schema ? columns.filter((c): c is { type: 'property'; property: string } => c.type === 'property' && schema.properties.some((p) => p.api_name === c.property)) : []),
    [columns, schema]
  );

  const fetchPage = useCallback(
    async (after?: string) => {
      if (!schema) return;
      if (assocObjects.some((o) => !otherSchemas[o])) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api<SearchResult>('POST', `/v1/objects/${object}/search`, {
          query: debounced || undefined,
          sorts,
          limit: PAGE,
          after,
          properties: [...new Set([...nameProperties(schema.properties), ...propertyColumns.map((c) => c.property)])],
          associations: assocObjects.map((o) => ({ object: o, properties: nameProperties(otherSchemas[o].properties) }))
        });
        setData((prev) => (after && prev ? { ...res, results: [...prev.results, ...res.results] } : res));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [schema, object, debounced, sorts, propertyColumns, assocObjects, otherSchemas]
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
        <button className="btn primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> Create {schema.label_singular.toLowerCase()}
        </button>
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
                  return (
                    <th key={i}>
                      <div className="th">
                        <span>{associationColumnLabel(c, other, labels, object, objectByName)}</span>
                        <ColumnMenu onRemove={() => changeView({ columns: columns.filter((_, j) => j !== i) })} />
                      </div>
                    </th>
                  );
                }
                const prop = schema.properties.find((p) => p.api_name === c.property);
                if (!prop) return null;
                const sorted = sorts[0]?.property === prop.api_name ? sorts[0].direction : null;
                return (
                  <th key={i} className={sorted ? 'sorted' : ''}>
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
            {data?.results.map((r) => (
              <tr key={r.id}>
                {columns.map((c, i) => {
                  if (c.type === 'association') {
                    const other = objectByName.get(c.object);
                    if (!other) return null;
                    return (
                      <td key={i}>
                        <AssociationCell record={r} column={c} pluralLabel={other.label_plural} />
                      </td>
                    );
                  }
                  const prop = schema.properties.find((p) => p.api_name === c.property);
                  if (!prop) return null;
                  if (i === 0 || prop.api_name === 'name') {
                    return (
                      <td key={i} className="primary-cell">
                        <Link to={`/objects/${object}/${r.id}`}>{prop.api_name === 'name' ? recordName(r) : formatValue(prop, r.properties[prop.api_name]) || recordName(r)}</Link>
                      </td>
                    );
                  }
                  return <td key={i}>{formatValue(prop, r.properties[prop.api_name])}</td>;
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
  const all: AssociatedRecord[] = record.associations?.[column.object] ?? [];
  const items = column.label_id ? all.filter((a) => a.labels.some((l) => l.label_id === column.label_id)) : all;
  if (items.length === 0) return null;
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
