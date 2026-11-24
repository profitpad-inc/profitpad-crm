import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink, Search } from 'lucide-react';
import { api, type CrmRecord, type ObjectDef, type Property, type SearchResult } from '../lib/api';
import { displayName, displayValue, formatValue, initials, nameProperties, recordName } from '../lib/display';
import { isMultiType, primaryValue } from '../lib/multi-values';
import { Modal, isEditable } from './ui';
import { Loading } from './Loading';

// Merge two records, laid out like HubSpot's "Merge duplicate records": the
// open record and a picked one side by side, a radio on each card choosing the
// primary (the record that stays), a radio per property choosing which value
// the merged record keeps, and a preview of the result on the right. The API
// keeps the primary's value, else the other's; values picked from the other
// record over a filled primary value are sent as overrides.

type Side = 'a' | 'b';

const SUBTITLE_PROPS = ['email', 'domain', 'job_title'];

// Email and phone lists are combined by the database on a merge (the
// winner's entries, then the loser's, migration 0129), so they are not picked.

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function same(x: unknown, y: unknown): boolean {
  return JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
}

function subtitleOf(r: CrmRecord): string | undefined {
  const name = recordName(r);
  const s = SUBTITLE_PROPS.map((k) => (k === 'email' ? primaryValue(r.properties[k]) : r.properties[k])).find((v) => typeof v === 'string' && v) as string | undefined;
  return s && s !== name ? s : undefined;
}

