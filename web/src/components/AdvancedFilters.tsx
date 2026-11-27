import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Boxes, Calendar, CalendarClock, ChevronLeft, ChevronRight, Copy, Hash, Link2, ListChecks, Mail, Paperclip, Phone, Plus, Search, SlidersHorizontal, Trash2, Type, X } from 'lucide-react';
import { Select } from './Select';
import { DatePicker } from './DatePicker';
import {
  FIELD_TYPE_LABELS, MAX_FILTERS, MAX_GROUPS, compareKey, compareKind, compareOperatorsFor, daysSuffix, filterComplete, filterKey, filterParts, newFilter,
  operatorOf, operatorsFor, withCompare, withOperator, withProperty, type Filter, type FilterField, type FilterFieldType, type FilterGroup
} from '../lib/filters';
import '../advanced-filters.css';

// Filters like HubSpot's ("Filters" in the UI): groups of conditions ("Group 1", "Group 2"),
// AND inside a group, OR between groups. "+ Add filter" opens a property
// picker (search, field type); each condition has its property, its operator
// and the value, plus a case-sensitivity switch on text (off: ignores case).
//
// Controlled: groups in, onChange out, half-made conditions included (use
// completeGroups / toSearchGroups from lib/filters before searching). Used by
// the object tables (pages/ObjectTable.tsx) and by custom views
// (view-runtime/kit.tsx, kit: inputs get the frame's classes).
//
// Lists (pages/ListPage.tsx) pass match, which flips the logic ("all":
// AND between groups, OR inside) and shows a menu to choose it, and
// allowCompare, which lets a condition compare with another property (of the
// record or of its linked records) instead of a value.

const TYPE_ICONS: Record<FilterFieldType, typeof Type> = {
  text: Type, number: Hash, date: Calendar, datetime: CalendarClock, dropdown: ListChecks, email: Mail, phone: Phone, other: Paperclip
};

export interface AdvancedFiltersProps {
  fields: FilterField[];
  groups: FilterGroup[];
  onChange: (groups: FilterGroup[]) => void;
  // the picker's search box: "Search deal properties"
  searchPlaceholder?: string;
  // the record's own object, singular ("Deal"): with fields of associated
  // objects (FilterField.group), the picker gets an object menu, "Deal
  // properties", "Company properties", ...
  objectLabel?: string;
  // the picker opened (load associated objects' fields lazily)
  onPickerOpen?: () => void;
  // associated objects' fields are still coming
  fieldsLoading?: boolean;
  // an object's own icon (the CRM's objectIcon), for the associated objects list
  objectIcon?: (object: string) => ObjectIconType;
  // associated objects listed first, in this order (api names); the rest follow alphabetically
  pinnedObjects?: string[];
  // association labels between the record's object and another one, named
  // from the record's side ("Primary company"); with any, a condition on that
  // object gets a label menu ("Any label" first), which sets association.label_id
  associationLabels?: (object: string) => { value: string; label: string }[];
  // inside a custom view's frame
  kit?: boolean;
  // lists: how groups combine, with a menu to change it (see the header)
  match?: 'all' | 'any';
  onMatchChange?: (m: 'all' | 'any') => void;
  // lists: conditions may compare with another property
  allowCompare?: boolean;
  maxGroups?: number;
  maxFilters?: number;
  // the name of the record a condition picks by its Record ID ("Associated deal:
  // Record ID is 0000000012", from a record page's linked records card), once
  // known: the condition then reads "Associated deal: Acme renewal"
  recordName?: (f: Filter) => string | undefined;
}

