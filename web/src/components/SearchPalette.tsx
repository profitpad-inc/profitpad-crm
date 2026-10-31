import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useApp } from '../lib/app-context';
import { api, getSchema, type SearchResult } from '../lib/api';
import { nameProperties, objectIcon, recordName } from '../lib/display';

// Searches the objects people look things up in most, five results each.
const SEARCHED = ['contacts', 'companies', 'deals', 'tickets', 'products', 'orders', 'invoices', 'quotes', 'services'];

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { objects, objectByName } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ object: string; result: SearchResult }[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const handle = setTimeout(async () => {
      const searchable = [...SEARCHED.filter((o) => objectByName.has(o)), ...objects.filter((o) => o.kind === 'custom').map((o) => o.api_name)];
      const found = await Promise.all(
        searchable.map(async (object) => {
          try {
            const schema = await getSchema(object);
            const result = await api<SearchResult>('POST', `/v1/objects/${object}/search`, {
              query, limit: 5, properties: nameProperties(schema.properties)
            });
            return { object, result };
          } catch {
            return { object, result: { total: 0, results: [], next: null } };
          }
        })
      );
      if (!cancelled) {
        setResults(found.filter((f) => f.result.total > 0));
        setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, objects, objectByName]);

  function go(path: string) {
    onClose();
    navigate(path);
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={18} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search records" />
          <button className="palette-cancel" onClick={onClose}>Cancel</button>
        </div>
        <div className="palette-results">
          {q.trim().length < 2 && <div className="muted pad">Type at least 2 characters.</div>}
          {q.trim().length >= 2 && !busy && results.length === 0 && <div className="muted pad">No matches.</div>}
          {results.map(({ object, result }) => {
            const Icon = objectIcon(object);
            return (
              <div key={object} className="palette-group">
                <div className="palette-group-head">
                  {objectByName.get(object)?.label_plural} <span className="muted">{result.total}</span>
                </div>
                {result.results.map((r) => (
                  <button key={r.id} className="palette-row" onClick={() => go(`/objects/${object}/${r.id}`)}>
                    <Icon size={16} strokeWidth={1.75} />
                    <span>{recordName(r)}</span>
                  </button>
                ))}
                {result.total > result.results.length && (
                  <button className="palette-more" onClick={() => go(`/objects/${object}?q=${encodeURIComponent(q.trim())}`)}>
                    See all {result.total}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
