import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type CrmRecord, type FilterGroup, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { groupsDefinition } from '../lib/filters';
import { Modal } from './ui';
import { Select } from './Select';
import { Loading } from './Loading';

// Lists (api/src/lists): the table's ways in.
//   SaveAsListModal  the table's filters as a new list: dynamic (the filters,
//                    refreshed on a schedule) or static (who matches now)
//   AddToListModal   ticked rows (or every match) into a static list

export const REFRESH_OPTIONS = [
  { value: '15_minutes', label: 'Every 15 minutes' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'manual', label: 'Only when refreshed by hand' }
];

// What a table search is: its text query and finished filters (search form).
export interface TableSearch {
  query?: string;
  status?: string;
  filter_groups?: FilterGroup[];
}

export function SaveAsListModal({ object, plural, search, onClose }: {
  object: string; plural: string; search: TableSearch; onClose: () => void;
}) {
  const { toast } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [type, setType] = useState<'dynamic' | 'static'>('dynamic');
  const [schedule, setSchedule] = useState('hourly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = search.filter_groups ?? [];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const properties: Record<string, unknown> = { name: name.trim(), list_object: object, list_type: type };
      if (type === 'dynamic') {
        properties.refresh_schedule = schedule;
        // the table's logic: any group, every filter in it
        properties.definition = JSON.stringify(groupsDefinition('any', groups));
      }
      const list = await api<CrmRecord>('POST', '/v1/objects/lists', { properties });
      if (type === 'static') {
        const r = await api<{ added: number }>('POST', `/v1/lists/${list.id}/members`, { search: { query: search.query, status: search.status, filter_groups: groups.length ? groups : undefined } });
        toast(`List saved with ${r.added.toLocaleString()} ${plural.toLowerCase()}.`);
      } else {
        toast('List saved. Its members are worked out within half a minute.');
      }
      navigate(`/objects/lists/${list.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Save as list" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save list'}</button>
      </>}>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) save(); }} />
        </label>
        <label className="field">
          <span>Type</span>
          <Select value={type} onChange={(v) => setType(v === 'static' ? 'static' : 'dynamic')} aria-label="List type"
            options={[
              { value: 'dynamic', label: 'Dynamic: everyone these filters match, kept up to date' },
              { value: 'static', label: `Static: the ${plural.toLowerCase()} that match right now` }
            ]} />
        </label>
        {type === 'dynamic' && (
          <label className="field">
            <span>Refresh</span>
            <Select value={schedule} onChange={setSchedule} aria-label="Refresh schedule" options={REFRESH_OPTIONS} />
          </label>
        )}
        {type === 'dynamic' && search.query && (
          <p className="muted" style={{ margin: 0 }}>The search box text ("{search.query}") isn't saved with a dynamic list, only the filters.</p>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}

export function AddToListModal({ object, plural, target, onClose, onDone }: {
  object: string; plural: string; target: { ids: string[] } | { search: Record<string, unknown>; count: number }; onClose: () => void; onDone?: () => void;
}) {
  const { toast } = useApp();
  const [lists, setLists] = useState<{ value: string; label: string }[] | null>(null);
  const [listId, setListId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = 'ids' in target ? target.ids.length : target.count;

  useEffect(() => {
    api<SearchResult>('QUERY', '/v1/objects/lists/search', {
      limit: 200, properties: ['name', 'member_count'], sorts: [{ property: 'name', direction: 'asc' }],
      filter_groups: [{ filters: [
        { property: 'list_object', operator: 'in', values: [object] },
        { property: 'list_type', operator: 'in', values: ['static'] }
      ] }]
    })
      .then((r) => setLists(r.results.map((l) => ({ value: l.id, label: `${String(l.properties.name ?? 'Untitled list')} (${Number(l.properties.member_count ?? 0).toLocaleString()})` }))))
      .catch((e) => { setLists([]); setError((e as Error).message); });
  }, [object]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ added: number }>('POST', `/v1/lists/${listId}/members`, 'ids' in target ? { ids: target.ids } : { search: target.search });
      toast(r.added === count ? `Added ${r.added.toLocaleString()} to the list.` : `Added ${r.added.toLocaleString()}; the rest were already in it or out of reach.`);
      onDone?.();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Add ${count.toLocaleString()} ${count === 1 ? 'record' : plural.toLowerCase()} to a list`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={add} disabled={busy || !listId}>{busy ? 'Adding…' : 'Add'}</button>
      </>}>
      {lists === null ? <Loading /> : (
        <div className="form">
          {lists.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>There are no static lists of {plural.toLowerCase()} yet. Make one under Marketing → Lists, then come back.</p>
          ) : (
            <label className="field">
              <span>Static list</span>
              <Select value={listId} onChange={setListId} aria-label="List" search options={[{ value: '', label: 'Pick a list' }, ...lists]} />
            </label>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