export function AdvancedFilters({
  fields, groups, onChange, searchPlaceholder = 'Search properties', objectLabel, onPickerOpen, fieldsLoading, objectIcon, pinnedObjects, associationLabels, kit,
  match, onMatchChange, allowCompare, maxGroups = MAX_GROUPS, maxFilters = MAX_FILTERS, recordName
}: AdvancedFiltersProps) {
  const between = match === 'all' ? 'and' : 'or';
  const inside = match === 'all' ? 'or' : 'and';
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const picker = { fields, placeholder: searchPlaceholder, objectLabel, onOpen: onPickerOpen, loading: fieldsLoading, objectIcon, pinnedObjects };
  const cls = { input: kit ? 'v-input' : undefined, select: kit ? 'v-input v-select' : undefined };

  function setGroup(gi: number, g: FilterGroup | null) {
    const next = groups.slice();
    if (g && g.filters.length > 0) next[gi] = g;
    else next.splice(gi, 1);
    onChange(next);
    if (!g || g.filters.length === 0) setActive(null);
  }

  // The group being edited shows its filters' menus and boxes; the others
  // read as sentences ("Stage is any of Won or Lost") until clicked. A group
  // with a half-made filter stays open. Clicking outside the filters (menus
  // and pickers drawn on <body> count as inside) closes them all.
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.isConnected || rootRef.current?.contains(t)) return;
      if (t.closest?.('.select-menu, .af-picker, .flatpickr-calendar, .overlay, .menu')) return;
      setActive(null);
    };
    // capture: decided before the group's own handler redraws it (the
    // clicked sentence is replaced by the editors and leaves the page)
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []);
  const open = (gi: number, g: FilterGroup) => active === gi || g.filters.some((f) => !filterComplete(f, byKey.get(filterKey(f))));

  return (
    <div className="af" ref={rootRef}>
      {match && onMatchChange && (
        <div className="af-match">
          <span>Records must match</span>
          <Select className={cls.select} value={match} aria-label="How groups combine" onChange={(v) => onMatchChange(v === 'any' ? 'any' : 'all')}
            options={[{ value: 'all', label: 'every group' }, { value: 'any', label: 'any group' }]} />
          <span className="af-muted">{match === 'all' ? 'A group matches when any of its filters does.' : 'A group matches when all of its filters do.'}</span>
        </div>
      )}
      {groups.map((g, gi) => (
        <div key={gi} className="af-group-wrap">
          {gi > 0 && <div className="af-or"><span>{between}</span></div>}
          <section className={`af-group${open(gi, g) ? ' open' : ' closed'}`} aria-label={`Group ${gi + 1}`}
            onMouseDown={() => setActive(gi)} onFocus={() => setActive(gi)}>
            <header className="af-group-head">
              <h3>Group {gi + 1}</h3>
              <div className="af-group-actions">
                <button type="button" className="af-icon" aria-label={`Duplicate group ${gi + 1}`} title="Duplicate group"
                  disabled={groups.length >= maxGroups}
                  onClick={() => onChange([...groups.slice(0, gi + 1), structuredClone(g), ...groups.slice(gi + 1)])}>
                  <Copy size={15} />
                </button>
                <button type="button" className="af-icon" aria-label={`Delete group ${gi + 1}`} title="Delete group" onClick={() => setGroup(gi, null)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </header>
            {g.filters.map((f, fi) => (
              <div key={fi}>
                {fi > 0 && <div className="af-and">{inside}</div>}
                {!open(gi, g) ? (
                  <ConditionSummary fields={fields} field={byKey.get(filterKey(f))} filter={f} named={recordName?.(f)}
                    label={f.association?.label_id ? associationLabels?.(f.association.object).find((l) => l.value === f.association!.label_id)?.label : undefined}
                    onRemove={() => setGroup(gi, { filters: g.filters.filter((_, j) => j !== fi) })} />
                ) : <Condition
                  allowCompare={allowCompare}
                  fields={fields}
                  field={byKey.get(filterKey(f))}
                  filter={f}
                  named={recordName?.(f)}
                  cls={cls}
                  labels={f.association ? associationLabels?.(f.association.object) : undefined}
                  onChange={(nf) => setGroup(gi, { filters: g.filters.map((x, j) => (j === fi ? nf : x)) })}
                  onRemove={() => setGroup(gi, { filters: g.filters.filter((_, j) => j !== fi) })}
                />}
              </div>
            ))}
            {g.filters.length < maxFilters && (
              <AddFilterButton {...picker} label="Add filter" small
                onPick={(field) => { setGroup(gi, { filters: [...g.filters, newFilter(field)] }); setActive(gi); }} />
            )}
          </section>
        </div>
      ))}
      {groups.length === 0 ? (
        <AddFilterButton {...picker} label="Add filter"
          onPick={(field) => { onChange([{ filters: [newFilter(field)] }]); setActive(0); }} />
      ) : groups.length < maxGroups && (
        <>
          <div className="af-or"><span>{between}</span></div>
          <AddFilterButton {...picker} label="Add filter group"
            onPick={(field) => { onChange([...groups, { filters: [newFilter(field)] }]); setActive(groups.length); }} />
        </>
      )}
    </div>
  );
}

