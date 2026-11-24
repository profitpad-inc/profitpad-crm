import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, MoreHorizontal, Plus, Tags } from 'lucide-react';
import { api, clearSchemaCache, type AssociationLabel, type ObjectSummary } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Menu } from '../components/ui';
import { Select } from '../components/Select';
import { confirmDialog } from '../components/confirm';
import { SaveHint } from '../components/SaveHint';
import { useDirty } from '../lib/use-dirty';
import { EditPanel, EmptyState, SettingsPage, StatusPill, TableSkeleton } from '../components/settings';

// Settings -> Association labels: names for the links between records
// ("Billing company" on a contact, "Billing contact" on the company). Made
// with meta.create_association_label, changed and archived with
// meta.update_association_label (migration 0126). Built-in labels and the
// plain link between two objects are listed elsewhere or not at all.
// Records get labels from the tag button on their association cards.

interface Draft {
  editing: AssociationLabel | null;
  from: string;
  to: string;
  label: string;
  inverse: string;
  symmetric: boolean;
  maxTo: string;
  maxFrom: string;
}

const emptyDraft = (from = ''): Draft => ({ editing: null, from, to: '', label: '', inverse: '', symmetric: false, maxTo: '', maxFrom: '' });

// '' is no limit; anything else must be a whole number of 1 or more
const limitValue = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const limitOk = (v: string) => v.trim() === '' || (Number.isInteger(Number(v)) && Number(v) >= 1);

