import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Archive, ArrowDown, Download, ArrowUp, ArrowUpDown, Check, Columns3, EllipsisVertical, GripVertical, IdCard, ListFilter, Pencil, Plus, RotateCcw, Search, Trash2, Upload, X } from 'lucide-react';
import {
  api, can, getSchema, type AssociatedRecord, type AssociationLabel, type Column, type CrmRecord, type FilterGroup, type ObjectDef,
  type Property, type SearchResult, type Sort, type View
} from '../lib/api';
import { AdvancedFilters } from '../components/AdvancedFilters';
import { completeGroups, countFilters, fieldsFromSchema, filterParam, parseFilterParam, toSearchGroups } from '../lib/filters';
import { useApp } from '../lib/app-context';
import { norm } from '../lib/use-dirty';
import { SaveHint } from '../components/SaveHint';
import { defaultSortDirection, displayName, displayValue, formatValue, nameProperties, objectIcon, recordName, valueType } from '../lib/display';
import { CreateUserModal, preloadCreateUser } from '../components/CreateUserModal';
import { CreateRecordModal } from '../components/CreateRecordModal';
import { ImportModal } from '../components/ImportModal';
import { ExportModal } from '../components/ExportModal';
import { AddLineModal } from '../components/AddLineModal';
import { AMOUNT_FIELDS, offerAmountUpdates, parentsOfLines } from '../lib/lines';
import { FileUploadButton } from '../components/FileUploadButton';
import { ColumnPicker, associationColumnLabel, moveTo } from '../components/ColumnPicker';
import { Menu, Modal, PropertyInput, fromInput, isEditable, toInput } from '../components/ui';
import { EmptyState, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';
import '../table.css';
import { confirmDialog } from '../components/confirm';
import { useUrlSearch } from '../lib/use-url-search';
import { Loading } from '../components/Loading';
import { useIsMobile } from '../lib/use-mobile';
import { confirmPrimaryChange } from '../components/confirm-primary';

const PAGE = 50;
const BULK_CHUNK = 500; // the API's limit per bulk call
const MIN_WIDTH = 60;
const MAX_WIDTH = 1000;
// created another way (uploads, a parent record, a linked activity, the user form)
const NO_IMPORT = ['files', 'lines', 'comments', 'users'];
// phone cards: the name is the card's title, then at most this many of the view's other columns
const CARD_FIELDS = 5;
// already in the card's title
const NAME_PARTS = new Set(['name', 'first_name', 'last_name']);
const LONG_PRESS_MS = 450;
// Quick filters: a dropdown next to the search for each of these properties
// (single-choice user or option pickers), kept in the URL (?host=<id>).
// the filter picker's associated objects start with these, then the rest
// alphabetically (an object's own entry, else the default)
const PINNED_FILTER_OBJECTS: Record<string, string[]> = {
  default: ['contacts', 'companies', 'deals'],
  deals: ['contacts', 'companies', 'lines'],
  quotes: ['contacts', 'companies', 'lines'],
  invoices: ['contacts', 'companies', 'lines'],
  orders: ['contacts', 'companies', 'lines']
};
const QUICK_FILTERS: Record<string, string[]> = {
  booking_pages: ['host']
};

// Keyed by object so switching tables starts fresh instead of sending one
// search with the previous object's schema, columns and sorts.
export function ObjectTable() {
  const { object = '' } = useParams();
  return <ObjectTableFor key={object} object={object} />;
}

function ObjectTableFor({ object }: { object: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { objectByName, toast, me } = useApp();

  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [views, setViews] = useState<View[]>([]);
  const [labels, setLabels] = useState<AssociationLabel[]>([]);
  const [otherSchemas, setOtherSchemas] = useState<Record<string, ObjectDef>>({});
  const [columns, setColumns] = useState<Column[]>([]);
  const [sorts, setSorts] = useState<Sort[]>([]);
  // the view's filters, half-made conditions included (the panel's working copy)
  const [filterGroups, setFilterGroups] = useState<FilterGroup[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [appliedViewId, setAppliedViewId] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  // ?status=archived shows the recycle bin instead of the active records
  const archived = searchParams.get('status') === 'archived';
  // the search lives in ?s= so a refresh or shared link keeps it
  const [query, setQuery, debounced] = useUrlSearch();
  // quick filters (QUICK_FILTERS): property -> picked value, from the URL
  const quickProps = useMemo(
    () => (QUICK_FILTERS[object] ?? []).map((n) => schema?.properties.find((p) => p.api_name === n && p.record_status === 'active')).filter((p): p is Property => !!p),
    [object, schema]
  );
  const quickKey = quickProps.map((p) => `${p.api_name}=${searchParams.get(p.api_name) ?? ''}`).join('&');
  const quickFilters = useMemo(
    () => quickProps.filter((p) => searchParams.get(p.api_name)).map((p) => ({ property: p.api_name, operator: 'eq', value: searchParams.get(p.api_name)! })),
    [quickKey] // eslint-disable-line react-hooks/exhaustive-deps
  );
  function setQuick(name: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    }, { replace: true });
  }
  const [data, setData] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a new search or filter is loading while the old results are still shown
  const [reloading, setReloading] = useState(false);
  const lastSearch = useRef(0);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const isMobile = useIsMobile();
  const [showColumns, setShowColumns] = useState(false);
  const [viewDialog, setViewDialog] = useState<null | { mode: 'create' | 'rename'; name: string }>(null);
  const [editing, setEditing] = useState<null | { record: CrmRecord; property: Property; rect: DOMRect }>(null);
  const dragFrom = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  // the column being moved by its grip (tinted, header and cells)
  const [movingCol, setMovingCol] = useState<number | null>(null);
  const [sel, setSel] = useState<{ anchor: Cell; focus: Cell } | null>(null);
  const selecting = useRef(false);
  // records ticked in the checkbox column, for Edit all and Delete all
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const lastPicked = useRef<number | null>(null);
  const [bulk, setBulk] = useState<null | 'edit' | 'delete' | 'remove'>(null);
  // phones: tapping a card picks it instead of opening it (the Select button or a long press)
  const [selectMode, setSelectMode] = useState(false);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean; x: number; y: number }>({ fired: false, x: 0, y: 0 });

  const viewId = searchParams.get('view');
  const activeView = views.find((v) => String(v.id) === viewId) ?? views[0];
  const activeViewId = activeView?.id;
  // a rename needs a new name; a new view just a name
  const viewDialogReady = !!viewDialog && !!viewDialog.name.trim() && (viewDialog.mode === 'create' || viewDialog.name.trim() !== activeView?.name);

  // creating users gives a role: the Users or Roles permission (Super Admins have both)
  const canAddUsers = can(me, 'users') || can(me, 'roles');
  // the Create user form opens instantly (on the users table)
  useEffect(() => {
    if (object === 'users' && canAddUsers) preloadCreateUser();
  }, [object, canAddUsers]);

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
    // a link's ?filters= wins over the view's own (applied, not saved)
    setFilterGroups(parseFilterParam(searchParams.get('filters')) ?? activeView.filter_groups ?? []);
    setAppliedViewId(activeView.id);
    setDirty(false);
  }, [activeView?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // switching views keeps the search and the active/archived choice
  function showView(id: number | undefined) {
    setSearchParams(() => {
      const next = new URLSearchParams();
      if (id !== undefined) next.set('view', String(id));
      if (debounced) next.set('s', debounced);
      if (archived) next.set('status', 'archived');
      for (const f of quickFilters) next.set(f.property, f.value);
      return next;
    });
  }

  function showArchived(on: boolean) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (on) next.set('status', 'archived');
      else next.delete('status');
      return next;
    });
  }

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

  // filters: only finished conditions on properties this user can see
  // reach the search, keyed by their text so typing into a half-made one
  // doesn't fetch again
  // Filters on associated objects: their schemas load for objects the filters
  // already use, and for every linked object once the picker opens. Objects
  // the user cannot read fail and are left out.
  const [wantAllLinked, setWantAllLinked] = useState(false);
  const [unreadable, setUnreadable] = useState<Set<string>>(() => new Set());
  const filterObjectsKey = [...new Set(filterGroups.flatMap((g) => g.filters.flatMap((f) => (f.association ? [f.association.object] : []))))].sort().join(',');
  const linkedWanted = useMemo(() => {
    if (!schema) return [];
    const used = filterObjectsKey ? filterObjectsKey.split(',') : [];
    return [...new Set([...used, ...(wantAllLinked ? schema.links_to : [])])].filter((o) => o !== object);
  }, [schema, filterObjectsKey, wantAllLinked, object]);
  useEffect(() => {
    linkedWanted.filter((o) => !otherSchemas[o] && !unreadable.has(o)).forEach((o) =>
      getSchema(o)
        .then((s) => setOtherSchemas((m) => ({ ...m, [o]: s })))
        .catch(() => setUnreadable((u) => new Set(u).add(o)))
    );
  }, [linkedWanted]); // eslint-disable-line react-hooks/exhaustive-deps
  const linkedLoading = linkedWanted.some((o) => !otherSchemas[o] && !unreadable.has(o));
  const linkedKey = linkedWanted.filter((o) => otherSchemas[o]).sort().join(',');
  const filterFields = useMemo(() => {
    if (!schema) return [];
    const own = fieldsFromSchema(schema.properties);
    const linked = (linkedKey ? linkedKey.split(',') : []).flatMap((o) =>
      fieldsFromSchema(otherSchemas[o].properties, { object: o, group: otherSchemas[o].label_singular, plural: otherSchemas[o].label_plural }));
    return [...own, ...linked];
  }, [schema, linkedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // the search waits for the objects its filters use, so it never runs without them
  const filtersWaiting = (filterObjectsKey ? filterObjectsKey.split(',') : []).some((o) => !otherSchemas[o] && !unreadable.has(o));
  const searchKey = JSON.stringify(toSearchGroups(filterGroups, filterFields));
  const searchGroups = useMemo(() => JSON.parse(searchKey) as FilterGroup[], [searchKey]);
  const filterCount = countFilters(searchGroups);

  const fetchPage = useCallback(
    async (after?: string) => {
      if (!schema) return;
      if (activeViewId !== undefined && appliedViewId !== activeViewId) return; // view's columns not applied yet
      if (assocObjects.some((o) => !otherSchemas[o])) return;
      if (filtersWaiting) return;
      setLoading(true);
      setError(null);
      // a new first page supersedes any still loading: only the latest one is shown
      const id = after ? lastSearch.current : ++lastSearch.current;
      if (!after) setReloading(true);
      try {
        const res = await api<SearchResult>('POST', `/v1/objects/${object}/search`, {
          query: debounced || undefined,
          status: archived ? 'archived' : undefined,
          // quick filters apply on top of every filter group
          filter_groups: searchGroups.length
            ? searchGroups.map((g) => ({ filters: [...quickFilters, ...g.filters] }))
            : quickFilters.length ? [{ filters: quickFilters }] : undefined,
          sorts,
          limit: PAGE,
          after,
          properties: [...new Set([...nameProperties(schema.properties), ...columnProperties])],
          associations: assocObjects.map((o) => ({ object: o, properties: nameProperties(otherSchemas[o].properties) }))
        });
        if (id !== lastSearch.current) return;
        setData((prev) => (after && prev ? { ...res, results: [...prev.results, ...res.results] } : res));
      } catch (err) {
        if (id === lastSearch.current) setError((err as Error).message);
      } finally {
        if (id === lastSearch.current) {
          setLoading(false);
          if (!after) setReloading(false);
        }
      }
    },
    [schema, activeViewId, appliedViewId, object, debounced, archived, quickFilters, searchGroups, sorts, columnProperties, assocObjects, otherSchemas, filtersWaiting]
  );

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  // a new search, sort, view or the recycle bin shows different records, so start over
  useEffect(() => {
    setPicked(new Set());
    setSelectMode(false);
    lastPicked.current = null;
  }, [debounced, archived, quickFilters, searchGroups, sorts, activeViewId]);

  const shown = data?.results ?? [];
  const pickedCount = shown.filter((r) => picked.has(r.id)).length;
  const allPicked = shown.length > 0 && pickedCount === shown.length;
  const picking = isMobile && (selectMode || picked.size > 0);

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearPicked() {
    setPicked(new Set());
    setSelectMode(false);
  }

  // a long press on a card starts picking with that card
  function pressStart(e: React.TouchEvent, id: string) {
    const t = e.touches[0];
    clearTimeout(press.current.timer);
    press.current = {
      fired: false, x: t.clientX, y: t.clientY,
      timer: setTimeout(() => {
        press.current.fired = true;
        navigator.vibrate?.(10);
        setSelectMode(true);
        togglePick(id);
      }, LONG_PRESS_MS)
    };
  }
  function pressMove(e: React.TouchEvent) {
    const t = e.touches[0];
    if (Math.abs(t.clientX - press.current.x) > 10 || Math.abs(t.clientY - press.current.y) > 10) clearTimeout(press.current.timer);
  }
  function pressEnd() {
    clearTimeout(press.current.timer);
  }

  function pickAll() {
    setPicked(allPicked ? new Set() : new Set(shown.map((r) => r.id)));
    lastPicked.current = null;
  }

  // shift-click ticks or unticks every row between this one and the last one clicked
  function pickRow(e: React.MouseEvent<HTMLInputElement>, row: number) {
    const on = e.currentTarget.checked;
    const from = e.shiftKey && lastPicked.current !== null ? Math.min(lastPicked.current, row) : row;
    const to = e.shiftKey && lastPicked.current !== null ? Math.max(lastPicked.current, row) : row;
    setPicked((prev) => {
      const next = new Set(prev);
      for (const r of shown.slice(from, to + 1)) {
        if (on) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
    lastPicked.current = row;
  }

  const [restoring, setRestoring] = useState(false);
  async function restorePicked() {
    const ids = [...picked];
    setRestoring(true);
    setError(null);
    try {
      await inChunks(ids, (chunk) => api('POST', `/v1/objects/${object}/bulk/restore`, { ids: chunk }));
      bulkDone(ids.length === 1 ? 'Restored' : `${ids.length.toLocaleString()} restored`, true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestoring(false);
    }
  }

  function bulkDone(message: string, clear: boolean) {
    setBulk(null);
    if (clear) clearPicked();
    toast(message);
    fetchPage();
  }

  // persist column/sort changes to the view when the user may edit it
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // changes waiting for the timer, merged so a quick second change doesn't drop the first
  const pendingSave = useRef<{ columns?: Column[]; sorts?: Sort[]; filter_groups?: FilterGroup[] }>({});
  function changeView(next: { columns?: Column[]; sorts?: Sort[]; filter_groups?: FilterGroup[] }) {
    if (next.columns) setColumns(next.columns);
    if (next.sorts) setSorts(next.sorts);
    if (!activeView) return;
    if (!activeView.editable) {
      setDirty(true);
      return;
    }
    pendingSave.current = { ...pendingSave.current, ...next };
    const viewIdNow = activeView.id;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const body = pendingSave.current;
      pendingSave.current = {};
      const updated = await api<View>('PATCH', `/v1/ui/views/${viewIdNow}`, body).catch(() => null);
      if (updated) setViews((vs) => vs.map((v) => (v.id === updated.id ? updated : v)));
    }, 400);
  }

  // the panel's edits apply at once; finished conditions are saved with the view
  function changeFilters(next: FilterGroup[]) {
    setFilterGroups(next);
    const done = completeGroups(next, filterFields);
    if (JSON.stringify(done) !== JSON.stringify(completeGroups(filterGroups, filterFields))) changeView({ filter_groups: done });
  }

  // The finished filters also live in ?filters=, so a refresh, a copied link
  // and the back button keep them. Replaced, not pushed, like the search.
  // Empty filters leave it out, unless the view has saved ones (then
  // "filters=[]" says "none" rather than "the view's").
  const filterUrlValue = useMemo(() => {
    if (!activeView) return null;
    const done = searchGroups.length ? completeGroups(filterGroups, filterFields) : [];
    if (done.length) return filterParam(done);
    return (activeView.filter_groups ?? []).length ? '[]' : null;
  }, [searchKey, activeView?.id, JSON.stringify(activeView?.filter_groups ?? [])]); // eslint-disable-line react-hooks/exhaustive-deps
  const urlFilters = searchParams.get('filters');
  const syncedFilters = useRef<string | null>(urlFilters);
  useEffect(() => {
    if (appliedViewId !== activeView?.id || filterUrlValue === syncedFilters.current) return;
    syncedFilters.current = filterUrlValue;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (filterUrlValue === null) next.delete('filters');
      else next.set('filters', filterUrlValue);
      return next;
    }, { replace: true });
  }, [filterUrlValue, appliedViewId]); // eslint-disable-line react-hooks/exhaustive-deps
  // the address changed from outside (back button, a pasted link)
  useEffect(() => {
    if (urlFilters === syncedFilters.current || !activeView) return;
    syncedFilters.current = urlFilters;
    setFilterGroups(parseFilterParam(urlFilters) ?? activeView.filter_groups ?? []);
  }, [urlFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag a header's right edge to resize; the width is saved on mouse up.
  function startResize(e: React.MouseEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest('th')!;
    const startX = e.clientX;
    const startWidth = th.getBoundingClientRect().width;
    // Pin every column at its current width so only this one moves; the filler
    // column at the end takes up (or gives back) the leftover space.
    const measured = new Map<number, number>();
    th.parentElement?.querySelectorAll<HTMLElement>('th[data-col]').forEach((el) => measured.set(Number(el.dataset.col), Math.round(el.getBoundingClientRect().width)));
    const pinned = columns.map((c, j) => (measured.has(j) ? { ...c, width: measured.get(j)! } : c));
    let latest = columns;
    const onMove = (ev: MouseEvent) => {
      const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX)));
      latest = pinned.map((c, j) => (j === i ? { ...c, width } : c));
      setColumns(latest);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dg-resizing');
      if (latest !== columns) changeView({ columns: latest });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.classList.add('dg-resizing');
  }

  // Drag a header's grip to move the column (mouse events, like resizing: HTML5
  // drag and drop did not drop reliably). While moving, a copy of the header
  // follows the pointer, the column is tinted and a line down the table shows
  // where it lands; no line while it would stay where it is.
  function startMove(e: React.MouseEvent, i: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest('th')!;
    const row = th.closest('tr')!;
    const table = th.closest('table')!;
    const box = th.getBoundingClientRect();
    const grabX = e.clientX - box.left;
    const startX = e.clientX;
    let moving = false;
    let at: number | null = null;
    let ghost: HTMLElement | null = null;
    let line: HTMLElement | null = null;
    const onMove = (ev: MouseEvent) => {
      if (!moving && Math.abs(ev.clientX - startX) < 4) return;
      if (!moving) {
        moving = true;
        dragFrom.current = i;
        setMovingCol(i);
        document.body.classList.add('dg-moving');
        ghost = document.createElement('div');
        ghost.className = 'dg-ghost';
        ghost.textContent = th.querySelector('.dg-label')?.textContent ?? '';
        Object.assign(ghost.style, { top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
        line = document.createElement('div');
        line.className = 'dg-drop-line';
        document.body.append(ghost, line);
      }
      ghost!.style.left = `${ev.clientX - grabX}px`;
      // the first header whose middle is right of the pointer; past them all, the end
      const heads = [...row.querySelectorAll<HTMLElement>('th[data-col]')];
      let next = columns.length;
      let edge = heads.length ? heads[heads.length - 1].getBoundingClientRect().right : 0;
      for (const h of heads) {
        const r = h.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          next = Number(h.dataset.col);
          edge = r.left;
          break;
        }
      }
      at = next === i || next === i + 1 ? null : next;
      // the line runs down the visible part of the table
      const t = table.getBoundingClientRect();
      const scroller = table.parentElement!;
      const v = scroller.getBoundingClientRect();
      const top = Math.max(t.top, v.top);
      Object.assign(line!.style, {
        display: at === null ? 'none' : 'block',
        left: `${edge - 1}px`, top: `${top}px`, height: `${Math.max(0, Math.min(t.bottom, v.bottom) - top)}px`
      });
      setDropAt(at);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dg-moving');
      ghost?.remove();
      line?.remove();
      dragFrom.current = null;
      setMovingCol(null);
      setDropAt(null);
      if (moving && at !== null) changeView({ columns: moveTo(columns, i, at) });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // drag handle, drop target and resize handle shared by every header cell
  function headerProps(i: number) {
    return {
      className: `${i === 0 ? 'lead-col' : ''}${dropAt === i ? ' drop-before' : ''}${dropAt === columns.length && i === columns.length - 1 ? ' drop-after' : ''}${movingCol === i ? ' dg-moving-col' : ''}`,
      'data-col': i,
      style: widthStyle(columns[i])
    };
  }
  function headerHandles(i: number) {
    return (
      <>
        <span className="dg-grip" title="Drag to move column" onMouseDown={(e) => startMove(e, i)} onClick={(e) => e.stopPropagation()}>
          <GripVertical size={12} />
        </span>
        <span className="dg-resize" onMouseDown={(e) => startResize(e, i)} onClick={(e) => e.stopPropagation()} title="Drag to resize" />
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

  function cellText(r: CrmRecord, c: Column, col: number, forCopy = true): string {
    if (c.type === 'association') return associatedItems(r, c).map((a) => displayName(a.properties, a.id)).join(', ');
    const prop = schema?.properties.find((p) => p.api_name === c.property);
    if (!prop) return '';
    if (prop.api_name === 'name') return recordName(r);
    // a leading ' keeps spreadsheets from reading "+1 437-222-0321" as a formula or number
    if (prop.type === 'phone') {
      const text = formatValue(prop, r.properties[prop.api_name]);
      return text && forCopy ? `'${text}` : text;
    }
    return formatValue(prop, r.properties[prop.api_name]) || (col === 0 ? recordName(r) : '');
  }

  useEffect(() => {
    const onUp = () => {
      selecting.current = false;
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('.data-grid tbody')) setSel(null);
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
    if (col === 0) classes.push('lead-col'); // stays in view when the table scrolls sideways
    if (col === movingCol) classes.push('dg-moving-col');
    if (isSelected(row, col)) classes.push('selected');
    if (sel && sel.anchor.row === row && sel.anchor.col === col) classes.push('sel-anchor');
    return {
      className: classes.join(' ') || undefined,
      style: widthStyle(c),
      onMouseDown: (e: React.MouseEvent) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('.dg-edit')) return;
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
      <button className="dg-edit" onClick={(e) => startEdit(e, r, prop)} aria-label={`Edit ${prop.label.toLowerCase()}`} title={`Edit ${prop.label.toLowerCase()}`}>
        <Pencil size={13} />
      </button>
    );
  }

  // after lines change (edited amount figures, deleted), their deals, quotes, ...
  // are offered the new line totals as their amounts
  async function offerForLines(ids: string[]) {
    if (object !== 'lines' || ids.length === 0) return;
    try {
      const parents = await parentsOfLines(ids);
      const n = await offerAmountUpdates(parents, (o) => objectByName.get(o)?.label_singular ?? o);
      if (n) toast(n === 1 ? 'Amount updated' : `${n} amounts updated`);
    } catch (err) {
      toast((err as Error).message);
    }
  }

  function recordSaved(updated: CrmRecord) {
    const before = data?.results.find((r) => r.id === updated.id);
    // only fields shown in the table can be edited here, so only those are compared
    const changed = AMOUNT_FIELDS.some((f) => before && f in before.properties && String(before.properties[f] ?? '') !== String(updated.properties[f] ?? ''));
    if (changed) void offerForLines([updated.id]);
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
    if (!viewDialog || !viewDialogReady) return;
    if (viewDialog.mode === 'create') {
      const created = await api<View>('POST', '/v1/ui/views', { object, name: viewDialog.name.trim(), columns, sorts, filter_groups: completeGroups(filterGroups, filterFields) });
      setViews((vs) => [...vs, created]);
      showView(created.id);
    } else if (activeView) {
      const updated = await api<View>('PATCH', `/v1/ui/views/${activeView.id}`, { name: viewDialog.name.trim() });
      setViews((vs) => vs.map((v) => (v.id === updated.id ? updated : v)));
    }
    setViewDialog(null);
  }

  async function deleteView(view: View) {
    if (!(await confirmDialog(`The view "${view.name}" is deleted.`, { title: 'Delete this view?', confirmLabel: 'Delete', danger: true }))) return;
    await api('DELETE', `/v1/ui/views/${view.id}`);
    const rest = views.filter((v) => v.id !== view.id);
    setViews(rest);
    showView(rest[0]?.id);
  }

  const summary = objectByName.get(object);
  if (error && !schema) return <div className="page"><div className="error">{error}</div></div>;
  if (!schema || !summary) return <div className="page muted"><Loading /></div>;
  const Icon = objectIcon(object);
  const plural = schema.label_plural.toLowerCase();
  const singular = schema.label_singular.toLowerCase();

  // the table's 3-dot menu: switches between the active records and the recycle bin
  const tableMenu = (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button className="btn icon-only table-more" onClick={toggle} aria-label="More options">
          <EllipsisVertical size={16} />
        </button>
      )}
    >
      {(close) => (
        <button onClick={() => { close(); showArchived(!archived); }}>
          {archived ? <RotateCcw size={15} /> : <Archive size={15} />}
          {archived ? `View active ${plural}` : `View archived ${plural} only`}
        </button>
      )}
    </Menu>
  );

  // files are uploaded rather than created: a file record without bytes is no use
  const createButton = object === 'files' ? (
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
      <Plus size={16} /> Create {singular}
    </button>
  );
  // phones: the view's columns, minus the name, sortable from the Sort menu or shown on the cards
  const sortable = [...new Map(columns.flatMap((c) => {
    if (c.type !== 'property') return [];
    const p = schema.properties.find((x) => x.api_name === c.property);
    return p && !(p.type === 'dropdown' && p.options.single_value !== true) && p.type !== 'file' ? [[p.api_name, p] as const] : [];
  })).values()];
  const cardColumns = columns.flatMap((c, index): { column: Column; index: number; label: string }[] => {
    if (c.type === 'association') {
      const other = objectByName.get(c.object);
      return other ? [{ column: c, index, label: associationColumnLabel(c, other, labels, object, objectByName) }] : [];
    }
    const p = schema.properties.find((x) => x.api_name === c.property);
    return p && !NAME_PARTS.has(p.api_name) ? [{ column: c, index: Math.max(index, 1), label: p.label }] : [];
  }).slice(0, CARD_FIELDS);
  const searchedFields = schema.search_properties.map((n) => schema.properties.find((p) => p.api_name === n)?.label.toLowerCase() ?? n).join(', ');

  return (
    <div className="page table-page">
      <header className="table-head">
        <div className="table-title">
          <Icon size={20} strokeWidth={1.75} aria-hidden />
          <h1>{schema.label_plural}</h1>
          {data && <span className="table-count">{data.total.toLocaleString()} {data.total === 1 ? 'record' : 'records'}</span>}
          {data && reloading && <Loading inline label="Updating results…" className="table-count-loading" />}
        </div>
        <div className="table-head-actions">
          {object === 'contacts' && <Link className="btn" to="/scan"><IdCard size={16} /> Scan card</Link>}
          {/* imports and exports are desktop work: hidden on phones */}
          {!isMobile && schema.permissions.create && can(me, 'import') && !NO_IMPORT.includes(object) && (
            <button className="btn" onClick={() => setShowImport(true)}><Upload size={16} /> Import</button>
          )}
          {!isMobile && can(me, 'export') && <button className="btn" onClick={() => setShowExport(true)}><Download size={16} /> Export</button>}
          {createButton}
        </div>
      </header>

      <nav className="view-tabs" aria-label="Views">
        {views.map((v) => (
          <div key={v.id} className={`view-tab${v.id === activeView?.id ? ' active' : ''}`}>
            <button className="view-tab-name" onClick={() => showView(v.id)} aria-current={v.id === activeView?.id ? 'page' : undefined}>{v.name}</button>
            {v.id === activeView?.id && (
              <Menu
                align="left"
                trigger={(toggle) => (
                  <button className="icon-btn view-tab-menu" onClick={toggle} aria-label="View options">
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
        <button className="btn small ghost view-tab-add" onClick={() => setViewDialog({ mode: 'create', name: '' })}>
          <Plus size={14} /> Add view
        </button>
      </nav>

      {picked.size > 0 || picking ? (
        <div className="table-toolbar selection-bar" role="region" aria-label="Selected records">
          <span className="selection-count" role="status">{picked.size.toLocaleString()} selected</span>
          {archived && schema?.permissions.delete && (
            <button className="btn small ghost" onClick={restorePicked} disabled={restoring || picked.size === 0}>
              <RotateCcw size={14} /> {restoring ? 'Restoring…' : 'Restore all'}
            </button>
          )}
          {archived && me?.is_admin && (
            <button className="btn small ghost danger-text" onClick={() => setBulk('remove')} disabled={picked.size === 0}>
              <Trash2 size={14} /> Delete permanently
            </button>
          )}
          {!archived && schema?.permissions.edit && (
            <button className="btn small ghost" onClick={() => setBulk('edit')} disabled={picked.size === 0}>
              <Pencil size={14} /> Edit all
            </button>
          )}
          {!archived && schema?.permissions.delete && (
            <button className="btn small ghost danger-text" onClick={() => setBulk('delete')} disabled={picked.size === 0}>
              <Trash2 size={14} /> Delete all
            </button>
          )}
          {isMobile && (
            <button className="btn small ghost" onClick={pickAll} disabled={shown.length === 0}>
              {allPicked ? 'Unselect all' : 'Select all'}
            </button>
          )}
          <button className="btn small ghost selection-clear" onClick={clearPicked}>
            <X size={14} /> {isMobile ? 'Done' : 'Clear selection'}
          </button>
        </div>
      ) : (
        <div className="table-toolbar">
          <div className="table-search">
            <Search size={15} aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${plural}`}
              aria-label={`Search ${plural}`} title={`Searches ${searchedFields}`} />
            {query && (
              <button className="icon-btn" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>
          {quickProps.map((p) => {
            const picked = searchParams.get(p.api_name) ?? '';
            const opts = (p.dropdown_options ?? []).filter((o) => o.record_status === 'active' || o.api_value === picked);
            return (
              <Select key={p.api_name} className="table-quick-filter" style={{ width: 180 }} value={picked} aria-label={`Filter by ${p.label.toLowerCase()}`}
                onChange={(v) => setQuick(p.api_name, v)}
                options={[
                  { value: '', label: `Any ${p.label.toLowerCase()}` },
                  ...(me.user && opts.some((o) => o.api_value === me.user!.id) ? [{ value: me.user.id, label: 'Me' }] : []),
                  ...opts.filter((o) => o.api_value !== me.user?.id).map((o) => ({ value: o.api_value, label: o.label }))
                ]} />
            );
          })}
          <button type="button" className={`btn${isMobile ? ' icon-only' : ''} table-filters-btn`} onClick={() => setShowFilters(true)}
            aria-label={isMobile ? `Filters${filterCount ? ` (${filterCount})` : ''}` : undefined} aria-expanded={showFilters}>
            <ListFilter size={14} />{!isMobile && ' Filters'}
            {filterCount > 0 && <span className="af-count">{filterCount}</span>}
          </button>
          {archived && (
            <button type="button" className="table-archived-chip" onClick={() => showArchived(false)} title={`Back to active ${plural}`}>
              <Archive size={13} /> Archived only <X size={13} />
            </button>
          )}
          {dirty && <span className="table-note">Changes aren't saved: this shared view is admin-managed. Use "Save as new view" to keep them.</span>}
          {isMobile ? (
            <div className="table-phone-actions">
              <button className="btn" onClick={() => setSelectMode(true)} disabled={shown.length === 0}>Select</button>
              <Menu
                align="right"
                trigger={(toggle) => (
                  <button className="btn icon-only" onClick={toggle} aria-label="Sort">
                    <ArrowUpDown size={16} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <div className="menu-label">Sort by</div>
                    {sortable.map((p) => {
                      const dir = sorts[0]?.property === p.api_name ? sorts[0].direction : null;
                      return (
                        <button key={p.api_name} className={dir ? 'sort-current' : undefined} onClick={() => { close(); clickHeader(p.api_name); }}>
                          <span className="sort-option-label" title={p.description || undefined}>{p.label}</span>
                          {dir && <span className="sort-option-dir">{dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />} {directionWords(p, dir)}</span>}
                        </button>
                      );
                    })}
                    {sortable.length === 0 && <div className="menu-label">Add a column to sort by it.</div>}
                  </>
                )}
              </Menu>
              <button className="btn icon-only" onClick={() => setShowColumns(true)} aria-label="Edit columns">
                <Columns3 size={16} />
              </button>
              {tableMenu}
            </div>
          ) : (
            <>
              <button className="btn table-columns" onClick={() => setShowColumns(true)}>
                <Columns3 size={16} /> Edit columns
              </button>
              {tableMenu}
            </>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className={`table-frame${isMobile ? ' cards' : ''}`}>
        {isMobile ? (
          <ul className="record-cards">
            {shown.map((r) => {
              const title = recordName(r);
              const on = picked.has(r.id);
              const fields = cardColumns
                .map((f) => ({ label: f.label, text: cellText(r, f.column, f.index, false) }))
                .filter((f) => f.text && f.text !== title);
              const body = (
                <>
                  {picking && <span className="record-card-check" aria-hidden="true">{on && <Check size={14} strokeWidth={3} />}</span>}
                  <span className="record-card-body">
                    <span className="record-card-title">{title}</span>
                    {fields.map((f, k) => (
                      <span key={k} className="record-card-field">
                        <span className="record-card-label">{f.label}</span>
                        <span className="record-card-value">{f.text}</span>
                      </span>
                    ))}
                  </span>
                </>
              );
              const touch = {
                onTouchStart: (e: React.TouchEvent) => pressStart(e, r.id),
                onTouchMove: pressMove,
                onTouchEnd: pressEnd,
                onTouchCancel: pressEnd,
                onContextMenu: (e: React.MouseEvent) => e.preventDefault()
              };
              return (
                <li key={r.id}>
                  {picking ? (
                    <button
                      type="button"
                      className={`record-card${on ? ' picked' : ''}`}
                      aria-pressed={on}
                      {...touch}
                      onClick={() => {
                        if (press.current.fired) press.current.fired = false; // the long press already picked it
                        else togglePick(r.id);
                      }}
                    >
                      {body}
                    </button>
                  ) : (
                    <Link
                      className="record-card"
                      to={`/objects/${object}/${r.id}`}
                      {...touch}
                      onClick={(e) => {
                        if (!press.current.fired) return;
                        press.current.fired = false;
                        e.preventDefault();
                      }}
                    >
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <table className={`data-grid${data && reloading ? ' reloading' : ''}`}>
            <thead>
              <tr>
                <th className="pick-cell">
                  <input
                    type="checkbox"
                    aria-label={`Select all ${shown.length.toLocaleString()} shown`}
                    title={`Select all ${shown.length.toLocaleString()} shown`}
                    checked={allPicked}
                    disabled={shown.length === 0}
                    ref={(el) => {
                      if (el) el.indeterminate = pickedCount > 0 && !allPicked;
                    }}
                    onChange={pickAll}
                  />
                </th>
                {columns.map((c, i) => {
                  if (c.type === 'association') {
                    const other = objectByName.get(c.object);
                    if (!other) return null;
                    const hp = headerProps(i);
                    return (
                      <th key={i} {...hp}>
                        {headerHandles(i)}
                        <div className="dg-head">
                          <span className="dg-label">{associationColumnLabel(c, other, labels, object, objectByName)}</span>
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
                    <th key={i} {...hp} className={`${hp.className}${sorted ? ' sorted' : ''}`} aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}>
                      {headerHandles(i)}
                      <div className="dg-head">
                        <button className="dg-sort" onClick={() => clickHeader(prop.api_name)}>
                          <span className="dg-label" title={prop.description || undefined}>{prop.label}</span>
                          {sorted === 'asc' ? <ArrowUp size={13} /> : sorted === 'desc' ? <ArrowDown size={13} /> : <ArrowUpDown size={13} className="dg-sort-idle" />}
                        </button>
                        <ColumnMenu
                          onSort={(direction) => changeView({ sorts: [{ property: prop.api_name, direction }] })}
                          onRemove={() => changeView({ columns: columns.filter((_, j) => j !== i) })}
                        />
                      </div>
                    </th>
                  );
                })}
                <th className="dg-fill" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {data?.results.map((r, ri) => (
                <tr key={r.id} className={picked.has(r.id) ? 'picked' : undefined}>
                  <td className="pick-cell">
                    <input type="checkbox" aria-label={`Select ${recordName(r)}`} checked={picked.has(r.id)} onChange={() => undefined} onClick={(e) => pickRow(e, ri)} />
                  </td>
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
                    const editable = !archived && schema.permissions.edit && isEditable(prop);
                    const extra = [editable ? 'editable' : '', editing?.record.id === r.id && editing.property.api_name === prop.api_name ? 'editing' : ''].filter(Boolean);
                    if (i === 0 || prop.api_name === 'name') {
                      return (
                        <td key={i} {...cellProps(ri, i, c, ['primary-cell', ...extra])}>
                          <Link className="dg-name" to={`/objects/${object}/${r.id}`}>{cellText(r, c, i)}</Link>
                          {editable && editButton(r, prop)}
                        </td>
                      );
                    }
                    return (
                      <td key={i} {...cellProps(ri, i, c, extra)}>
                        {displayValue(prop, r.properties[prop.api_name]) || <span className="muted empty-value">--</span>}
                        {editable && editButton(r, prop)}
                      </td>
                    );
                  })}
                  <td className="dg-fill" aria-hidden="true" />
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* first load, or a new search while nothing is shown */}
        {(!data || (loading && data.results.length === 0)) && !error && <TableSkeleton rows={8} />}
        {data && data.results.length === 0 && !loading && (
          <div className="table-empty">
            {debounced ? (
              <EmptyState
                icon={<Search size={18} />}
                title={`No ${archived ? 'archived ' : ''}${plural} match "${debounced}"`}
                action={<button className="btn" onClick={() => setQuery('')}>Clear search</button>}
              >
                The search looks at {searchedFields}.
              </EmptyState>
            ) : filterCount > 0 ? (
              <EmptyState
                icon={<ListFilter size={18} />}
                title={`No ${archived ? 'archived ' : ''}${plural} match these filters`}
                action={<button className="btn" onClick={() => setShowFilters(true)}>Edit filters</button>}
              >
                {filterCount === 1 ? 'One filter is' : `${filterCount} filters are`} on for this view.
              </EmptyState>
            ) : archived ? (
              <EmptyState
                icon={<Archive size={18} />}
                title={`No archived ${plural}`}
                action={<button className="btn" onClick={() => showArchived(false)}>Show active {plural}</button>}
              >
                Deleted {plural} are kept here, and can be restored from this list.
              </EmptyState>
            ) : (
              <EmptyState icon={<Icon size={18} />} title={`No ${plural} yet`} action={createButton}>
                {object === 'files' ? 'Upload a file and it shows up here.' : `Create the first ${singular} and it shows up here.`}
              </EmptyState>
            )}
          </div>
        )}
        {data && data.results.length > 0 && (loading || data.next) && (
          <div className="table-foot">
            <span>{data.results.length.toLocaleString()} of {data.total.toLocaleString()} shown</span>
            {loading ? (
              <Loading inline className="table-foot-loading" />
            ) : (
              <button className="btn small" onClick={() => fetchPage(data.next!)}>Load more</button>
            )}
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
      {bulk === 'edit' && (
        <BulkEditModal
          object={object}
          schema={schema}
          ids={[...picked]}
          onClose={() => setBulk(null)}
          onDone={(n, property) => {
            const ids = [...picked];
            bulkDone(`${n.toLocaleString()} ${n === 1 ? 'record' : 'records'} updated`, false);
            if (AMOUNT_FIELDS.includes(property)) void offerForLines(ids);
          }}
        />
      )}
      {bulk === 'remove' && (
        <BulkRemoveModal
          object={object}
          schema={schema}
          ids={[...picked]}
          onClose={() => setBulk(null)}
          onDone={(n) => bulkDone(`${n.toLocaleString()} ${n === 1 ? 'record' : 'records'} permanently deleted`, true)}
        />
      )}
      {bulk === 'delete' && (
        <BulkDeleteModal
          object={object}
          schema={schema}
          ids={[...picked]}
          onClose={() => setBulk(null)}
          onDone={(n) => {
            const ids = [...picked];
            bulkDone(`${n.toLocaleString()} ${n === 1 ? 'record' : 'records'} deleted`, true);
            void offerForLines(ids);
          }}
        />
      )}
      {showCreate && object === 'lines' && (
        <AddLineModal
          onClose={() => setShowCreate(false)}
          onCreated={(r) => {
            setShowCreate(false);
            navigate(`/objects/${object}/${r.id}`);
          }}
        />
      )}
      {showCreate && object === 'users' && canAddUsers && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={(r) => {
            setShowCreate(false);
            navigate(`/objects/${object}/${r.id}`);
          }}
        />
      )}
      {showCreate && object !== 'lines' && !(object === 'users' && canAddUsers) && (
        <CreateRecordModal
          object={schema}
          onClose={() => setShowCreate(false)}
          onCreated={(r) => {
            setShowCreate(false);
            navigate(`/objects/${object}/${r.id}`);
          }}
        />
      )}
      {showExport && (
        <ExportModal
          object={schema}
          onClose={() => setShowExport(false)}
          view={{
            query: debounced || undefined,
            status: archived ? 'archived' : undefined,
            sorts,
            // property columns in the order shown
            properties: [...new Set(columns.flatMap((c) => (c.type === 'property' && schema.properties.some((p) => p.api_name === c.property) ? [c.property] : [])))],
            total: data?.total ?? null,
            picked: shown.filter((r) => picked.has(r.id)).map((r) => r.id)
          }}
        />
      )}
      {showImport && (
        <ImportModal object={schema} onClose={() => setShowImport(false)} onImported={() => fetchPage()} />
      )}
      {showFilters && (
        <FiltersPanel
          title="Filters"
          note={activeView && !activeView.editable ? 'This shared view is admin-managed: filters apply now, use "Save as new view" to keep them.' : undefined}
          onClose={() => setShowFilters(false)}
          onClear={filterGroups.length ? () => changeFilters([]) : undefined}
        >
          <AdvancedFilters fields={filterFields} groups={filterGroups} onChange={changeFilters}
            searchPlaceholder={`Search ${schema.label_singular.toLowerCase()} properties`}
            objectLabel={schema.label_singular} onPickerOpen={() => setWantAllLinked(true)} fieldsLoading={linkedLoading} objectIcon={objectIcon}
            pinnedObjects={PINNED_FILTER_OBJECTS[object] ?? PINNED_FILTER_OBJECTS.default} />
        </FiltersPanel>
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
              <button className="btn primary" onClick={saveViewDialog} disabled={!viewDialogReady}>Save</button>
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

// how a sort reads in the phone Sort menu
// The right-hand panel that holds a table's filters, like HubSpot's
// "All filters": the table stays usable beside it and updates as filters change.
function FiltersPanel({ title, note, onClose, onClear, children }: {
  title: string; note?: string; onClose: () => void; onClear?: () => void; children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes an open menu or picker first
      if (e.key === 'Escape' && !document.querySelector('.select-menu, .af-picker')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="af-panel" role="dialog" aria-label={title}>
      <header className="af-panel-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close filters"><X size={18} /></button>
      </header>
      <div className="af-panel-body">
        {children}
      </div>
      <footer className="af-panel-foot">
        <span className="muted" style={{ fontSize: 12 }}>{note ?? 'Filters in a group must all match; any group can match.'}</span>
        {onClear && <button className="btn small ghost" onClick={onClear}>Clear all</button>}
      </footer>
    </aside>
  );
}

function directionWords(p: Property, dir: 'asc' | 'desc'): string {
  const t = valueType(p);
  if (t === 'number') return dir === 'asc' ? 'Low to high' : 'High to low';
  if (t === 'date' || t === 'datetime') return dir === 'asc' ? 'Oldest first' : 'Newest first';
  return dir === 'asc' ? 'A to Z' : 'Z to A';
}

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
  // multi-choice dropdowns, email and phone lists and long text (a textarea) save with a button
  const needsSave = property.type === 'email' || property.type === 'phone' ? true
    : property.type === 'dropdown'
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
    // a new primary address or number is confirmed first; No keeps the editor open
    if ((property.type === 'email' || property.type === 'phone') && !(await confirmPrimaryChange(property.type, record.properties[property.api_name], value))) {
      done.current = false;
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

  // A picked address (Settings → Address autocomplete): the street and the
  // rest of its group are saved together. Properties this table can't edit
  // are left out (the API would refuse them anyway).
  const fill = useCallback(async (values: Record<string, string>) => {
    if (done.current) return;
    done.current = true;
    const schema = await getSchema(object);
    const properties: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(values)) {
      const p = schema.properties.find((x) => x.api_name === name);
      if (!p || !isEditable(p)) continue;
      const v = fromInput(p, text);
      if (JSON.stringify(v) !== JSON.stringify(record.properties[name] ?? null)) properties[name] = v;
    }
    if (Object.keys(properties).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await api<CrmRecord>('PATCH', `/v1/objects/${object}/${record.id}`, { properties }));
      onClose();
      toast('Address saved');
    } catch (err) {
      done.current = false;
      setSaving(false);
      setError((err as Error).message);
    }
  }, [object, record, onClose, onSaved]);

  useEffect(() => {
    // the date calendar and dropdown lists are rendered on <body>, so clicks in them count as inside
    const outside = (e: Event) => !boxRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.flatpickr-calendar, .select-menu');
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

  // email and phone lists edit as a small table of rows
  const width = Math.min(Math.max(rect.width, property.type === 'email' || property.type === 'phone' ? 460 : 240), window.innerWidth - 16);
  const style: React.CSSProperties = {
    top: Math.max(8, Math.min(rect.top, window.innerHeight - 240)),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    width
  };
  return createPortal(
    <div className="grid-editor" ref={boxRef} style={style}>
      <PropertyInput
        property={property}
        object={object}
        value={draft}
        autoFocus
        onChange={(v) => {
          draftRef.current = v;
          setDraft(v);
          if (singleChoice) commit();
        }}
        onCommit={needsSave ? undefined : commit}
        onFill={fill}
      />
      {(needsSave || error || saving) && (
        <div className="grid-editor-foot">
          {error && <span className="error-text">{error}</span>}
          {saving && <span className="muted small">Saving…</span>}
          {needsSave && !saving && (
            <>
              <button className="btn small" onClick={() => { done.current = true; onClose(); }}>Cancel</button>
              <button className="btn small primary" onClick={() => commit()} disabled={norm(fromInput(property, draft)) === norm(record.properties[property.api_name])}>Save</button>
            </>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}

type MultiMode = 'append' | 'remove' | 'replace';

// Sends ids to a bulk endpoint 500 at a time. Each call is all or nothing, so
// an error partway leaves the earlier calls' records changed; the message
// says how many.
async function inChunks(ids: string[], send: (chunk: string[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    try {
      await send(ids.slice(i, i + BULK_CHUNK));
    } catch (err) {
      if (i === 0) throw err;
      throw new Error(`${i.toLocaleString()} of ${ids.length.toLocaleString()} records were changed, then: ${(err as Error).message}`);
    }
  }
}

// Sets one property on every ticked record. Unique properties are left out
// (one value can't be on two records), as are ones nobody can edit.
// Multi-choice dropdowns can add choices, take them away or replace them.
export function BulkEditModal({ object, schema, ids, onClose, onDone }: {
  object: string; schema: ObjectDef; ids: string[]; onClose: () => void; onDone: (n: number, property: string) => void;
}) {
  const properties = useMemo(
    () => schema.properties.filter((p) => isEditable(p) && p.options.unique !== true && p.type !== 'email' && p.type !== 'phone').sort((a, b) => a.label.localeCompare(b.label)),
    [schema]
  );
  const [name, setName] = useState('');
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<MultiMode>('append');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const property = properties.find((p) => p.api_name === name);
  const multi = property?.type === 'dropdown' && property.options.single_value !== true;
  const value = property ? fromInput(property, draft) : null;
  const ready = !!property && !saving && (!multi || mode === 'replace' || value !== null);
  const noun = ids.length === 1 ? 'record' : 'records';

  async function save() {
    if (!property || !ready) return;
    setSaving(true);
    setError(null);
    try {
      await inChunks(ids, (chunk) =>
        api('POST', `/v1/objects/${object}/bulk/update`, {
          ids: chunk,
          properties: { [property.api_name]: value },
          ...(multi ? { modes: { [property.api_name]: mode } } : {})
        })
      );
      onDone(ids.length, property.api_name);
    } catch (err) {
      setSaving(false);
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      title={`Edit ${ids.length.toLocaleString()} ${noun}`}
      onClose={onClose}
      footer={
        <>
          <SaveHint missing={[!property && 'a property']} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!ready}>{saving ? 'Saving…' : `Update ${ids.length.toLocaleString()} ${noun}`}</button>
        </>
      }
    >
      <div className="bulk-edit">
        <label className="field">
          <span>Property</span>
          <Select value={name} autoFocus onChange={(v) => { setName(v); setDraft(''); setMode('append'); setError(null); }}>
            <option value="">Choose a property</option>
            {properties.map((p) => (
              <option key={p.api_name} value={p.api_name}>{p.label}</option>
            ))}
          </Select>
        </label>
        {multi && (
          <label className="field">
            <span>How to change it</span>
            <Select value={mode} onChange={(v) => setMode(v as MultiMode)}>
              <option value="append">Add these choices to what each record has</option>
              <option value="remove">Remove these choices from each record</option>
              <option value="replace">Replace each record's choices with these</option>
            </Select>
          </label>
        )}
        {property && (
          <div className="field">
            <span>{multi ? 'Choices' : 'New value'}</span>
            <PropertyInput key={property.api_name} property={property} object={object} value={draft} onChange={setDraft} />
          </div>
        )}
        {property && value === null && (!multi || mode === 'replace') && (
          <p className="muted small">Left empty, this clears {property.label.toLowerCase()} on every selected record.</p>
        )}
        <p className="muted small">Unique properties can't be set on several records at once, so they aren't listed.</p>
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

// Deleting from the table archives, like the record page: the records go to
// the recycle bin rather than being removed for good.
export function BulkDeleteModal({ object, schema, ids, onClose, onDone }: {
  object: string; schema: ObjectDef; ids: string[]; onClose: () => void; onDone: (n: number) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const label = (ids.length === 1 ? schema.label_singular : schema.label_plural).toLowerCase();

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await inChunks(ids, (chunk) => api('POST', `/v1/objects/${object}/bulk/archive`, { ids: chunk }));
      onDone(ids.length);
    } catch (err) {
      setSaving(false);
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      title={`Delete ${ids.length.toLocaleString()} ${label}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={remove} disabled={saving}>{saving ? 'Deleting…' : `Delete ${ids.length.toLocaleString()} ${label}`}</button>
        </>
      }
    >
      <p>The selected {label} are archived (moved to the recycle bin), not removed for good.</p>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

// "Delete permanently" in the archived list (admins only): every value and
// the history are wiped, only the record IDs are kept.
function BulkRemoveModal({ object, schema, ids, onClose, onDone }: {
  object: string; schema: ObjectDef; ids: string[]; onClose: () => void; onDone: (n: number) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const label = (ids.length === 1 ? schema.label_singular : schema.label_plural).toLowerCase();

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await inChunks(ids, (chunk) => api('POST', `/v1/objects/${object}/bulk/permanently-delete`, { ids: chunk }));
      onDone(ids.length);
    } catch (err) {
      setSaving(false);
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      title={`Permanently delete ${ids.length.toLocaleString()} ${label}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={remove} disabled={saving}>{saving ? 'Deleting…' : `Delete ${ids.length.toLocaleString()} ${label} permanently`}</button>
        </>
      }
    >
      <p>Every value, link and change history of the selected {label} is erased for good. This cannot be undone.</p>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

function ColumnMenu({ onSort, onRemove }: { onSort?: (d: 'asc' | 'desc') => void; onRemove: () => void }) {
  return (
    <Menu
      align="right"
      trigger={(toggle) => (
        <button className="icon-btn dg-menu" onClick={toggle} aria-label="Column options">
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
      <span className="dg-many" tabIndex={0} onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={hide} onFocus={(e) => show(e.currentTarget)} onBlur={hide}>
        {items.length} {pluralLabel}
      </span>
      {anchor &&
        createPortal(
          <div
            className="assoc-hovercard"
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