// A filter of a group not being edited: one line that reads as a sentence,
// the property and the value in bold. Clicking it opens the group.
function ConditionSummary({ fields, field, filter, label, named, onRemove }: {
  fields: FilterField[]; field: FilterField | undefined; filter: Filter; label?: string; named?: string; onRemove: () => void;
}) {
  const { subject, verb, value } = filterParts(filter, field, fields);
  const linked = filter.association && !field?.count
    ? `Associated ${(field?.group ?? filter.association.object).toLowerCase()}${label ? ` (${label})` : ''}: ` : '';
  return (
    <div className={`af-cond af-summary${field ? '' : ' missing'}`}>
      <span className="af-sentence">
        {linked && <span className="af-muted-inline">{linked}</span>}
        {named ? <strong>{named}</strong> : <><strong>{subject}</strong> {verb}{value && <> <strong>{value}</strong></>}</>}
      </span>
      <button type="button" className="af-icon af-remove" aria-label="Remove filter" title="Remove filter"
        onMouseDown={(e) => e.stopPropagation()} onClick={onRemove}>
        <X size={16} />
      </button>
    </div>
  );
}

function Condition({ fields, field, filter, named, cls, labels, onChange, onRemove, allowCompare }: {
  fields: FilterField[]; field: FilterField | undefined; filter: Filter; named?: string; cls: { input?: string; select?: string };
  labels?: { value: string; label: string }[]; onChange: (f: Filter) => void; onRemove: () => void; allowCompare?: boolean;
}) {
  const comparing = !!filter.compare_to;
  const canCompare = !!allowCompare && !!field && compareKind(field) !== null;
  const ops = field ? (comparing ? compareOperatorsFor(field) : operatorsFor(field)) : [];
  const op = operatorOf(field, filter.operator, comparing);
  const key = filterKey(filter);
  // the property menu lists the same object's properties (the picker switches objects)
  const group = field?.group ?? (filter.association ? filter.association.object : undefined);
  const options = fields.filter((x) => x.group === group).map((x) => ({ value: x.key, label: x.label }));
  if (!field) options.unshift({ value: key, label: `${filter.property} (not available)` });
  // "Any label" plus the pair's labels; a saved label that is gone still shows
  const labelId = filter.association?.label_id ?? '';
  const labelOptions = filter.association && (labels?.length || labelId) ? [
    { value: '', label: 'Any label' },
    ...(labels ?? []),
    ...(labelId && !labels?.some((l) => l.value === labelId) ? [{ value: labelId, label: 'Label (not available)' }] : [])
  ] : null;
  const labelMenu = labelOptions && filter.association && (
    <Select className={cls.select} value={labelId} aria-label="Association label"
      onChange={(v) => {
        const { label_id: _drop, ...rest } = filter.association!;
        onChange({ ...filter, association: v ? { ...rest, label_id: v } : rest });
      }}
      options={labelOptions} />
  );

  return (
    <div className={`af-cond${field ? '' : ' missing'}`}>
      <div className="af-cond-fields">
        {filter.association && !field?.count && <div className="af-cond-object">Associated {(field?.group ?? filter.association.object).toLowerCase()}{named && <>: <strong>{named}</strong></>}</div>}
        {!field?.count && labelMenu}
        <Select className={cls.select} value={key} aria-label="Property"
          onChange={(v) => {
            const nf = fields.find((x) => x.key === v);
            if (!nf) return;
            // a comparison stays one while the new property can compare
            if (comparing && allowCompare && compareKind(nf) !== null) {
              const next = withCompare(nf, newFilter(nf), true);
              const target = fields.find((x) => x.key === compareKey(filter.compare_to!));
              const keep = target && compareKind(target) === compareKind(nf);
              onChange(keep ? { ...next, compare_to: filter.compare_to } : next);
            } else {
              onChange(withProperty(field, nf, filter));
            }
          }}
          options={options} />
        {field?.count && labelMenu}
        {field && (
          <Select className={cls.select} value={filter.operator} aria-label="Condition" search
            onChange={(v) => onChange(comparing ? { ...filter, operator: v } : withOperator(field, filter, v))}
            options={ops.map((o) => ({ value: o.value, label: o.label }))} />
        )}
        {canCompare && (
          <Select className={cls.select} value={comparing ? 'property' : 'value'} aria-label="Compare with"
            onChange={(v) => onChange(withCompare(field!, filter, v === 'property'))}
            options={[{ value: 'value', label: 'a value' }, { value: 'property', label: 'another property' }]} />
        )}
        {field && comparing && <CompareEditor fields={fields} field={field} filter={filter} cls={cls} onChange={onChange} />}
        {field && op && !comparing && <ValueEditor field={field} filter={filter} input={op.input} cls={cls} onChange={onChange} />}
        {op?.text && (
          <label className="af-case">
            <input type="checkbox" checked={filter.case_sensitive === true} onChange={(e) => onChange({ ...filter, case_sensitive: e.target.checked })} />
            Case sensitive
          </label>
        )}
      </div>
      <button type="button" className="af-icon af-remove" aria-label="Remove filter" title="Remove filter" onClick={onRemove}>
        <X size={16} />
      </button>
    </div>
  );
}

