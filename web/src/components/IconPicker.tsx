import { useMemo, useState, type ReactNode } from 'react';
import { Modal } from './ui';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { DEFAULT_VIEW_ICON, ViewIcon, toPascal, useIcons } from '../lib/lucide-icons';

const SHOWN = 240;

// Pick any Lucide icon by searching its name. onPick(null) means the default.
export function IconPicker({ value, onPick, onClose }: { value: string | null; onPick: (name: string | null) => void; onClose: () => void }) {
  const { names, set } = useIcons();
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/[\s-]+/).filter(Boolean);
    return names.filter((n) => words.every((w) => n.includes(w)));
  }, [names, query]);

  return (
    <Modal
      title="Choose an icon"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => onPick(null)} disabled={!value}>Use the default</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
        </>
      }
    >
      <input autoFocus placeholder="Search icons, like chart, users, calendar" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: '100%' }} />
      <div className="muted small" style={{ margin: '8px 0' }}>
        {!names.length || !set ? 'Loading icons…' : `${matches.length} icon${matches.length === 1 ? '' : 's'}${matches.length > SHOWN ? `, first ${SHOWN} shown` : ''} from Lucide`}
      </div>
      {set && (
        <div className="icon-grid">
          {matches.slice(0, SHOWN).map((n) => {
            const Icon = set[toPascal(n)] ?? DEFAULT_VIEW_ICON;
            return (
              <button key={n} className={`icon-cell${n === value ? ' selected' : ''}`} title={n} onClick={() => onPick(n)}>
                <Icon size={22} strokeWidth={1.75} />
                <span>{n}</span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// A custom view's icon: the current name, open() to show the picker, and the
// picker itself to render. Picking saves at once (PATCH the views record).
export function useViewIconPicker(record: CrmRecord, onChanged: (r: CrmRecord) => void): {
  icon: string | null; open: () => void; picker: ReactNode; error: string | null;
} {
  const { toast, reloadCustomViews } = useApp();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const icon = (record.properties.icon as string | null) ?? null;

  async function save(name: string | null) {
    setPicking(false);
    setError(null);
    try {
      onChanged(await api<CrmRecord>('PATCH', `/v1/objects/views/${record.id}`, { properties: { icon: name } }));
      reloadCustomViews().catch(() => undefined);
      toast('Icon saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return {
    icon,
    open: () => setPicking(true),
    picker: picking ? <IconPicker value={icon} onPick={save} onClose={() => setPicking(false)} /> : null,
    error
  };
}

// The round avatar in a view's record header: its icon, and a button that
// opens the picker when the user may edit the view.
export function ViewIconAvatar({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { icon, open, picker, error } = useViewIconPicker(record, onChanged);
  const icon20 = <ViewIcon icon={icon} size={20} strokeWidth={1.75} />;
  if (record.can_edit === false) return <span className="record-avatar">{icon20}</span>;
  return (
    <>
      <button className="record-avatar record-avatar-btn" onClick={open} title={error ?? (icon ? `Icon: ${icon}. Click to change` : 'Choose an icon')} aria-label="Change the icon">
        {icon20}
      </button>
      {picker}
    </>
  );
}
