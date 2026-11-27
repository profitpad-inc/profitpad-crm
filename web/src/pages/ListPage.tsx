import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Columns3, Plus, RefreshCw, RotateCcw, Search, Trash2, UserMinus, UserPlus, X } from 'lucide-react';
import { api, getSchema, type AssociationLabel, type Column, type CrmRecord, type ObjectDef, type SearchResult, type View } from '../lib/api';
import { useApp } from '../lib/app-context';
import { displayName, displayValue, initials, objectIcon } from '../lib/display';
import {
  MAX_LIST_CONDITIONS, MAX_LIST_GROUPS, compareKey, definitionGroups, describeFilter, fieldsFromSchema, filterKey, fromSearchDefinition,
  groupsDefinition, listMembershipField, operatorOf, parseDefinitionText, toSearchDefinition, type Filter, type FilterField, type ListDefinition
} from '../lib/filters';
import { useListChoices } from '../lib/lists';
import { AdvancedFilters } from '../components/AdvancedFilters';
import { CodeBlock } from '../components/CodeBlock';
import { Loading } from '../components/Loading';
import { Select } from '../components/Select';
import { confirmDialog } from '../components/confirm';
import { REFRESH_OPTIONS } from '../components/ListDialogs';
import { ColumnPicker, associationColumnLabel } from '../components/ColumnPicker';
import { AssociationCard, ChangeHistory, LedgerDay, PropertyList, byDay, isoLocal, loadLinked, type Associated } from './RecordPage';
import '../table.css';
import '../lists.css';

// A list's own page (lists, api/src/lists), not the usual record page:
//
//   header   name, what it's for, its rule as a sentence, how many are in it,
//            and how it stays up to date (type, schedule, Refresh now)
//   left     the rule: Filters (edit, live count, Save) and SQL
//   right    the records: Members (the actual records, searchable; static
//            lists add and remove), Associations (email campaigns), History
//            (who joined and left), Settings (properties, custom ones too,
//            type, recycle bin)

type RightTab = 'members' | 'associations' | 'history' | 'changes' | 'sql' | 'settings';
const RIGHT_TABS: { key: RightTab; label: string }[] = [
  { key: 'members', label: 'Members' }, { key: 'associations', label: 'Associations' }, { key: 'history', label: 'Member history' },
  { key: 'changes', label: 'Filter changes' }, { key: 'sql', label: 'SQL' }, { key: 'settings', label: 'Settings' }
];
// The filters as they stand in the left pane (edits included), for the SQL tab.
interface RuleState { sql: string | null; error: string | null; dirty: boolean; empty: boolean }
interface Preview { count: number; sample: { id: string; name: string | null }[]; sql: string }
interface Member extends CrmRecord { added_at: string }
interface Change { id: number; record_id: string; name: string | null; change: 'added' | 'removed'; source: 'refresh' | 'manual'; changed_by: string | null; changed_by_name: string | null; at: string }

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const ago = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return when(iso);
};

// The rule in words: "First name is any of Ann or Bob, and Created at is
// after Deal: Created at (every associated deal)".
function describeDefinition(def: ListDefinition, fields: FilterField[]): string {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const one = (c: Filter) => {
    const field = byKey.get(filterKey(c));
    if (c.compare_to) {
      const target = byKey.get(compareKey(c.compare_to));
      const op = operatorOf(field, c.operator, true);
      const linked = c.association?.object ?? c.compare_to.association?.object;
      const who = linked ? ` (${c.compare_to.quantifier === 'all' ? 'every' : 'any'} associated ${(fields.find((f) => f.association?.object === linked)?.group ?? linked).toLowerCase()})` : '';
      const name = (f: FilterField | undefined, fallback: string) => (f ? (f.group ? `${f.group}: ${f.label}` : f.label) : fallback);
      return `${name(field, c.property)} ${op?.label ?? c.operator} ${name(target, c.compare_to.property)}${who}`;
    }
    const text = describeFilter(c, field);
    return field?.group ? `${field.group}: ${text}` : text;
  };
  const inside = def.match === 'all' ? ' or ' : ' and ';
  const between = def.match === 'all' ? ', and ' : '; or ';
  return def.groups.map((g) => g.conditions.map(one).join(inside)).join(between);
}

function ruleSentence(raw: unknown, schema: ObjectDef, fields: FilterField[]): string {
  const def = fromSearchDefinition(parseDefinitionText(typeof raw === 'string' ? raw : JSON.stringify(raw)), fields);
  return def.groups.length ? `${schema.label_plural} where ${describeDefinition(def, fields)}` : 'No filters (every record)';
}