// The other side of a comparison: a property of the same kind, of the record
// itself or of its linked records (a condition already on linked records:
// the record's own properties, or another property of that linked record),
// and, when linked records are involved, whether any or every one must meet it.
function CompareEditor({ fields, field, filter, cls, onChange }: {
  fields: FilterField[]; field: FilterField; filter: Filter; cls: { input?: string; select?: string }; onChange: (f: Filter) => void;
}) {
  const kind = compareKind(field);
  const to = filter.compare_to!;
  const ownObject = filter.association?.object;
  const targets = fields.filter((x) => x.key !== filterKey(filter) && compareKind(x) === kind
    && (!x.association || !ownObject || x.association.object === ownObject));
  const key = to.property ? compareKey(to) : '';
  const options = [
    { value: '', label: 'Pick a property' },
    ...targets.map((x) => ({ value: x.key, label: x.group ? `${x.group}: ${x.label}` : x.label })),
    ...(key && !targets.some((x) => x.key === key) ? [{ value: key, label: `${to.property} (not available)` }] : [])
  ];
  const linked = filter.association?.object ?? to.association?.object;
  const linkedGroup = linked ? (fields.find((x) => x.association?.object === linked)?.group ?? linked).toLowerCase() : '';
  return (
    <>
      <Select className={cls.select} value={key} aria-label="Compared with" search
        onChange={(v) => {
          const t = fields.find((x) => x.key === v);
          if (!t) return;
          const next = t.association
            ? { property: t.property ?? t.key, association: { object: t.association.object }, quantifier: to.quantifier ?? 'any' as const }
            : { property: t.key, ...(filter.association ? { quantifier: to.quantifier ?? 'any' as const } : {}) };
          onChange({ ...filter, compare_to: next });
        }}
        options={options} />
      {linked && to.property && (
        <Select className={cls.select} value={to.quantifier ?? 'any'} aria-label="How many linked records"
          onChange={(v) => onChange({ ...filter, compare_to: { ...to, quantifier: v === 'all' ? 'all' : 'any' } })}
          options={[{ value: 'any', label: `for any associated ${linkedGroup}` }, { value: 'all', label: `for every associated ${linkedGroup}` }]} />
      )}
    </>
  );
}

// A typed value applies when the box loses focus or on Enter, not on every
// keystroke, so the table doesn't search again for each letter.
function DraftInput({ value, onCommit, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string; onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <input {...rest} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  );
}

