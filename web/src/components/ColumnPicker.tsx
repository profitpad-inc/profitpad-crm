import { useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, GripVertical, Search, X } from 'lucide-react';
import type { AssociationLabel, Column, ObjectDef, ObjectSummary } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Modal } from './ui';

// Column header for an association column: "Companies" for every link to
// companies, or the label's name ("Billing company") for one label.
export function associationColumnLabel(
  c: { object: string; label_id: string | null }, other: ObjectSummary, labels: AssociationLabel[], self: string,
  objectByName: Map<string, ObjectSummary>
): string {
  if (!c.label_id) return other.label_plural;
  const l = labels.find((x) => x.id === c.label_id);
  if (!l) return other.label_plural;
  const selfCode = objectByName.get(self)?.object_type_id;
  if (l.from_object_type === l.to_object_type) return [l.label, l.inverse_label].filter(Boolean).join(' / ');
  return (l.from_object_type === selfCode ? l.label : l.inverse_label ?? l.label) ?? other.label_plural;
}

// Moves the item at `from` so it lands before the item now at `to`
// (to = list.length puts it last).
export function moveTo<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, item);
  return next;
}

const key = (c: Column) => (c.type === 'property' ? `p:${c.property}` : `a:${c.object}:${c.label_id ?? ''}`);

export function ColumnPicker({ schema, labels, columns, onClose, onSave }: {
  schema: ObjectDef; labels: AssociationLabel[]; columns: Column[]; onClose: () => void; onSave: (c: Column[]) => void;
}) {
  const { objects, objectByName } = useApp();
  const [selected, setSelected] = useState<Column[]>(columns);
  const [filter, setFilter] = useState('');
  const dragFrom = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const available = useMemo(() => {
    const props: { column: Column; label: string; group: string }[] = schema.properties
      .filter((p) => p.record_status === 'active' && p.api_name !== 'object_type_id' && p.api_name !== 'merged_ids')
      .map((p) => ({ column: { type: 'property', property: p.api_name } as Column, label: p.label, group: 'Properties' }));
    const assoc: { column: Column; label: string; group: string }[] = [];
    for (const other of objects) {
      if (!schema.links_to.includes(other.api_name)) continue;
      assoc.push({ column: { type: 'association', object: other.api_name, label_id: null }, label: `${other.label_plural} (all)`, group: 'Associations' });
      for (const l of labels) {
        if (l.is_default) continue;
        const pair = [l.from_object_type, l.to_object_type];
        if (!pair.includes(other.object_type_id) || !pair.includes(schema.object_type_id)) continue;
        if (other.object_type_id === schema.object_type_id && l.from_object_type !== l.to_object_type) continue;
        const c: Column = { type: 'association', object: other.api_name, label_id: l.id };
        assoc.push({ column: c, label: `${other.label_plural}: ${associationColumnLabel(c, other, labels, schema.api_name, objectByName)}`, group: 'Associations' });
      }
    }
    return [...props, ...assoc];
  }, [schema, labels, objects, objectByName]);

  const chosen = new Set(selected.map(key));
  const labelOf = (c: Column) => available.find((a) => key(a.column) === key(c))?.label ?? key(c);
  const shown = available.filter((a) => a.label.toLowerCase().includes(filter.toLowerCase()));

  function toggle(c: Column) {
    setSelected((s) => (chosen.has(key(c)) ? s.filter((x) => key(x) !== key(c)) : [...s, c]));
  }
  function drop() {
    const from = dragFrom.current;
    if (from !== null && dropAt !== null) setSelected((s) => moveTo(s, from, dropAt));
    dragFrom.current = null;
    setDropAt(null);
  }

  return (
    <Modal
      wide
      className="colpick-modal"
      title="Edit columns"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(selected)} disabled={selected.length === 0}>Apply</button>
        </>
      }
    >
      <div className="colpick">
        <section className="colpick-pane" aria-label="Available columns">
          <div className="colpick-search">
            <Search size={15} aria-hidden />
            <input placeholder="Search properties and associations" aria-label="Search properties and associations" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
          </div>
          <div className="colpick-scroll">
            {['Properties', 'Associations'].map((group) => {
              const rows = shown.filter((a) => a.group === group);
              if (rows.length === 0) return null;
              return (
                <div key={group}>
                  <div className="colpick-group">{group}</div>
                  {rows.map((a) => (
                    <label key={key(a.column)} className="colpick-row">
                      <input type="checkbox" checked={chosen.has(key(a.column))} onChange={() => toggle(a.column)} />
                      <span>{a.label}</span>
                    </label>
                  ))}
                </div>
              );
            })}
            {shown.length === 0 && <p className="colpick-none">Nothing matches "{filter}". Try part of the name.</p>}
          </div>
        </section>
        <section className="colpick-pane chosen" aria-label="Shown columns">
          <div className="colpick-head">
            <span>Shown columns</span>
            <span className="muted">{selected.length}</span>
          </div>
          <p className="colpick-hint">Drag to reorder. The first column links to the record and stays in view when the table scrolls sideways.</p>
          <div className="colpick-scroll colpick-list">
            {selected.length === 0 && <p className="colpick-none">Tick at least one column on the left.</p>}
            {selected.map((c, i) => (
              <div
                key={key(c)}
                className={`colpick-chip${dropAt === i ? ' drop-before' : ''}${dropAt === selected.length && i === selected.length - 1 ? ' drop-after' : ''}`}
                onDragOver={(e) => {
                  if (dragFrom.current === null) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
                }}
                onDrop={(e) => { e.preventDefault(); drop(); }}
              >
                <span
                  className="colpick-grip"
                  draggable
                  title="Drag to reorder"
                  onDragStart={(e) => {
                    dragFrom.current = i;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setDragImage(e.currentTarget.parentElement!, 12, 12);
                  }}
                  onDragEnd={() => { dragFrom.current = null; setDropAt(null); }}
                >
                  <GripVertical size={14} />
                </span>
                <span className="colpick-chip-label">{labelOf(c)}</span>
                <span className="colpick-chip-actions">
                  <button className="icon-btn" onClick={() => setSelected((s) => moveTo(s, i, 0))} disabled={i === 0} aria-label="Move to top" title="Move to top"><ArrowUpToLine size={14} /></button>
                  <button className="icon-btn" onClick={() => setSelected((s) => moveTo(s, i, s.length))} disabled={i === selected.length - 1} aria-label="Move to bottom" title="Move to bottom"><ArrowDownToLine size={14} /></button>
                  <button className="icon-btn" onClick={() => toggle(c)} aria-label="Remove" title="Remove"><X size={14} /></button>
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}
