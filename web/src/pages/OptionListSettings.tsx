import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ListChecks, MoreHorizontal, Plus, X } from 'lucide-react';
import { api, clearSchemaCache, getSchema, type OptionList, type Property } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Menu } from '../components/ui';
import { Select } from '../components/Select';
import { confirmDialog } from '../components/confirm';
import { EditPanel, EmptyState, SettingsPage, TableSkeleton } from '../components/settings';

// Settings → Option lists: dropdowns on any objects that share one set of
// choices (api/src/option-lists.ts, migration 0097). The database keeps the
// linked dropdowns' choices the same; choices are edited on any linked
// dropdown in Settings → Properties.

interface Dropdown { object: string; property: string }

type Draft =
  | { kind: 'new'; label: string; description: string; dropdowns: Dropdown[] }
  | { kind: 'edit'; list: OptionList; label: string; description: string }
  | { kind: 'link'; list: OptionList; dropdown: Dropdown };

const MAX_CHOICES_SHOWN = 10;

// dropdowns that can join a list: not user pickers, not some money property's currency
function linkable(props: Property[]): Property[] {
  const currencies = new Set(props.map((p) => p.options.currency_property).filter((v): v is string => typeof v === 'string'));
  return props.filter((p) => p.type === 'dropdown' && p.record_status === 'active' && !p.options.auto_append_users && !currencies.has(p.api_name));
}

// object and property pickers for one dropdown; leaves out ones already on a list
function DropdownPicker({ value, onChange, taken, label }: {
  value: Dropdown; onChange: (d: Dropdown) => void; taken: Set<string>; label: string;
}) {
  const { objects } = useApp();
  const [props, setProps] = useState<Property[] | null>(null);
  const sorted = useMemo(() => [...objects].sort((a, b) => a.label_plural.localeCompare(b.label_plural)), [objects]);
  useEffect(() => {
    if (!value.object) { setProps(null); return; }
    let live = true;
    setProps(null);
    getSchema(value.object).then((s) => { if (live) setProps(s.properties); }).catch(() => { if (live) setProps([]); });
    return () => { live = false; };
  }, [value.object]);
  const choices = linkable(props ?? []).filter((p) => !p.option_list && !taken.has(`${value.object}.${p.api_name}`))
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <div className="field-row">
      <label className="field">
        <span>{label}: object</span>
        <Select value={value.object} onChange={(v) => onChange({ object: v, property: '' })}>
          <option value="">Pick an object</option>
          {sorted.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_plural}</option>)}
        </Select>
      </label>
      <label className="field">
        <span>Dropdown</span>
        <Select value={value.property} onChange={(v) => onChange({ ...value, property: v })} disabled={!value.object || !props} loading={!!value.object && !props}>
          <option value="">{!value.object ? 'Pick an object first' : choices.length ? 'Pick a dropdown' : 'No dropdowns to link'}</option>
          {choices.map((p) => <option key={p.api_name} value={p.api_name}>{p.label}</option>)}
        </Select>
      </label>
    </div>
  );
}