function ValueEditor({ field, filter, input, cls, onChange }: {
  field: FilterField; filter: Filter; input: string; cls: { input?: string; select?: string }; onChange: (f: Filter) => void;
}) {
  const isDate = field.type === 'date' || field.type === 'datetime';
  const numberish = field.type === 'number';

  const box = (value: unknown, set: (v: unknown) => void, label: string) => isDate ? (
    <DatePicker value={value ? String(value).slice(0, 10) : ''} onChange={(v) => set(v || undefined)} ariaLabel={label} inputClassName={cls.input} />
  ) : (
    <DraftInput className={cls.input} type={numberish ? 'number' : 'text'} aria-label={label} placeholder={numberish ? 'Number' : 'Value'}
      value={value === undefined || value === null ? '' : String(value)}
      onCommit={(v) => set(v === '' ? undefined : numberish ? Number(v) : v)} />
  );

  switch (input) {
    case 'single':
      return box(filter.value, (v) => onChange({ ...filter, value: v }), 'Value');
    case 'range': {
      const [lo, hi] = filter.values ?? [];
      const set = (i: number) => (v: unknown) => {
        const next = [lo ?? null, hi ?? null];
        next[i] = v ?? null;
        onChange({ ...filter, values: next });
      };
      return (
        <div className="af-range">
          {box(lo, set(0), 'From')}
          <span className="af-muted">and</span>
          {box(hi, set(1), 'To')}
        </div>
      );
    }
    case 'days':
      return (
        <div className="af-days">
          <DraftInput className={cls.input} type="number" min={0} step={1} aria-label="Days" placeholder="Days"
            value={filter.value === undefined || filter.value === null ? '' : String(filter.value)}
            onCommit={(v) => onChange({ ...filter, value: v === '' ? undefined : Math.max(0, Math.floor(Number(v))) })} />
          <span className="af-muted">{daysSuffix(filter.operator)}</span>
        </div>
      );
    case 'text_list':
      return <TextList values={(filter.values ?? []).map(String)} cls={cls} onChange={(values) => onChange({ ...filter, values })} />;
    case 'number_list':
      return <TextList numbers values={(filter.values ?? []).map(String)} cls={cls} onChange={(values) => onChange({ ...filter, values: values.map(Number) })} />;
    case 'option_list': {
      const values = (filter.values ?? []).map(String);
      const label = (v: string) => field.options?.find((o) => o.value === v)?.label ?? v;
      const remaining = (field.options ?? []).filter((o) => !values.includes(o.value));
      return (
        <div className="af-chips">
          {values.map((v) => (
            <span key={v} className="af-chip">
              {label(v)}
              <button type="button" aria-label={`Remove ${label(v)}`} onClick={() => onChange({ ...filter, values: values.filter((x) => x !== v) })}><X size={12} /></button>
            </span>
          ))}
          {remaining.length > 0 && (
            <Select className={cls.select} value="" aria-label="Add a value" search onChange={(v) => v && onChange({ ...filter, values: [...values, v] })}
              options={[{ value: '', label: values.length ? 'Add another value' : 'Pick values' }, ...remaining]} />
          )}
        </div>
      );
    }
    default:
      return null;
  }
}

// Free-text values as chips: Enter, comma or leaving the box adds one.
// numbers: only numbers are added ("1,500" and "$1500" count as 1500).
function TextList({ values, cls, onChange, numbers }: { values: string[]; cls: { input?: string }; onChange: (v: string[]) => void; numbers?: boolean }) {
  const [draft, setDraft] = useState('');
  function add() {
    let v = draft.trim();
    if (numbers) {
      const n = Number(v.replace(/[$,\s]/g, ''));
      v = v && Number.isFinite(n) ? String(n) : '';
    }
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  }
  return (
    <div className="af-chips">
      {values.map((v) => (
        <span key={v} className="af-chip">
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><X size={12} /></button>
        </span>
      ))}
      <input className={cls.input} aria-label="Add a value" inputMode={numbers ? 'decimal' : undefined}
        placeholder={values.length ? 'Add another value' : numbers ? 'Type a number, then Enter' : 'Type a value, then Enter'}
        value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || (e.key === ',' && !numbers)) {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }} />
    </div>
  );
}