export function ListPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { objectByName, toast } = useApp();
  const [record, setRecord] = useState<CrmRecord | null>(null);
  const [listsSchema, setListsSchema] = useState<ObjectDef | null>(null);
  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [linked, setLinked] = useState<ObjectDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [right, setRight] = useState<RightTab>('members');
  const [refreshing, setRefreshing] = useState(false);
  const [ruleState, setRuleState] = useState<RuleState>({ sql: null, error: null, dirty: false, empty: true });
  // bumped when membership changes here, so the record lists load again
  const [version, setVersion] = useState(0);

  const reload = useCallback(async () => {
    setRecord(await api<CrmRecord>('GET', `/v1/objects/lists/${id}`));
  }, [id]);
  useEffect(() => {
    setRecord(null);
    setError(null);
    reload().catch((e) => setError((e as Error).message));
    getSchema('lists').then(setListsSchema).catch(() => undefined);
  }, [reload]);

  const p = record?.properties ?? {};
  const listObject = String(p.list_object ?? '');
  // the listed object and everything it links to, for the filters' fields
  useEffect(() => {
    if (!listObject) return;
    let live = true;
    getSchema(listObject).then(async (s) => {
      if (!live) return;
      setSchema(s);
      const names = s.links_to.filter((o) => o !== 'lists' && objectByName.has(o));
      const others = await Promise.all(names.map((o) => getSchema(o).catch(() => null)));
      if (live) setLinked(others.filter((o): o is ObjectDef => !!o));
    }).catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [listObject]); // eslint-disable-line react-hooks/exhaustive-deps

  // other lists, for "List membership" conditions (never this list itself)
  const listChoices = useListChoices();
  const fields = useMemo<FilterField[]>(() => {
    if (!schema) return [];
    const ownList = listMembershipField(schema.api_name, listChoices, undefined, id);
    return [
      ...fieldsFromSchema(schema.properties),
      ...(ownList ? [ownList] : []),
      ...linked.flatMap((o) => {
        const a = { object: o.api_name, group: o.label_singular, plural: o.label_plural };
        const listField = listMembershipField(schema.api_name, listChoices, a);
        return [...fieldsFromSchema(o.properties, a), ...(listField ? [listField] : [])];
      })
    ];
  }, [schema, linked, listChoices, id]);

  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!record || !schema) return <div className="page"><Loading /></div>;

  const dynamic = (first(p.list_type) ?? 'dynamic') === 'dynamic';
  const archived = record.record_status === 'archived';
  const memberCount = Number(p.member_count ?? 0);
  const noun = (n: number) => (n === 1 ? schema.label_singular : schema.label_plural).toLowerCase();
  const savedDef = parseDefinitionText(p.definition);
  const rule = savedDef.groups.length ? describeDefinition(fromSearchDefinition(savedDef, fields), fields) : null;
  const description = typeof p.description === 'string' ? p.description.trim() : '';
  const ruleText = rule
    ? `${schema.label_plural} where ${rule}.`
    : dynamic ? `Every ${schema.label_singular.toLowerCase()}: there are no filters yet.` : `${schema.label_plural} added by hand.`;

  async function refreshNow() {
    setRefreshing(true);
    try {
      const r = await api<{ added: number; removed: number; members: number }>('POST', `/v1/lists/${id}/refresh`);
      toast(`Refreshed: ${r.members.toLocaleString()} ${noun(r.members)} (${r.added.toLocaleString()} joined, ${r.removed.toLocaleString()} left).`);
      setVersion((v) => v + 1);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setRefreshing(false);
      await reload();
    }
  }

  async function setSchedule(v: string) {
    try {
      setRecord(await api<CrmRecord>('PATCH', `/v1/objects/lists/${id}`, { properties: { refresh_schedule: v } }));
      toast('Refresh schedule saved.');
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const changed = (r: CrmRecord) => { setRecord(r); setVersion((v) => v + 1); };

  return (
    <div className="list-page">
      <header className="list-head">
        <div className="list-head-row">
          <Link to="/objects/lists" className="list-back" aria-label="Back to lists"><ChevronLeft size={16} aria-hidden /> Lists</Link>
          <h1 title={String(p.name ?? '')}>{String(p.name ?? '') || 'Untitled list'}</h1>
          <span className={`list-kind ${dynamic ? 'dynamic' : 'static'}`}>{dynamic ? 'Dynamic' : 'Static'}</span>
          <span className="list-count"><strong>{memberCount.toLocaleString()}</strong> {noun(memberCount)}</span>
          <span className="list-head-gap" />
          {archived ? (
            <span className="muted small">In the recycle bin: it doesn't refresh, and campaigns skip it.</span>
          ) : dynamic ? (
            <>
              <span className="muted small" title={p.last_refreshed_at ? when(p.last_refreshed_at as string) : undefined}>
                {p.last_refreshed_at ? `Refreshed ${ago(p.last_refreshed_at as string)}` : 'Working out its members…'}
              </span>
              <Select className="list-schedule" value={first(p.refresh_schedule) ?? 'hourly'} aria-label="Refresh schedule" onChange={setSchedule} options={REFRESH_OPTIONS} />
              <button className="btn small" onClick={refreshNow} disabled={refreshing}>
                <RefreshCw size={14} className={refreshing ? 'spin' : undefined} aria-hidden /> {refreshing ? 'Refreshing…' : 'Refresh now'}
              </button>
            </>
          ) : (
            <span className="muted small">
              Changes only by hand{savedDef.groups.length && p.last_refreshed_at ? `; last filled from its filters ${when(p.last_refreshed_at as string)}` : ''}
            </span>
          )}
        </div>
        <p className="list-head-sub" title={[description, ruleText].filter(Boolean).join(' ')}>
          {description && <span className="list-description">{description}</span>}
          <span className="list-rule">{ruleText}</span>
        </p>
        {typeof p.refresh_error === 'string' && p.refresh_error && <div className="error">The last refresh failed: {p.refresh_error}</div>}
      </header>

      <div className="list-body">
        <RulePane key={`${dynamic}-${version}`} record={record} schema={schema} listsSchema={listsSchema} fields={fields} dynamic={dynamic} archived={archived}
          onSaved={setRecord} onFilled={() => setVersion((v) => v + 1)} onRule={setRuleState} />

        <section className="list-records" aria-label="The list's records">
          <div className="tabs list-tabs" role="tablist">
            {RIGHT_TABS.map((t) => (
              <div key={t.key} className={`tab${right === t.key ? ' active' : ''}`}>
                <button role="tab" aria-selected={right === t.key} onClick={() => setRight(t.key)}>{t.label}</button>
              </div>
            ))}
          </div>
          {right === 'members' && <MembersTab key={version} record={record} schema={schema} dynamic={dynamic} archived={archived} onChanged={changed} />}
          {right === 'associations' && <AssociationsTab record={record} listObject={listObject} />}
          {right === 'history' && <HistoryTab key={version} listId={id} object={schema.api_name} noun={noun} />}
          {right === 'changes' && (
            listsSchema ? (
              <div className="list-changelog">
                <ChangeHistory object="lists" id={id} schema={listsSchema} fixedProperty="definition" hideSettingsLink
                  renderValue={(prop, v) => (prop === 'definition' ? <span className="list-rule-change">{ruleSentence(v, schema, fields)}</span> : undefined)} />
              </div>
            ) : <Loading />
          )}
          {right === 'sql' && <SqlTab key={version} listId={id} rule={ruleState} dynamic={dynamic} />}
          {right === 'settings' && listsSchema && (
            <SettingsTab record={record} listsSchema={listsSchema} schema={schema} dynamic={dynamic} archived={archived}
              onChanged={changed} onArchived={() => navigate('/objects/lists')} />
          )}
        </section>
      </div>
    </div>
  );
}

// ---- left: the rule ---------------------------------------------------------

function RulePane({ record, schema, fields, dynamic, archived, onSaved, onFilled, onRule }: {
  record: CrmRecord; schema: ObjectDef; listsSchema: ObjectDef | null; fields: FilterField[]; dynamic: boolean; archived: boolean;
  onSaved: (r: CrmRecord) => void; onFilled: () => void; onRule: (r: RuleState) => void;
}) {
  const { toast } = useApp();
  const stored = record.properties.definition;
  const savedDef = useMemo(() => fromSearchDefinition(parseDefinitionText(stored), fields), [stored, fields]);
  const [def, setDef] = useState<ListDefinition>(savedDef);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [counting, setCounting] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDef(savedDef), [savedDef]);

  const outgoing = toSearchDefinition(def, fields);
  const dirty = JSON.stringify(outgoing) !== JSON.stringify(toSearchDefinition(savedDef, fields));
  const noun = (n: number) => (n === 1 ? schema.label_singular : schema.label_plural).toLowerCase();

  useEffect(() => {
    setCounting(true);
    const t = setTimeout(() => {
      api<Preview>('POST', '/v1/lists/preview', { object: schema.api_name, definition: outgoing })
        .then((r) => { setPreview(r); setPreviewError(null); })
        .catch((e) => { setPreview(null); setPreviewError((e as Error).message); })
        .finally(() => setCounting(false));
    }, 500);
    return () => clearTimeout(t);
  }, [JSON.stringify(outgoing), schema.api_name]); // eslint-disable-line react-hooks/exhaustive-deps

  // the SQL tab on the right shows the filters as they stand here
  useEffect(() => {
    onRule({ sql: preview?.sql ?? null, error: previewError, dirty, empty: def.groups.length === 0 });
  }, [preview, previewError, dirty, def.groups.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!dynamic) {
      const members = Number(record.properties.member_count ?? 0);
      const ok = await confirmDialog(
        `Its ${members.toLocaleString()} current ${noun(members)} are replaced by the ${(preview?.count ?? 0).toLocaleString()} ${noun(preview?.count ?? 0)} that match now. After that the list stays as it is until you fill it again or change it by hand. The filters are kept, so you can make the list dynamic later.`,
        { title: 'Fill the list from these filters?', confirmLabel: 'Save and fill' });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const saved = await api<CrmRecord>('PATCH', `/v1/objects/lists/${record.id}`, { properties: { definition: JSON.stringify(outgoing) } });
      if (dynamic) {
        onSaved(saved);
        toast('Filters saved. The members are worked out again within half a minute.');
      } else {
        const r = await api<{ members: number }>('POST', `/v1/lists/${record.id}/refresh`);
        onSaved(await api<CrmRecord>('GET', `/v1/objects/lists/${record.id}`));
        onFilled();
        toast(`The list now holds ${r.members.toLocaleString()} ${noun(r.members)}.`);
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="list-rule-pane" aria-label="The list's filters">
      <div className="list-rule-scroll">
        {!dynamic && !archived && (
          <p className="list-pane-note">Saving fills this static list once with the records these filters match. After that it stays as it is, and the filters are kept in case you make it dynamic.</p>
        )}
        {archived ? <p className="muted">Restore the list to change its filters.</p> : (
          <AdvancedFilters fields={fields} groups={definitionGroups(def)} onChange={(g) => setDef(groupsDefinition(def.match, g))}
            match={def.match} onMatchChange={(m) => setDef({ ...def, match: m })} allowCompare
            maxGroups={MAX_LIST_GROUPS} maxFilters={MAX_LIST_CONDITIONS}
            searchPlaceholder={`Search ${schema.label_singular.toLowerCase()} properties`} objectLabel={schema.label_singular} objectIcon={objectIcon} />
        )}
      </div>
      {!archived && (
        <footer className="list-rule-foot">
          <div className="list-match-count" aria-live="polite">
            {counting ? <Loading inline label="Counting…" />
              : previewError ? <span className="error">{previewError}</span>
              : preview && <>
                <strong>{preview.count.toLocaleString()}</strong> {noun(preview.count)} match now{def.groups.length === 0 ? ' (no filters)' : ''}
                {dynamic && !dirty && preview.count !== Number(record.properties.member_count ?? 0) && <span className="muted">; the list catches up on its next refresh</span>}
              </>}
          </div>
          <button className="btn small" disabled={!dirty || busy} onClick={() => setDef(savedDef)}>Discard</button>
          <button className="btn small primary" disabled={!dirty || busy || (!dynamic && def.groups.length === 0)} onClick={save}>
            {busy ? 'Saving…' : dynamic ? 'Save filters' : 'Save and fill'}
          </button>
        </footer>
      )}
    </aside>
  );
}

// The query that picks the members: the filters as they stand in the left
// pane, unsaved edits included; a static list without filters reads its
// stored members.
function SqlTab({ listId, rule, dynamic }: { listId: string; rule: RuleState; dynamic: boolean }) {
  const [wrap, setWrap] = useState(true);
  const [stored, setStored] = useState<string | null>(null);
  const fromMembers = !dynamic && rule.empty;
  useEffect(() => {
    if (!fromMembers) return;
    api<{ sql: string }>('GET', `/v1/lists/${listId}/sql`).then((r) => setStored(r.sql)).catch(() => setStored(null));
  }, [fromMembers, listId]);
  const sql = fromMembers ? stored : rule.sql;
  return (
    <div className="list-sql">
      <div className="list-sql-head">
        <p className="muted small">
          {fromMembers ? 'The query that reads its members.' : rule.dirty ? 'The query for the filters as edited on the left (not saved yet).' : 'The query that picks its members.'}
          {' '}Values are written in for reading.
        </p>
        <label className="small muted code-wrap-toggle">
          <input type="checkbox" role="switch" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines
        </label>
      </div>
      {sql ? <div className="list-sql-code"><CodeBlock text={sql} wrap={wrap} lang="sql" /></div> : rule.error && !fromMembers ? <div className="error">{rule.error}</div> : <Loading />}
    </div>
  );
}

// ---- right: the records -----------------------------------------------------

function MembersTab({ record, schema, dynamic, archived, onChanged }: {
  record: CrmRecord; schema: ObjectDef; dynamic: boolean; archived: boolean; onChanged: (r: CrmRecord) => void;
}) {
  const { toast, objectByName } = useApp();
  // the columns: the list's own (member_columns), else the object's first
  // table view's; Name always comes first. Properties, or associated records
  // of another object ("Associated deals"), as in the object tables.
  const [columns, setColumns] = useState<Column[] | null>(null);
  const [labels, setLabels] = useState<AssociationLabel[]>([]);
  const [picking, setPicking] = useState(false);
  const [rows, setRows] = useState<Member[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const editable = !dynamic && !archived;
  const byName = useMemo(() => new Map(schema.properties.map((pr) => [pr.api_name, pr])), [schema]);
  // saved as Column objects; an older plain property name still reads
  const ownColumns = useMemo((): Column[] | null => {
    try {
      const v = JSON.parse(String(record.properties.member_columns ?? ''));
      if (!Array.isArray(v)) return null;
      return v.flatMap((c): Column[] => (typeof c === 'string' ? [{ type: 'property', property: c }]
        : c && (c.type === 'property' || c.type === 'association') ? [c as Column] : []));
    } catch {
      return null;
    }
  }, [record.properties.member_columns]);

  useEffect(() => {
    api<{ results: AssociationLabel[] }>('GET', `/v1/association-labels?object=${schema.api_name}`).then((r) => setLabels(r.results)).catch(() => undefined);
  }, [schema.api_name]);

  useEffect(() => {
    // the Name column already shows first and last name
    const keep = (c: Column) => (c.type === 'property' ? !!byName.get(c.property) && !['name', 'first_name', 'last_name'].includes(c.property) : !!objectByName.get(c.object));
    if (ownColumns) { setColumns(ownColumns.filter(keep)); return; }
    api<{ results: View[] }>('GET', `/v1/ui/views?object=${schema.api_name}`)
      .then((r) => r.results[0]?.columns ?? [])
      .catch(() => [] as Column[])
      .then((cols) => setColumns(cols.filter(keep).slice(0, 5).map((c) => (c.type === 'property' ? { type: 'property', property: c.property } : { type: 'association', object: c.object, label_id: c.label_id }))));
  }, [schema, ownColumns, byName, objectByName]);

  async function saveColumns(cols: Column[]) {
    const chosen = cols.filter((c) => !(c.type === 'property' && c.property === 'name'))
      .map((c) => (c.type === 'property' ? { type: 'property', property: c.property } : { type: 'association', object: c.object, label_id: c.label_id }));
    try {
      onChanged(await api<CrmRecord>('PATCH', `/v1/objects/lists/${record.id}`, { properties: { member_columns: JSON.stringify(chosen) } }));
      setPicking(false);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const header = (c: Column) => {
    if (c.type === 'property') return byName.get(c.property)?.label ?? c.property;
    const other = objectByName.get(c.object);
    return other ? associationColumnLabel(c, other, labels, schema.api_name, objectByName) : c.object;
  };
  const cell = (r: Member, c: Column) => {
    if (c.type === 'property') {
      const pr = byName.get(c.property)!;
      return displayValue(pr, r.properties[c.property]) || <span className="muted">--</span>;
    }
    const items = (r.associations?.[c.object] ?? []).filter((a) => !c.label_id || a.labels.some((l) => l.label_id === c.label_id));
    if (!items.length) return <span className="muted">--</span>;
    return items.map((a, i) => (
      <span key={a.id}>{i > 0 && ', '}<Link to={`/objects/${c.object}/${a.id}`}>{displayName(a.properties, a.id)}</Link></span>
    ));
  };
  const colKey = (c: Column) => (c.type === 'property' ? `p:${c.property}` : `a:${c.object}:${c.label_id ?? ''}`);

  const load = useCallback(async (after?: string | null) => {
    if (!columns) return;
    try {
      const props = columns.flatMap((c) => (c.type === 'property' ? [c.property] : []));
      const objects = [...new Set(columns.flatMap((c) => (c.type === 'association' ? [c.object] : [])))];
      const q = new URLSearchParams({ properties: ['name', ...props].join(','), limit: '50' });
      if (objects.length) q.set('associations', objects.join(','));
      if (after) q.set('after', after);
      if (query.trim()) q.set('q', query.trim());
      const r = await api<{ total: number; results: Member[]; next: string | null }>('GET', `/v1/lists/${record.id}/records?${q}`);
      setRows((cur) => (after && cur ? [...cur, ...r.results] : r.results));
      setTotal(r.total);
      setNext(r.next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [record.id, columns, query]);
  useEffect(() => {
    const t = setTimeout(() => { load(); }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  async function afterChange() {
    setPicked(new Set());
    await load();
    onChanged(await api<CrmRecord>('GET', `/v1/objects/lists/${record.id}`));
  }

  async function remove() {
    const n = picked.size;
    const ok = await confirmDialog(
      `The ${n === 1 ? schema.label_singular.toLowerCase() : schema.label_plural.toLowerCase()} stay in the CRM; only the list changes.`,
      { title: `Remove ${n} from the list?`, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      const r = await api<{ removed: number }>('DELETE', `/v1/lists/${record.id}/members`, { ids: [...picked] });
      toast(`Removed ${r.removed.toLocaleString()} from the list.`);
      await afterChange();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const plural = schema.label_plural.toLowerCase();
  const allPicked = !!rows?.length && rows.every((r) => picked.has(r.id));

  return (
    <div className="list-members">
      <div className="list-members-bar">
        <div className="table-search list-search">
          <Search size={15} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${plural} in this list`} aria-label={`Search ${plural} in this list`} />
        </div>
        <span className="muted small">{rows ? `${total.toLocaleString()} ${total === 1 ? schema.label_singular.toLowerCase() : plural}${query.trim() ? ' found' : ''}` : ''}</span>
        <span className="list-bar-gap" />
        {editable && picked.size > 0 && <button className="btn small danger-text" onClick={remove}><Trash2 size={14} aria-hidden /> Remove {picked.size}</button>}
        {editable && !adding && <button className="btn small" onClick={() => setAdding(true)}><Plus size={14} aria-hidden /> Add {plural}</button>}
        {!archived && <button className="btn table-columns" onClick={() => setPicking(true)} disabled={!columns}><Columns3 size={16} aria-hidden /> Edit columns</button>}
      </div>
      {picking && columns && (
        <ColumnPicker schema={schema} labels={labels}
          columns={[{ type: 'property', property: 'name' }, ...columns]}
          onClose={() => setPicking(false)} onSave={saveColumns} />
      )}
      {adding && <AddRecords listId={record.id} schema={schema} onClose={() => setAdding(false)} onAdded={afterChange} />}
      {error ? <div className="error">{error}</div> : !rows || !columns ? <Loading /> : rows.length === 0 ? (
        <div className="list-empty">
          {query.trim() ? <p>No {plural} in this list match "{query.trim()}".</p>
            : dynamic ? <p>No {plural} match the filters yet. Change them on the left, or refresh if you just saved.</p>
            : <p>No {plural} yet. Use Add {plural}, fill the list from filters on the left, or tick rows in the {plural} table and choose Add to list.</p>}
        </div>
      ) : (
        <div className="list-table-wrap">
          <table className="list-table">
            <thead>
              <tr>
                {editable && (
                  <th className="list-pick">
                    <input type="checkbox" aria-label="Pick all shown" checked={allPicked}
                      onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                  </th>
                )}
                <th>Name</th>
                {columns.map((c) => <th key={colKey(c)}>{header(c)}</th>)}
                <th className="list-added">Added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={picked.has(r.id) ? 'picked' : undefined}>
                  {editable && (
                    <td className="list-pick">
                      <input type="checkbox" aria-label={`Pick ${String(r.properties.name ?? r.id)}`} checked={picked.has(r.id)}
                        onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                    </td>
                  )}
                  <td className="list-name"><Link to={`/objects/${schema.api_name}/${r.id}`}>{String(r.properties.name ?? '') || r.id}</Link></td>
                  {columns.map((c) => <td key={colKey(c)}>{cell(r, c)}</td>)}
                  <td className="list-added muted" title={when(r.added_at)}>{new Date(r.added_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <button className="btn small ghost list-more" onClick={() => load(next)}>Show more</button>}
    </div>
  );
}

// Finds records of the list's object and adds the ones picked.
function AddRecords({ listId, schema, onClose, onAdded }: { listId: string; schema: ObjectDef; onClose: () => void; onAdded: () => Promise<void> }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<CrmRecord[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<SearchResult>('QUERY', `/v1/objects/${schema.api_name}/search`, { query: q.trim() || undefined, limit: 10, properties: ['name'] })
        .then((r) => setFound(r.results))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, schema.api_name]);

  async function add(id: string) {
    setBusy(id);
    try {
      const r = await api<{ added: number }>('POST', `/v1/lists/${listId}/members`, { ids: [id] });
      toast(r.added ? 'Added to the list.' : 'Already in the list.');
      await onAdded();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="list-add">
      <div className="list-add-search">
        <Search size={15} aria-hidden />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${schema.label_plural.toLowerCase()} to add`} aria-label={`Find ${schema.label_plural.toLowerCase()} to add`} />
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      {found === null ? <Loading inline /> : found.length === 0 ? <p className="muted small">Nothing found.</p> : (
        <ul className="list-add-results">
          {found.map((r) => (
            <li key={r.id}>
              <span>{String(r.properties.name ?? '') || r.id}</span>
              <button className="btn small" disabled={busy === r.id} onClick={() => add(r.id)}><Plus size={14} aria-hidden /> Add</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The records linked to the list, as cards like a record page's right
// column: for now its email campaigns (only contact lists can be one's audience).
function AssociationsTab({ record, listObject }: { record: CrmRecord; listObject: string }) {
  const { objects } = useApp();
  const codeToName = useMemo(() => new Map(objects.map((o) => [o.object_type_id, o.api_name])), [objects]);
  const [associated, setAssociated] = useState<Associated[] | null>(null);
  const load = useCallback(async () => {
    setAssociated(await loadLinked('lists', record.id, codeToName));
  }, [record.id, codeToName]);
  useEffect(() => { load().catch(() => setAssociated([])); }, [load]);
  if (!associated) return <Loading />;
  return (
    <div className="list-assoc">
      {listObject !== 'contacts' && <p className="muted">Email campaigns send to contact lists, so this list can't be one's audience.</p>}
      {(listObject === 'contacts' || associated.some((a) => a.object === 'email_campaigns' && a.records.length)) && (
        <AssociationCard self="lists" selfId={record.id} selfRecord={record} other="email_campaigns"
          items={associated.find((a) => a.object === 'email_campaigns')?.records ?? []} lineCount={0} linked={associated} onChanged={load} />
      )}
    </div>
  );
}

// Who joined and left, laid out like a record's Changes: by day, a batch per
// refresh or per change by hand, with who made it.
function HistoryTab({ listId, object, noun }: { listId: string; object: string; noun: (n: number) => string }) {
  const [rows, setRows] = useState<Change[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (before?: number) => {
    try {
      const r = await api<{ results: Change[]; next_before: number | null }>('GET', `/v1/lists/${listId}/changes?limit=200${before ? `&before=${before}` : ''}`);
      setRows((cur) => (before && cur ? [...cur, ...r.results] : r.results));
      setNext(r.next_before);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [listId]);
  useEffect(() => { load(); }, [load]);
  if (error) return <div className="error">{error}</div>;
  if (!rows) return <Loading />;
  if (rows.length === 0) return <div className="list-empty"><p>No one has joined or left yet. Changes show here as the list refreshes or people add and remove records.</p></div>;

  // one batch per moment, way and person
  const batches: Change[][] = [];
  for (const c of rows) {
    const last = batches.at(-1)?.[0];
    if (last && last.at === c.at && last.source === c.source && last.changed_by === c.changed_by) batches.at(-1)!.push(c);
    else batches.push([c]);
  }
  return (
    <div className="timeline list-ledger">
      {byDay(batches, (b) => b[0].at).map(({ day, rows: dayBatches }) => (
        <LedgerDay key={day} day={day}>
          {dayBatches.map((batch) => {
            const h = batch[0];
            const person = h.changed_by_name ?? (h.changed_by ? 'Someone' : null);
            const joined = batch.filter((c) => c.change === 'added');
            const left = batch.filter((c) => c.change === 'removed');
            return (
              <div key={h.id} className="change-batch">
                <div className="change-batch-head">
                  <span className={`change-avatar${person ? '' : ' key'}`} aria-hidden="true">{person ? initials(person) : <RefreshCw size={13} />}</span>
                  <div className="change-meta">
                    <span className="change-actor">{person ?? 'Scheduled refresh'}</span>
                    <span className="change-tag">{h.source === 'refresh' ? 'Refresh' : person ? 'By hand' : 'Refresh'}</span>
                  </div>
                  <time className="ledger-time" dateTime={h.at}>{isoLocal(h.at)}</time>
                </div>
                <div className="change-batch-items">
                  {[{ list: joined, on: true }, { list: left, on: false }].filter((g) => g.list.length).map((g) => (
                    <div key={String(g.on)} className={`ledger-entry link-change${g.on ? '' : ' unlinked'}`}>
                      <span className="change-dot link-dot" aria-hidden="true">{g.on ? <UserPlus size={12} /> : <UserMinus size={12} />}</span>
                      <div className="change-body">
                        <strong className="change-what">{g.list.length.toLocaleString()} {noun(g.list.length)} {g.on ? 'joined' : 'left'}</strong>
                        <ul className="change-links">
                          {g.list.map((c) => (
                            <li key={c.id}><Link to={`/objects/${object}/${c.record_id}`}>{c.name || c.record_id}</Link></li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </LedgerDay>
      ))}
      {next && <button className="btn small ghost list-more" onClick={() => load(next)}>Show more</button>}
    </div>
  );
}

function SettingsTab({ record, listsSchema, schema, dynamic, archived, onChanged, onArchived }: {
  record: CrmRecord; listsSchema: ObjectDef; schema: ObjectDef; dynamic: boolean; archived: boolean; onChanged: (r: CrmRecord) => void; onArchived: () => void;
}) {
  const { toast } = useApp();
  const memberCount = Number(record.properties.member_count ?? 0);
  const plural = schema.label_plural.toLowerCase();
  const hasFilters = parseDefinitionText(record.properties.definition).groups.length > 0;

  async function switchType() {
    const ok = await confirmDialog(dynamic
      ? `It keeps its ${memberCount.toLocaleString()} ${plural} as they are now and stops refreshing. You can then add and remove records by hand. Its filters are kept, so you can make it dynamic again.`
      : hasFilters
        ? `Its members become the ${plural} its saved filters match, worked out within half a minute and kept up to date from then on. Records added by hand that don't match will leave.`
        : `It has no saved filters, so it will hold every one of your ${plural}, kept up to date.`,
    { title: dynamic ? 'Make this list static?' : 'Make this list dynamic?', confirmLabel: dynamic ? 'Make static' : 'Make dynamic' });
    if (!ok) return;
    try {
      onChanged(await api<CrmRecord>('PATCH', `/v1/objects/lists/${record.id}`, { properties: { list_type: dynamic ? 'static' : 'dynamic' } }));
      toast(dynamic ? 'The list is static now.' : 'The list is dynamic now. Its members are worked out within half a minute.');
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function archive() {
    if (!(await confirmDialog(`The ${plural} in it are not deleted, and campaigns stop sending to it. You can restore the list from the recycle bin.`, { title: 'Delete this list?', confirmLabel: 'Delete list', danger: true }))) return;
    await api('DELETE', `/v1/objects/lists/${record.id}`);
    toast('List deleted.');
    onArchived();
  }

  async function restore() {
    onChanged(await api<CrmRecord>('POST', `/v1/objects/lists/${record.id}/restore`));
    toast('Restored');
  }

  return (
    <div className="list-settings">
      {!archived && (
        <div className="list-setting-row">
          <button className="btn" onClick={switchType}>{dynamic ? 'Make static' : 'Make dynamic'}</button>
          <p className="muted small">
            {dynamic
              ? `Keeps the ${plural} it has now and changes only by hand. Its filters stay saved.`
              : 'Follows its filters again and refreshes on a schedule.'}
          </p>
        </div>
      )}
      <div className="list-props">
        <PropertyList schema={listsSchema} record={record} lock={null} onSaved={onChanged} />
      </div>
      <div className="list-setting-row">
        {archived ? (
          <button className="btn" onClick={restore}><RotateCcw size={14} aria-hidden /> Restore list</button>
        ) : (
          <button className="btn danger-text" onClick={archive}><Trash2 size={14} aria-hidden /> Delete list</button>
        )}
        <p className="muted small">The {plural} in it are not deleted.</p>
      </div>
    </div>
  );
}