export function OptionListSettings() {
  const { toast } = useApp();
  const navigate = useNavigate();
  const [lists, setLists] = useState<OptionList[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ option_lists: OptionList[] }>('GET', '/v1/option-lists')
    .then((r) => { setLists(r.option_lists); setError(null); })
    .catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      clearSchemaCache();
      setDraft(null);
      toast(message);
      await load();
    } catch (e) {
      setError((e as Error).message);
      // a link may have failed after others went through
      clearSchemaCache();
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function save(d: Draft) {
    if (d.kind === 'new') {
      const dropdowns = d.dropdowns.filter((x) => x.object && x.property);
      await act(() => api('POST', '/v1/option-lists', { label: d.label.trim(), description: d.description.trim() || undefined, dropdowns }), `${d.label.trim()} created`);
    } else if (d.kind === 'edit') {
      await act(() => api('PATCH', `/v1/option-lists/${d.list.id}`, { label: d.label.trim(), description: d.description.trim() }), `${d.label.trim()} saved`);
    } else {
      await act(() => api('POST', `/v1/option-lists/${d.list.id}/dropdowns`, d.dropdown), 'Dropdown linked');
    }
  }

  async function unlink(l: OptionList, m: OptionList['members'][number]) {
    const ok = await confirmDialog(
      `${m.object_label} · ${m.property_label} keeps the choices it has now, and later changes to the list no longer reach it.`,
      { title: `Unlink ${m.property_label} from ${l.label}?`, confirmLabel: 'Unlink' });
    if (!ok) return;
    await act(() => api('DELETE', `/v1/option-lists/${l.id}/dropdowns/${encodeURIComponent(m.object)}/${encodeURIComponent(m.property)}`), `${m.property_label} unlinked`);
  }

  async function remove(l: OptionList) {
    const ok = await confirmDialog(
      `Its ${l.members.length === 1 ? 'dropdown keeps' : `${l.members.length} dropdowns keep`} the choices they have now, but stop sharing them.`,
      { title: `Delete ${l.label}?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await act(() => api('DELETE', `/v1/option-lists/${l.id}`), `${l.label} deleted`);
  }

  // dropdowns picked in the new list form, so one is not offered twice
  const pickedKeys = (d: Draft | null, skip: number) => new Set(
    d?.kind === 'new' ? d.dropdowns.filter((_, i) => i !== skip).filter((x) => x.property).map((x) => `${x.object}.${x.property}`) : []);
  const newDraft = (): Draft => ({ kind: 'new', label: '', description: '', dropdowns: [{ object: '', property: '' }] });
  const d = draft;

  return (
    <SettingsPage
      className="wide"
      title="Option lists"
      description={<>
        An option list gives dropdowns on different objects the same choices, like one list of product categories for deals, products and partnerships.
        Adding, renaming, recolouring, reordering, archiving or removing a choice on any linked dropdown (under Properties) does the same on all of them.
        Stage details (chance of winning, which pipeline a stage belongs to) stay with each dropdown.
      </>}
      actions={!d && <button className="btn primary" onClick={() => setDraft(newDraft())}><Plus size={14} /> New option list</button>}
    >
      {error && <div className="error">{error}</div>}
      {d && (
        <EditPanel
          title={d.kind === 'new' ? 'New option list' : d.kind === 'edit' ? `Edit ${d.list.label}` : `Link a dropdown to ${d.list.label}`}
          onSubmit={() => save(d)}
          footer={<>
            <button className="btn" type="button" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
            <button className="btn primary" type="submit"
              disabled={busy || (d.kind === 'link' ? !d.dropdown.property : !d.label.trim())}>
              {d.kind === 'new' ? 'Create list' : d.kind === 'edit' ? 'Save' : 'Link dropdown'}
            </button>
          </>}
        >
          {d.kind !== 'link' && (
            <>
              <label>Name
                <input value={d.label} maxLength={63} required placeholder="Product categories" autoFocus
                  onChange={(e) => setDraft({ ...d, label: e.target.value })} />
              </label>
              <label>Description (optional)
                <input value={d.description} maxLength={2000} onChange={(e) => setDraft({ ...d, description: e.target.value })} />
              </label>
            </>
          )}
          {d.kind === 'new' && (
            <>
              {d.dropdowns.map((x, i) => (
                <div key={i} className="option-list-pick">
                  <DropdownPicker value={x} label={i === 0 ? 'First dropdown' : `Dropdown ${i + 1}`} taken={pickedKeys(d, i)}
                    onChange={(v) => setDraft({ ...d, dropdowns: d.dropdowns.map((y, j) => (j === i ? v : y)) })} />
                  {d.dropdowns.length > 1 && (
                    <button type="button" className="icon-btn" aria-label="Remove this dropdown"
                      onClick={() => setDraft({ ...d, dropdowns: d.dropdowns.filter((_, j) => j !== i) })}><X size={14} /></button>
                  )}
                </div>
              ))}
              <div>
                <button type="button" className="btn small" onClick={() => setDraft({ ...d, dropdowns: [...d.dropdowns, { object: '', property: '' }] })}>
                  <Plus size={14} /> Add another dropdown
                </button>
              </div>
              <p className="muted small">
                The first dropdown's choices start the list. Each one after it keeps its choices too: choices with the same internal value become one,
                the list's label, order and colour win, and the rest are added to every dropdown on the list. A label used for two different values is refused.
              </p>
            </>
          )}
          {d.kind === 'link' && (
            <>
              <DropdownPicker value={d.dropdown} label="Dropdown" taken={new Set()} onChange={(v) => setDraft({ ...d, dropdown: v })} />
              <p className="muted small">
                Choices with the same internal value become one and take the list's label, order and colour. The dropdown's other choices are added to every
                dropdown on the list. A label used for two different values is refused.
              </p>
            </>
          )}
        </EditPanel>
      )}
      {!lists && !error && <TableSkeleton rows={3} />}
      {lists && lists.length === 0 && !d && (
        <EmptyState icon={<ListChecks size={18} />} title="No option lists yet" action={<button className="btn primary" onClick={() => setDraft(newDraft())}>New option list</button>}>
          Create one to keep dropdowns on different objects in step.
        </EmptyState>
      )}
      {lists && lists.length > 0 && (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>List</th><th>Dropdowns</th><th>Choices</th><th /></tr>
            </thead>
            <tbody>
              {lists.map((l) => {
                const active = l.choices.filter((c) => c.record_status === 'active');
                const first = l.members[0];
                return (
                  <tr key={l.id}>
                    <td className="primary-cell wrap">
                      {l.label}
                      <span className="sub">{l.description || <code>{l.api_name}</code>}</span>
                    </td>
                    <td className="wrap">
                      {l.members.length === 0 && <span className="muted small">None yet</span>}
                      <span className="pill-list">
                        {l.members.map((m) => (
                          <span key={`${m.object}.${m.property}`} className="option-list-member">
                            <Link to={`/settings/properties?object=${encodeURIComponent(m.object)}`}>{m.object_label} · {m.property_label}</Link>
                            {m.record_status !== 'active' && <span className="muted small"> (archived)</span>}
                            <button className="icon-btn" aria-label={`Unlink ${m.object_label} ${m.property_label}`} onClick={() => unlink(l, m)}><X size={12} /></button>
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="wrap">
                      {active.length === 0 && <span className="muted small">{first ? 'No choices yet' : '--'}</span>}
                      <span className="pill-list">
                        {active.slice(0, MAX_CHOICES_SHOWN).map((c) => (
                          <span key={c.api_value} className="color-pill" style={{ ['--pill' as string]: c.color ?? 'var(--muted-text)' }}>{c.label}</span>
                        ))}
                        {active.length > MAX_CHOICES_SHOWN && <span className="muted small">+{active.length - MAX_CHOICES_SHOWN} more</span>}
                      </span>
                    </td>
                    <td className="row-actions">
                      <Menu align="right" trigger={(open) => <button className="icon-btn" onClick={open} aria-label={`Actions for ${l.label}`}><MoreHorizontal size={16} /></button>}>
                        {(close) => (
                          <>
                            <button onClick={() => { close(); setDraft({ kind: 'link', list: l, dropdown: { object: '', property: '' } }); }}>Link a dropdown</button>
                            {first && (
                              <button onClick={() => { close(); navigate(`/settings/properties?object=${encodeURIComponent(first.object)}`); }}>Edit choices</button>
                            )}
                            <button onClick={() => { close(); setDraft({ kind: 'edit', list: l, label: l.label, description: l.description ?? '' }); }}>Rename</button>
                            <button className="danger" onClick={() => { close(); void remove(l); }}>Delete list</button>
                          </>
                        )}
                      </Menu>
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