export function MergeRecordsModal({ object, schema, record, onClose, onMerged }: {
  object: string;
  schema: ObjectDef;
  record: CrmRecord;
  onClose: () => void;
  onMerged: (merged: CrmRecord) => void;
}) {
  const [other, setOther] = useState<CrmRecord | null>(null);
  const [loadingOther, setLoadingOther] = useState(false);
  const [primary, setPrimary] = useState<Side>('a');
  const [choice, setChoice] = useState<Record<string, Side>>({});
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [explain, setExplain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createdProp = schema.properties.find((p) => p.api_name === 'created_at');
  // what can be picked: the editable properties (calculations, files and system ones follow the primary)
  const props = useMemo(
    () => schema.properties.filter((p) => isEditable(p) && p.api_name !== 'created_at' && !isMultiType(p)),
    [schema, object]
  );
  const sides = { a: record, b: other };
  const winner = primary === 'a' ? record : other;
  const loser = primary === 'a' ? other : record;

  // each property starts on the primary's value, else the other's
  useEffect(() => {
    if (!other) return;
    const next: Record<string, Side> = {};
    const otherSide: Side = primary === 'a' ? 'b' : 'a';
    for (const p of props) {
      const pv = (primary === 'a' ? record : other).properties[p.api_name];
      next[p.api_name] = isEmpty(pv) ? otherSide : primary;
    }
    setChoice(next);
  }, [primary, other, record, props]);

  async function pick(id: string) {
    setLoadingOther(true);
    setError(null);
    try {
      setOther(await api<CrmRecord>('GET', `/v1/objects/${object}/${id}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingOther(false);
    }
  }

  // rows: properties where either record has a value
  const rows = other ? props.filter((p) => {
    const a = record.properties[p.api_name];
    const b = other.properties[p.api_name];
    if (isEmpty(a) && isEmpty(b)) return false;
    return !onlyDiff || !same(a, b);
  }) : [];

  function valueOf(p: Property): unknown {
    const side = choice[p.api_name] ?? primary;
    return sides[side]?.properties[p.api_name];
  }

  async function merge() {
    if (!winner || !loser) return;
    const overrides: Record<string, unknown> = {};
    for (const p of props) {
      const side = choice[p.api_name];
      if (!side || side === primary) continue;
      const w = winner.properties[p.api_name];
      const l = loser.properties[p.api_name];
      // an empty primary value already takes the other's
      if (!isEmpty(w) && !isEmpty(l) && !same(w, l)) overrides[p.api_name] = l;
    }
    setBusy(true);
    setError(null);
    try {
      const merged = await api<CrmRecord>('POST', `/v1/objects/${object}/merge`, {
        winner_id: winner.id,
        loser_id: loser.id,
        ...(Object.keys(overrides).length ? { properties: overrides } : {})
      });
      onMerged(merged);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const singular = schema.label_singular.toLowerCase();
  const plural = schema.label_plural.toLowerCase();
  // the preview's name: a picked name, else the primary's (a calculated name is worked out after the merge)
  const nameProp = props.find((p) => p.api_name === 'name');
  let previewName = '';
  if (winner && nameProp) previewName = isEmpty(valueOf(nameProp)) ? recordName(winner) : String(valueOf(nameProp));
  else if (winner) {
    // a calculated name (contacts): the preferred name, else first and last, from the picked values
    const picked: Record<string, unknown> = {};
    for (const p of props) picked[p.api_name] = valueOf(p);
    const preferred = typeof picked.preferred_name === 'string' && picked.preferred_name.trim() ? picked.preferred_name.trim() : null;
    previewName = preferred ?? displayName(picked, winner.id);
  }
  const subValue = [primaryValue(winner?.properties.email) ?? primaryValue(loser?.properties.email), ...SUBTITLE_PROPS.map((k) => props.find((p) => p.api_name === k))
    .filter((p): p is Property => !!p).map((p) => valueOf(p))].find((v) => typeof v === 'string' && v);
  const previewSub = typeof subValue === 'string' && subValue !== previewName ? subValue : undefined;

  return (
    <Modal
      title="Merge duplicate records"
      onClose={onClose}
      locked={busy}
      className="merge-modal"
      footer={
        <>
          <button className="btn primary" disabled={!other || busy} onClick={() => void merge()}>{busy ? 'Merging…' : 'Merge'}</button>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="link-btn merge-explain-toggle" onClick={() => setExplain((v) => !v)}>
            What happens when I merge {plural}?
          </button>
        </>
      }
    >
      {explain && (
        <div className="merge-explain">
          The primary record stays and keeps its ID. The other {singular} is marked as merged into it: its links,
          activities and associations move to the primary, and opening its old ID opens the primary. Each property
          keeps the value you pick here; properties not listed keep the primary's value, else the other's.
          A merge can't be undone.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="merge-grid">
        <div className="merge-left">
          <div className="merge-cards">
            <div className="merge-col">
              <div className="merge-label">Select a record to merge</div>
              <RecordCard record={record} createdProp={createdProp} object={object} primary={primary === 'a'} onPrimary={() => setPrimary('a')} />
            </div>
            <div className="merge-col">
              <RecordPicker object={object} schema={schema} exclude={record.id} picked={other} onPick={(id) => void pick(id)} />
              {loadingOther
                ? <div className="merge-card empty"><Loading /></div>
                : other
                  ? <RecordCard record={other} createdProp={createdProp} object={object} primary={primary === 'b'} onPrimary={() => setPrimary('b')} />
                  : <div className="merge-card empty"><span className="muted">Pick the {singular} to merge with this one.</span></div>}
            </div>
          </div>

          {other && (
            <>
              <div className="merge-props-head">
                <div className="merge-label">Customize properties</div>
                <label className="merge-diff-switch">
                  <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
                  Only show differences
                </label>
              </div>
              {rows.length === 0 && <div className="muted merge-none">{onlyDiff ? 'No differences between these records.' : 'Neither record has values to pick from.'}</div>}
              <div className="merge-props">
                {rows.map((p) => (
                  <div className="merge-prop-row" key={p.api_name}>
                    {(['a', 'b'] as Side[]).map((side, i) => {
                      const v = sides[side]!.properties[p.api_name];
                      const empty = isEmpty(v);
                      const on = choice[p.api_name] === side;
                      return (
                        <div key={side} className="merge-prop-pair">
                          <label className={`merge-prop${on ? ' on' : ''}${empty ? ' empty' : ''}`}>
                            <input
                              type="radio"
                              name={`merge-${p.api_name}`}
                              checked={on}
                              disabled={empty}
                              onChange={() => setChoice((c) => ({ ...c, [p.api_name]: side }))}
                            />
                            <span className="merge-prop-text">
                              <span className="merge-prop-label">{p.label}</span>
                              <span className="merge-prop-value">{empty ? 'No value' : displayValue(p, v)}</span>
                            </span>
                          </label>
                          {i === 0 && <span className="merge-prop-arrow" aria-hidden><ChevronRight size={12} /></span>}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <span className="merge-arrow" aria-hidden><ArrowRight size={28} strokeWidth={1.5} /></span>

        <div className="merge-right">
          <div className="merge-label">View merged record preview</div>
          <div className="merge-preview">
            {winner && other ? (
              <>
                <div className="merge-preview-id">
                  <span className="record-avatar">{initials(previewName)}</span>
                  <div>
                    <div className="merge-preview-name">{previewName}</div>
                    {previewSub && <div className="muted">{previewSub}</div>}
                  </div>
                </div>
                {createdProp && (
                  <div className="merge-preview-field">
                    <div className="merge-prop-label">{createdProp.label}</div>
                    <div>{formatValue(createdProp, winner.properties.created_at) || '--'}</div>
                  </div>
                )}
                <div className="merge-preview-title">Properties</div>
                {rows.length === 0 && <div className="muted">Nothing to show.</div>}
                {rows.map((p) => {
                  const v = valueOf(p);
                  return (
                    <div className="merge-preview-field" key={p.api_name}>
                      <div className="merge-prop-label">{p.label}</div>
                      <div>{isEmpty(v) ? <span className="merge-no-value">No value</span> : displayValue(p, v)}</div>
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="muted">The merged {singular} shows here once you pick a record to merge.</div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RecordCard({ record, createdProp, object, primary, onPrimary }: {
  record: CrmRecord; createdProp?: Property; object: string; primary: boolean; onPrimary: () => void;
}) {
  const name = recordName(record);
  const sub = subtitleOf(record);
  return (
    <label className={`merge-card${primary ? ' on' : ''}`}>
      <input type="radio" name="merge-primary" checked={primary} onChange={onPrimary} aria-label={`Keep ${name} as the primary record`} />
      <div className="merge-card-body">
        <div className="merge-card-id">
          <span className="record-avatar small">{initials(name)}</span>
          <div className="merge-card-names">
            <div className="merge-card-name" title={name}>{name}</div>
            {sub && <div className="muted merge-card-sub" title={sub}>{sub}</div>}
          </div>
        </div>
        <a className="merge-view-link" href={`/objects/${object}/${record.id}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          View record <ExternalLink size={13} />
        </a>
        {createdProp && (
          <div className="merge-card-created">
            <div className="merge-prop-label">{createdProp.label}</div>
            <div>{formatValue(createdProp, record.properties.created_at) || '--'}</div>
          </div>
        )}
        {primary && <span className="merge-primary-tag">Primary</span>}
      </div>
    </label>
  );
}

// "Select a record": a menu-style search box over this object's records
function RecordPicker({ object, schema, exclude, picked, onPick }: {
  object: string; schema: ObjectDef; exclude: string; picked: CrmRecord | null; onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CrmRecord[] | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const props = useMemo(() => [...new Set([...nameProperties(schema.properties), ...SUBTITLE_PROPS.filter((k) => schema.properties.some((p) => p.api_name === k))])], [schema]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResults(null);
    const t = window.setTimeout(() => {
      api<SearchResult>('POST', `/v1/objects/${object}/search`, { query: q.trim() || undefined, limit: 11, properties: props })
        .then((res) => { if (!cancelled) setResults(res.results.filter((r) => r.id !== exclude).slice(0, 10)); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [open, q, object, exclude, props]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  return (
    <div className="merge-picker" ref={boxRef}>
      <button type="button" className="merge-picker-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={picked ? '' : 'muted'}>{picked ? recordName(picked) : 'Select a record'}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="merge-picker-pop">
          <div className="merge-picker-search">
            <Search size={14} />
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${schema.label_plural.toLowerCase()}`} />
          </div>
          <div className="merge-picker-list">
            {results === null
              ? <Loading />
              : results.length === 0
                ? <div className="muted merge-picker-none">No matches</div>
                : results.map((r) => {
                  const sub = subtitleOf(r);
                  return (
                    <button type="button" key={r.id} className="merge-picker-item" onClick={() => { setOpen(false); onPick(r.id); }}>
                      <span className="merge-picker-name">{recordName(r)}</span>
                      {sub && <span className="muted merge-picker-sub">{sub}</span>}
                    </button>
                  );
                })}
          </div>
        </div>
      )}
    </div>
  );
}
