import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import type { AssociationLabel, Column, ObjectDef, ObjectSummary } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Modal } from './ui';

// Column header for an association column: "Companies" for every link to
// companies, or the label's name ("Primary company") for one label.
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

const key = (c: Column) => (c.type === 'property' ? `p:${c.property}` : `a:${c.object}:${c.label_id ?? ''}`);

export function ColumnPicker({ schema, labels, columns, onClose, onSave }: {
  schema: ObjectDef; labels: AssociationLabel[]; columns: Column[]; onClose: () => void; onSave: (c: Column[]) => void;
}) {
  const { objects, objectByName } = useApp();
  const [selected, setSelected] = useState<Column[]>(columns);
  const [filter, setFilter] = useState('');

  const available = useMemo(() => {
    const props: { column: Column; label: string; group: string }[] = schema.properties
      .filter((p) => p.row_status === 'active' && p.api_name !== 'object_type_id' && p.api_name !== 'merged_ids')
      .map((p) => ({ column: { type: 'property', property: p.api_name } as Column, label: p.label, group: 'Properties' }));
    const assoc: { column: Column; label: string; group: string }[] = [];
    for (const other of objects) {
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
  function move(i: number, d: -1 | 1) {
    setSelected((s) => {
      const next = [...s];
      const j = i + d;
      if (j < 0 || j >= next.length) return s;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  return (
    <Modal
      wide
      title="Edit columns"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(selected)} disabled={selected.length === 0}>Apply</button>
        </>
      }
    >
      <div className="columns-picker">
        <div className="picker-available">
          <input placeholder="Search properties and associations" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
          {['Properties', 'Associations'].map((group) => (
            <div key={group}>
              <div className="picker-group">{group}</div>
              {shown.filter((a) => a.group === group).map((a) => (
                <label key={key(a.column)} className="picker-row">
                  <input type="checkbox" checked={chosen.has(key(a.column))} onChange={() => toggle(a.column)} />
                  {a.label}
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="picker-selected">
          <div className="picker-group">Selected columns ({selected.length})</div>
          {selected.map((c, i) => (
            <div key={key(c)} className="picker-chip">
              <span>{labelOf(c)}</span>
              <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp size={14} /></button>
              <button className="icon-btn" onClick={() => move(i, 1)} disabled={i === selected.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
              <button className="icon-btn" onClick={() => toggle(c)} aria-label="Remove"><X size={14} /></button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