export function AssociationLabelSettings() {
  const { objects, objectByName, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const filter = params.get('object') ?? '';
  const [labels, setLabels] = useState<AssociationLabel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const byCode = useMemo(() => new Map(objects.map((o) => [o.object_type_id, o])), [objects]);
  // objects people can link by hand, and what each may be linked to
  const linkable = useMemo(
    () => objects.filter((o) => o.links_to.some((t) => !o.system_links.includes(t))).sort((a, b) => a.label_plural.localeCompare(b.label_plural)),
    [objects]
  );
  const targets = (from: ObjectSummary | undefined) => (from
    ? from.links_to.filter((t) => !from.system_links.includes(t)).map((t) => objectByName.get(t)).filter((o): o is ObjectSummary => !!o)
      .sort((a, b) => a.label_plural.localeCompare(b.label_plural))
    : []);

  const load = () => api<{ results: AssociationLabel[] }>('GET', '/v1/association-labels?include_archived=true')
    .then((r) => { setLabels(r.results.filter((l) => !l.is_default)); setError(null); })
    .catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function act(fn: () => Promise<unknown>, message: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      clearSchemaCache();
      setDraft(null);
      toast(message);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(d: Draft) {
    const label = d.label.trim();
    const inverse = d.symmetric ? null : d.inverse.trim() || null;
    if (d.editing) {
      const l = d.editing;
      await act(() => api('PATCH', `/v1/association-labels/${l.id}`, {
        label, ...(l.is_symmetric ? {} : { inverse_label: inverse }),
        max_to_per_from: limitValue(d.maxTo), max_from_per_to: l.is_symmetric ? limitValue(d.maxTo) : limitValue(d.maxFrom)
      }), `${label} saved`);
    } else {
      await act(() => api('POST', '/v1/association-labels', {
        from_object: d.from, to_object: d.to, label, inverse_label: inverse ?? undefined, is_symmetric: d.symmetric,
        max_to_per_from: limitValue(d.maxTo) ?? undefined,
        max_from_per_to: (d.symmetric ? limitValue(d.maxTo) : limitValue(d.maxFrom)) ?? undefined
      }), `${label} created`);
    }
  }

  async function setStatus(l: AssociationLabel, status: 'active' | 'archived') {
    if (status === 'archived') {
      const used = l.link_count ?? 0;
      const ok = await confirmDialog(
        `${used ? `The ${used === 1 ? 'link that has it keeps' : `${used} links that have it keep`} it, ` : ''}but it can't be put on new links until it's restored.`,
        { title: `Archive ${l.label}?`, confirmLabel: 'Archive' });
      if (!ok) return;
    }
    await act(() => api('PATCH', `/v1/association-labels/${l.id}`, { record_status: status }),
      `${l.label} ${status === 'archived' ? 'archived' : 'restored'}`);
  }

  const edit = (l: AssociationLabel): Draft => ({
    editing: l, from: byCode.get(l.from_object_type)?.api_name ?? '', to: byCode.get(l.to_object_type)?.api_name ?? '',
    label: l.label ?? '', inverse: l.inverse_label ?? '', symmetric: l.is_symmetric,
    maxTo: l.max_to_per_from?.toString() ?? '', maxFrom: l.max_from_per_to?.toString() ?? ''
  });

  const filterCode = filter ? objectByName.get(filter)?.object_type_id : null;
  const shown = (labels ?? [])
    .filter((l) => !filterCode || l.from_object_type === filterCode || l.to_object_type === filterCode)
    .sort((a, b) => (a.record_status === b.record_status ? 0 : a.record_status === 'archived' ? 1 : -1)
      || pairName(a).localeCompare(pairName(b)) || (a.label ?? '').localeCompare(b.label ?? ''));
  function pairName(l: AssociationLabel) {
    return `${byCode.get(l.from_object_type)?.label_plural ?? ''} ${byCode.get(l.to_object_type)?.label_plural ?? ''}`;
  }

  const d = draft;
  const fromObj = d ? objectByName.get(d.from) : undefined;
  const toObj = d ? objectByName.get(d.to) : undefined;
  const same = !!d && !!d.from && d.from === d.to;
  const one = (o: ObjectSummary | undefined, fallback: string) => (o?.label_singular ?? fallback).toLowerCase();
  const many = (o: ObjectSummary | undefined, fallback: string) => (o?.label_plural ?? fallback).toLowerCase();
  const canSave = !!d && !!d.from && !!d.to && d.label.trim().length > 0 && limitOk(d.maxTo) && (d.symmetric || limitOk(d.maxFrom));
  const { dirty } = useDirty(d, d ? d.editing?.id ?? 'new' : null);

  return (
    <SettingsPage
      className="wide"
      title="Association labels"
      description={<>
        Labels say how two linked records relate, like a contact's <em>billing company</em> or a deal's <em>decision maker</em>.
        A label can read differently from each side (a company's <em>billing contact</em>). Put them on links from the tag button on
        a record's association cards, or pick them while associating. Records stay linked when their labels are taken off.
      </>}
      actions={!d && <button className="btn primary" onClick={() => setDraft(emptyDraft(filter))}><Plus size={14} /> New label</button>}
    >
      {error && <div className="error">{error}</div>}
      {d && (
        <EditPanel
          title={d.editing ? `Edit ${d.editing.label}` : 'New association label'}
          onSubmit={() => save(d)}
          footer={<>
            <SaveHint missing={[!d.from && 'an object', !d.to && 'the other object', !d.label.trim() && 'a label', !(limitOk(d.maxTo) && (d.symmetric || limitOk(d.maxFrom))) && 'limits that are whole numbers of 1 or more']} />
            <button className="btn" type="button" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
            <button className="btn primary" type="submit" disabled={busy || !canSave || (!!d.editing && !dirty)}>{d.editing ? 'Save' : 'Create label'}</button>
          </>}
        >
          {d.editing ? (
            <p className="muted small">
              Between {many(fromObj, 'records')} and {many(toObj, 'records')}. The objects of a label can't be changed; make a new one instead.
            </p>
          ) : (
            <div className="field-row">
              <label className="field">
                <span>From object</span>
                <Select value={d.from} onChange={(v) => setDraft({ ...d, from: v, to: '', symmetric: false })} search>
                  <option value="">Pick an object</option>
                  {linkable.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
                </Select>
              </label>
              <label className="field">
                <span>To object</span>
                <Select value={d.to} onChange={(v) => setDraft({ ...d, to: v, symmetric: false })} disabled={!d.from} search>
                  <option value="">{d.from ? 'Pick an object' : 'Pick the first object'}</option>
                  {targets(fromObj).map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
                </Select>
              </label>
            </div>
          )}
          {same && !d.editing && (
            <label className="check">
              <input type="checkbox" checked={d.symmetric} onChange={(e) => setDraft({ ...d, symmetric: e.target.checked, inverse: '', maxFrom: '' })} />
              Reads the same both ways (like <em>spouse</em> or <em>partner</em>)
            </label>
          )}
          <label>
            {d.symmetric
              ? `Label (what the ${one(toObj, 'records')}s are to each other)`
              : `Label (what a ${one(toObj, 'linked record')} is to a ${one(fromObj, 'record')})`}
            <input value={d.label} maxLength={63} required autoFocus placeholder={same ? 'Manager' : 'Billing company'}
              onChange={(e) => setDraft({ ...d, label: e.target.value })} />
          </label>
          {!d.symmetric && (
            <label>
              Label from the other side (what a {one(fromObj, 'record')} is to a {one(toObj, 'linked record')}, optional)
              <input value={d.inverse} maxLength={63} placeholder={same ? 'Report' : 'Billing contact'}
                onChange={(e) => setDraft({ ...d, inverse: e.target.value })} />
            </label>
          )}
          <div className="field-row">
            <label className="field">
              <span>{d.symmetric ? `Most per ${one(fromObj, 'record')}` : `Most ${many(toObj, 'records')} per ${one(fromObj, 'record')}`}</span>
              <input type="number" min={1} step={1} value={d.maxTo} placeholder="No limit" onChange={(e) => setDraft({ ...d, maxTo: e.target.value })} />
            </label>
            {!d.symmetric && (
              <label className="field">
                <span>Most {many(fromObj, 'records')} per {one(toObj, 'record')}</span>
                <input type="number" min={1} step={1} value={d.maxFrom} placeholder="No limit" onChange={(e) => setDraft({ ...d, maxFrom: e.target.value })} />
              </label>
            )}
          </div>
        </EditPanel>
      )}
      {labels && labels.length > 0 && (
        <div className="label-settings-filter">
          <Select value={filter} search aria-label="Filter by object"
            onChange={(v) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set('object', v); else n.delete('object'); return n; }, { replace: true })}>
            <option value="">All objects</option>
            {linkable.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
          </Select>
        </div>
      )}
      {!labels && !error && <TableSkeleton rows={3} />}
      {labels && labels.length === 0 && !d && (
        <EmptyState icon={<Tags size={18} />} title="No association labels yet"
          action={<button className="btn primary" onClick={() => setDraft(emptyDraft(filter))}>New label</button>}>
          Create one to say how linked records relate, like a contact's billing company.
        </EmptyState>
      )}
      {labels && labels.length > 0 && shown.length === 0 && (
        <p className="muted small">No labels for {objectByName.get(filter)?.label_plural.toLowerCase() ?? 'this object'} yet.</p>
      )}
      {shown.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>Objects</th><th>Label</th><th>Limits</th><th>Links</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const from = byCode.get(l.from_object_type);
                const to = byCode.get(l.to_object_type);
                const native = l.category === 'native';
                const limits = [
                  l.max_to_per_from && `${l.max_to_per_from} ${(l.max_to_per_from === 1 ? to?.label_singular : to?.label_plural)?.toLowerCase() ?? ''} per ${from?.label_singular.toLowerCase() ?? ''}`,
                  !l.is_symmetric && l.max_from_per_to && `${l.max_from_per_to} ${(l.max_from_per_to === 1 ? from?.label_singular : from?.label_plural)?.toLowerCase() ?? ''} per ${to?.label_singular.toLowerCase() ?? ''}`
                ].filter(Boolean);
                return (
                  <tr key={l.id} className={l.record_status === 'archived' ? 'muted' : undefined}>
                    <td className="wrap">
                      <span className="label-pair">{from?.label_plural ?? l.from_object_type}<ArrowLeftRight size={12} aria-label="and" />{to?.label_plural ?? l.to_object_type}</span>
                    </td>
                    <td className="primary-cell wrap">
                      {l.label}
                      {native && <> <StatusPill tone="info">Built-in</StatusPill></>}
                      {l.record_status === 'archived' && <> <StatusPill tone="off">Archived</StatusPill></>}
                      <span className="sub">
                        {l.is_symmetric ? 'Same both ways'
                          : l.inverse_label ? <>From the {to?.label_singular.toLowerCase() ?? 'other'} side: {l.inverse_label}</>
                          : 'Same name from both sides'}
                      </span>
                    </td>
                    <td className="wrap">{limits.length ? limits.join(', ') : <span className="muted small">None</span>}</td>
                    <td>{l.link_count ?? 0}</td>
                    <td className="row-actions">
                      {!native && (
                        <Menu align="right" trigger={(open) => <button className="icon-btn" onClick={open} aria-label={`Actions for ${l.label}`}><MoreHorizontal size={16} /></button>}>
                          {(close) => (
                            <>
                              {l.record_status === 'active' && <button onClick={() => { close(); setError(null); setDraft(edit(l)); }}>Edit</button>}
                              {l.record_status === 'active'
                                ? <button onClick={() => { close(); void setStatus(l, 'archived'); }}>Archive</button>
                                : <button onClick={() => { close(); void setStatus(l, 'active'); }}>Restore</button>}
                            </>
                          )}
                        </Menu>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SettingsPage>
  );
}
