import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, getSchema, type ObjectDef, type Property } from '../lib/api';
import { useApp } from '../lib/app-context';
import { EmptyState, SaveBar, SettingRow, SettingsPage, SettingsSection, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';
import { reloadAddressConfig, type AddressGroup } from '../components/AddressInput';

// Settings → Address autocomplete (admins): the Google Maps API key and the
// address groups whose street box suggests addresses (api/src/address.ts).
// The key is stored sealed and never shown again, only its last four
// characters.

interface State {
  enabled: boolean;
  has_key: boolean;
  key_unreadable: boolean;
  key_hint: string | null;
  countries: string[];
  groups: AddressGroup[];
  using_defaults: boolean;
  default_groups: AddressGroup[];
  can_store_secrets: boolean;
}

interface Draft { enabled: boolean; countries: string; groups: AddressGroup[]; defaults: boolean }

const PARTS: { key: keyof Omit<AddressGroup, 'object'>; label: string; choice?: boolean }[] = [
  { key: 'street_1', label: 'Street (suggests addresses)' },
  { key: 'street_2', label: 'Street 2 (unit, suite)' },
  { key: 'city', label: 'City' },
  { key: 'province', label: 'State/Province', choice: true },
  { key: 'postal_code', label: 'Zip/Postal code' },
  { key: 'country', label: 'Country', choice: true }
];

const draftOf = (s: State): Draft => ({ enabled: s.enabled, countries: s.countries.join(', '), groups: s.groups, defaults: s.using_defaults });
const countryList = (text: string) => text.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
const sameGroups = (a: AddressGroup[], b: AddressGroup[]) => JSON.stringify(a) === JSON.stringify(b);

// properties that can hold a part: text for all, single-value dropdowns for province and country
function fits(p: Property, choice: boolean): boolean {
  if (p.record_status !== 'active' || p.is_base || p.read_only) return false;
  if (p.type === 'text') return p.options.display !== 'phone' && p.options.display !== 'html' && p.options.display !== 'code';
  return choice && p.type === 'dropdown' && p.options.single_value === true;
}

export function AddressSettings() {
  const { toast, objects } = useApp();
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [schemas, setSchemas] = useState<Record<string, ObjectDef>>({});
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<State>('GET', '/v1/address/settings')
      .then((s) => { setState(s); setDraft(draftOf(s)); })
      .catch((err) => setError((err as Error).message));
  }, []);

  // property lists for the objects the groups use
  const used = [...new Set(draft?.groups.map((g) => g.object).filter(Boolean) ?? [])];
  useEffect(() => {
    for (const o of used) {
      if (schemas[o]) continue;
      getSchema(o).then((s) => setSchemas((m) => ({ ...m, [o]: s }))).catch(() => undefined);
    }
  }, [used.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  async function put(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const s = await api<State>('PUT', '/v1/address/settings', body);
      setState(s);
      setDraft(draftOf(s));
      setKey('');
      reloadAddressConfig();
      toast(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const description = 'Street boxes suggest addresses from Google Maps as people type. Picking one fills in the rest of the address: street 2, city, state or province, postal code and country.';
  if (!state || !draft) {
    return <SettingsPage title="Address autocomplete" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={3} />}</SettingsPage>;
  }

  const dirty = draft.enabled !== state.enabled
    || countryList(draft.countries).join(',') !== state.countries.join(',')
    || draft.defaults !== state.using_defaults
    || (!draft.defaults && !sameGroups(draft.groups, state.groups));

  const setGroup = (i: number, g: AddressGroup) => setDraft({ ...draft, defaults: false, groups: draft.groups.map((x, j) => (j === i ? g : x)) });
  const save = () => put({
    enabled: draft.enabled,
    countries: countryList(draft.countries),
    groups: draft.defaults ? null : draft.groups
  }, 'Address autocomplete settings saved.');

  return (
    <SettingsPage title="Address autocomplete" description={description}>
      <SettingsSection title="Google Maps" description="Suggestions come from Google Places, billed to your own Google Cloud account. Create a key in the Google Cloud console with Places API (New) turned on. The key is used from this CRM's server, so restrict it by API (Places API (New)) rather than by website.">
        <SettingRow
          label="Google Maps API key"
          htmlFor="google-key"
          hint={state.has_key ? `A key ending in ${state.key_hint} is saved. It is never shown again.` : 'Checked with Google before it is saved, then stored encrypted.'}
        >
          {state.key_unreadable && <div className="error">The saved key can't be opened on this server (its encryption key changed). Save the API key again.</div>}
          {!state.can_store_secrets ? (
            <div className="callout warn">This server can't store secrets yet (MASTER_ENCRYPTION_KEY is not set).</div>
          ) : (
            <div className="key-row">
              <input
                id="google-key"
                type="password"
                autoComplete="off"
                placeholder={state.has_key ? 'Paste a new key to replace it' : 'AIza...'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button className="btn primary" disabled={busy || !key.trim()} onClick={() => put({ google_key: key.trim() }, 'API key saved.')}>
                {busy ? 'Checking…' : state.has_key ? 'Replace key' : 'Save key'}
              </button>
              {state.has_key && (
                <button className="btn ghost danger-text" disabled={busy} onClick={() => put({ google_key: null }, 'API key removed. Street boxes no longer suggest addresses.')}>Remove</button>
              )}
            </div>
          )}
        </SettingRow>
        <SettingRow label="Suggest addresses" hint={state.has_key ? 'Turn off to stop suggestions without removing the key.' : 'Add a key first.'}>
          <label><input type="checkbox" role="switch" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> {draft.enabled ? 'On' : 'Off'}</label>
        </SettingRow>
        <SettingRow label="Countries" htmlFor="address-countries" hint="2-letter country codes, separated by commas (up to 15). Leave empty to suggest addresses anywhere.">
          <input id="address-countries" value={draft.countries} placeholder="Anywhere" onChange={(e) => setDraft({ ...draft, countries: e.target.value })} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Address groups"
        description="Each group is one address on one object: the street property that suggests addresses, and the properties a picked address fills. Leave a part empty to skip it."
        actions={
          <>
            {!draft.defaults && (
              <button className="btn" onClick={() => setDraft({ ...draft, defaults: true, groups: state.default_groups })}>Use the defaults</button>
            )}
            <button className="btn" onClick={() => setDraft({ ...draft, defaults: false, groups: [...draft.groups, { object: '', street_1: '' }] })}>
              <Plus size={16} /> Add address group
            </button>
          </>
        }
      >
        {draft.defaults && <p className="muted small">Using the defaults: Street 1 on contacts and companies.</p>}
        {draft.groups.length === 0 ? (
          <EmptyState compact title="No address groups">Street boxes won't suggest addresses until you add one.</EmptyState>
        ) : (
          <div className="address-groups">
            {draft.groups.map((g, i) => {
              const schema = g.object ? schemas[g.object] : undefined;
              return (
                <div key={i} className="address-group">
                  <div className="address-group-head">
                    <label className="field">
                      <span>Object</span>
                      <Select
                        value={g.object}
                        onChange={(v) => setGroup(i, { object: v, street_1: '' })}
                        options={[{ value: '', label: 'Choose an object' }, ...objects.map((o) => ({ value: o.api_name, label: o.label_plural }))]}
                      />
                    </label>
                    <button className="btn ghost icon" aria-label="Remove this address group" title="Remove" onClick={() => setDraft({ ...draft, defaults: false, groups: draft.groups.filter((_, j) => j !== i) })}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                  {g.object && (
                    <div className="address-group-parts">
                      {PARTS.map((part) => {
                        const props = (schema?.properties ?? []).filter((p) => fits(p, !!part.choice) && (part.key !== 'street_1' || p.type === 'text'));
                        return (
                          <label key={part.key} className="field">
                            <span>{part.label}</span>
                            <Select
                              value={g[part.key] ?? ''}
                              onChange={(v) => setGroup(i, { ...g, [part.key]: v || undefined })}
                              options={[
                                { value: '', label: part.key === 'street_1' ? 'Choose a property' : 'None' },
                                ...props.map((p) => ({ value: p.api_name, label: p.label }))
                              ]}
                            />
                            {g[part.key] && <code className="address-part-name">{g[part.key]}</code>}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <SaveBar dirty={dirty} error={error}>
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft(draftOf(state))}>Discard</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>Save</button>
      </SaveBar>
    </SettingsPage>
  );
}