type ObjectIconType = ComponentType<{ size?: number | string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

interface PickerSource {
  fields: FilterField[]; placeholder: string; objectLabel?: string; onOpen?: () => void; loading?: boolean;
  objectIcon?: (object: string) => ObjectIconType;
  pinnedObjects?: string[];
}

function AddFilterButton({ label, small, onPick, ...source }: PickerSource & { label: string; small?: boolean; onPick: (field: FilterField) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" className={`af-add${small ? ' small' : ''}`} aria-expanded={anchor !== null}
        onClick={() => {
          if (!anchor) source.onOpen?.();
          setAnchor(anchor ? null : ref.current!.getBoundingClientRect());
        }}>
        <Plus size={14} /> {label}
      </button>
      {anchor && (
        <PropertyPicker anchor={anchor} button={ref.current} {...source}
          onClose={() => setAnchor(null)} onPick={(f) => { setAnchor(null); onPick(f); }} />
      )}
    </>
  );
}

const ALL = '';

// The property picker: two tabs, the record's own properties and
// "Associated objects" (a row per linked object that opens its properties,
// with a way back). Typing searches every object at once, grouped under each
// object's name.
type PickerRow =
  | { kind: 'header'; label: string }
  | { kind: 'field'; field: FilterField }
  | { kind: 'object'; group: string }
  | { kind: 'loading' };

function PropertyPicker({ anchor, button, fields: allFields, placeholder: basePlaceholder, objectLabel, loading, objectIcon, pinnedObjects = [], onClose, onPick }: PickerSource & {
  anchor: DOMRect; button: HTMLElement | null; onClose: () => void; onPick: (f: FilterField) => void;
}) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState(ALL);
  // '' is the record's own properties, else the associated object (its group) being looked at
  const [object, setObject] = useState('');
  const [tab, setTab] = useState<'own' | 'linked'>('own');
  // pinned objects first (contacts, companies, deals in the CRM), then the rest alphabetically
  const groupObject = new Map(allFields.flatMap((f) => (f.group && f.association ? [[f.group, f.association.object] as const] : [])));
  const pinRank = (g: string) => {
    const i = pinnedObjects.indexOf(groupObject.get(g) ?? '');
    return i < 0 ? pinnedObjects.length : i;
  };
  // the list shows (and sorts and searches) each object's plural name
  const pluralOf = new Map(allFields.flatMap((f) => (f.group ? [[f.group, f.groupPlural ?? f.group] as const] : [])));
  const plural = (g: string) => pluralOf.get(g) ?? g;
  const objectGroups = [...new Set(allFields.flatMap((f) => (f.group ? [f.group] : [])))]
    .sort((a, b) => pinRank(a) - pinRank(b) || plural(a).localeCompare(plural(b)));
  const hasLinked = !!objectLabel && (objectGroups.length > 0 || !!loading);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number }>({ top: anchor.bottom + 6, left: anchor.left, maxHeight: 420 });
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const matches = (f: FilterField) => (type === ALL || f.type === type) && (!q || f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q));
  // the fields in view, and the only ones a search looks through: the
  // associated object opened, else the record's own (the Associated objects
  // tab searches the objects' names)
  const scope = object ? allFields.filter((f) => f.group === object) : tab === 'own' ? allFields.filter((f) => !f.group) : [];
  const types = [...new Set(scope.map((f) => f.type))].sort((a, b) => FIELD_TYPE_LABELS[a].localeCompare(FIELD_TYPE_LABELS[b]));

  const rows: PickerRow[] = [];
  if (object) {
    for (const f of scope) if (matches(f)) rows.push({ kind: 'field', field: f });
  } else if (tab === 'own' || !hasLinked) {
    for (const f of scope) if (matches(f)) rows.push({ kind: 'field', field: f });
  } else {
    const objects = objectGroups.filter((g) => !q || plural(g).toLowerCase().includes(q) || g.toLowerCase().includes(q));
    for (const g of objects) rows.push({ kind: 'object', group: g });
    if (loading && !q) rows.push({ kind: 'loading' });
  }
  const pickable = rows.flatMap((r, i) => (r.kind === 'field' || r.kind === 'object' ? [i] : []));
  const placeholder = object ? `Search ${object.toLowerCase()} properties`
    : hasLinked ? (tab === 'linked' ? 'Search associated objects' : `Search ${objectLabel!.toLowerCase()} properties`) : basePlaceholder;
  // a linked object's icon, from its api name (fields carry it), else a generic one
  const iconFor = (group: string): ObjectIconType => {
    const name = allFields.find((f) => f.group === group)?.association?.object;
    return (name && objectIcon?.(name)) || Boxes;
  };
  const showTabs = hasLinked && !object;

  function open(group: string) {
    // back from an object returns to the list of objects
    if (!group && object) setTab('linked');
    setObject(group);
    setQuery('');
    setType(ALL);
    inputRef.current?.focus();
  }
  function choose(row: PickerRow | undefined) {
    if (row?.kind === 'field') onPick(row.field);
    else if (row?.kind === 'object') open(row.group);
  }

  // below the button, or above it when there is no room; kept on screen
  useLayoutEffect(() => {
    const width = popRef.current?.offsetWidth ?? 360;
    const below = window.innerHeight - anchor.bottom - 16;
    const above = anchor.top - 16;
    const up = below < 280 && above > below;
    const maxHeight = Math.min(460, up ? above : below);
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const height = Math.min(popRef.current?.scrollHeight ?? maxHeight, maxHeight);
    setPos({ top: up ? anchor.top - 6 - height : anchor.bottom + 6, left, maxHeight });
  }, [anchor, rows.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || button?.contains(t)) return;
      // the type menu is drawn on <body> too
      if ((t as Element).closest?.('.select-menu')) return;
      onClose();
    };
    const onScroll = (e: Event) => !popRef.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.select-menu') && onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [button, onClose]);

  // active is a position in pickable (rows that can be chosen)
  useEffect(() => setActive(0), [query, type, object, tab]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${pickable[active]}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div ref={popRef} className="af-picker" role="dialog" aria-label="Pick a property" style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
          button?.focus();
        }
      }}>
      <div className="af-picker-search">
        <input ref={inputRef} autoFocus value={query} placeholder={placeholder} aria-label={placeholder} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, pickable.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && pickable.length) { e.preventDefault(); choose(rows[pickable[active]]); }
            else if (e.key === 'Backspace' && !query && object) { e.preventDefault(); open(''); }
          }} />
        <Search size={15} aria-hidden />
      </div>
      {showTabs && (
        <div className="af-picker-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'own'} className={tab === 'own' ? 'on' : undefined} onClick={() => { setTab('own'); inputRef.current?.focus(); }}>
            {objectLabel} properties
          </button>
          <button type="button" role="tab" aria-selected={tab === 'linked'} className={tab === 'linked' ? 'on' : undefined} onClick={() => { setTab('linked'); setType(ALL); inputRef.current?.focus(); }}>
            Associated objects
          </button>
        </div>
      )}
      {object && (
        <div className="af-picker-crumb">
          <button type="button" className="af-picker-back" onClick={() => open('')}>
            <ChevronLeft size={15} aria-hidden /> Associated objects
          </button>
          <span className="af-picker-crumb-title">{object} properties</span>
        </div>
      )}
      {types.length > 1 && !(showTabs && tab === 'linked') && (
        <div className="af-picker-type">
          <SlidersHorizontal size={14} aria-hidden />
          <Select className="af-picker-type-select" value={type} aria-label="Field type" onChange={setType}
            face={type === ALL ? 'All field types' : FIELD_TYPE_LABELS[type as FilterFieldType]}
            options={[{ value: ALL, label: 'All field types' }, ...types.map((t) => ({ value: t, label: FIELD_TYPE_LABELS[t] }))]} />
        </div>
      )}
      <div ref={listRef} className="af-picker-list" role="listbox" aria-label="Properties">
        {rows.map((r, i) => {
          if (r.kind === 'header') return <div key={`h-${r.label}`} className="af-picker-heading" role="presentation">{r.label}</div>;
          if (r.kind === 'loading') return <p key="loading" className="af-muted af-picker-none">Loading associated objects…</p>;
          const at = pickable.indexOf(i);
          const on = at === active;
          if (r.kind === 'object') {
            const ObjIcon = iconFor(r.group);
            return (
              <button key={`o-${r.group}`} type="button" role="option" aria-selected={on} data-i={i} className={`af-picker-object${on ? ' active' : ''}`}
                onMouseEnter={() => setActive(at)} onClick={() => open(r.group)}>
                <ObjIcon size={15} aria-hidden />
                <span>{highlight(plural(r.group), q)}</span>
                <ChevronRight size={15} aria-hidden className="af-picker-chevron" />
              </button>
            );
          }
          const f = r.field;
          const Icon = f.count ? Link2 : TYPE_ICONS[f.type];
          return (
            <button key={f.key} type="button" role="option" aria-selected={on} data-i={i}
              className={on ? 'active' : undefined} title={f.description || undefined}
              onMouseEnter={() => setActive(at)} onClick={() => onPick(f)}>
              <Icon size={15} aria-hidden />
              <span>{highlight(f.label, q)}</span>
            </button>
          );
        })}
        {pickable.length === 0 && !(loading && !q && !object) && (
          <p className="af-muted af-picker-none">{!object && tab === 'linked' && hasLinked ? 'No associated objects match.' : 'No properties match.'}</p>
        )}
      </div>
    </div>,
    document.body
  );
}

function highlight(label: string, q: string): ReactNode {
  const at = q ? label.toLowerCase().indexOf(q) : -1;
  if (at < 0) return label;
  return <>{label.slice(0, at)}<mark>{label.slice(at, at + q.length)}</mark>{label.slice(at + q.length)}</>;
}
