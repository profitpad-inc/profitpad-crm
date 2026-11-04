import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Boxes, MoreHorizontal, Plus } from 'lucide-react';
import { api, clearSchemaCache, type NavItem, type ObjectSummary } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Menu, Modal } from '../components/ui';
import { EmptyState, SettingsPage } from '../components/settings';

// Admin page listing the objects and creating custom ones. Creation goes
// through POST /v1/schema (meta.create_object), so the database enforces the
// naming rules and assigns the next pc_2xxx code; its messages are shown as
// they come back.

const SOURCE: Record<ObjectSummary['kind'], string> = { system: 'System', native: 'Built in', custom: 'Custom' };

// a plural from a singular label: Project → Projects, Property → Properties, Box → Boxes
function pluralOf(singular: string): string {
  const s = singular.trim();
  if (!s) return '';
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(s)) return `${s}es`;
  return `${s}s`;
}

// object api_name from a label: lowercase letters, digits, underscores, starting with a letter
function slug(label: string): string {
  const s = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 63);
  return /^[0-9]/.test(s) ? `o_${s}`.slice(0, 63) : s;
}

export function ObjectSettings() {
  const { objects, reloadObjects, toast } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ObjectSummary | 'new' | null>(null);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => [...objects]
      .filter((o) => !q || o.label_plural.toLowerCase().includes(q) || o.label_singular.toLowerCase().includes(q) || o.api_name.includes(q))
      .sort((a, b) => a.label_plural.localeCompare(b.label_plural)),
    [objects, q]
  );

  async function saved(message: string) {
    setEditing(null);
    clearSchemaCache();
    await reloadObjects();
    toast(message);
  }

  return (
    <SettingsPage
      title="Objects"
      description={<>
        Objects are the kinds of records the CRM keeps, such as contacts or deals. Create a custom object for anything else you track,
        then give it properties. New objects can be linked to any other object.
      </>}
      actions={<button className="btn primary" onClick={() => setEditing('new')}><Plus size={14} /> Create object</button>}
    >
      <div className="settings-toolbar">
        <input type="search" placeholder="Search objects" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search objects" />
        <span className="muted small">{shown.length} {shown.length === 1 ? 'object' : 'objects'}</span>
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={<Boxes size={18} />} title={q ? 'No matching objects' : 'No objects'}>
          {q ? 'Try a different search.' : 'Create an object to start keeping a new kind of record.'}
        </EmptyState>
      ) : (
        <div className="access-table">
          <table className="grid">
            <thead>
              <tr><th>Name</th><th>One record is a</th><th>Internal name</th><th>Source</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.object_type_id}>
                  <td className="primary-cell"><Link to={`/objects/${o.api_name}`}>{o.label_plural}</Link></td>
                  <td>{o.label_singular}</td>
                  <td><code className="muted">{o.api_name}</code></td>
                  <td>{SOURCE[o.kind] ?? o.kind}</td>
                  <td className="row-actions">
                    <Menu align="right" trigger={(open) => <button className="icon-btn" onClick={open} aria-label={`Actions for ${o.label_plural}`}><MoreHorizontal size={16} /></button>}>
                      {(close) => (
                        <>
                          <button onClick={() => { close(); navigate(`/objects/${o.api_name}`); }}>Open records</button>
                          <button onClick={() => { close(); navigate(`/settings/properties?object=${encodeURIComponent(o.api_name)}`); }}>Edit properties</button>
                          {o.kind === 'custom' && <button onClick={() => { close(); setEditing(o); }}>Rename</button>}
                        </>
                      )}
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ObjectEditor
          object={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </SettingsPage>
  );
}

function ObjectEditor({ object, onClose, onSaved }: {
  object: ObjectSummary | null; onClose: () => void; onSaved: (message: string) => Promise<void>;
}) {
  const { reloadNav } = useApp();
  const isNew = object === null;
  const [singular, setSingular] = useState(object?.label_singular ?? '');
  const [plural, setPlural] = useState(object?.label_plural ?? '');
  const [apiName, setApiName] = useState(object?.api_name ?? '');
  const [description, setDescription] = useState(object?.description ?? '');
  // the plural and internal name follow the labels until edited (new objects only)
  const [autoPlural, setAutoPlural] = useState(isNew);
  const [autoName, setAutoName] = useState(isNew);
  const [addToMenu, setAddToMenu] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = isNew
    ? !!(singular || plural || apiName || description)
    : singular !== object.label_singular || plural !== object.label_plural || description !== (object.description ?? '');

  function onSingular(v: string) {
    setSingular(v);
    if (autoPlural) {
      const p = pluralOf(v);
      setPlural(p);
      if (autoName) setApiName(slug(p));
    }
  }

  function onPlural(v: string) {
    setAutoPlural(false);
    setPlural(v);
    if (autoName) setApiName(slug(v));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const created = await api<ObjectSummary>('POST', '/v1/schema', {
          api_name: apiName.trim(),
          label_singular: singular.trim(),
          label_plural: plural.trim(),
          description: description.trim() || undefined
        });
        let note = '';
        if (addToMenu) {
          // append to the end of the default sidebar menu; a failure here keeps the object
          try {
            const menus = await api<{ results: { scope: string; items: NavItem[] }[] }>('GET', '/v1/ui/nav/menus');
            const items = menus.results.find((m) => m.scope === 'default')?.items ?? [];
            await api('PUT', '/v1/ui/nav/default', { items: [...items, { type: 'object', object: created.api_name }] });
            await reloadNav();
          } catch (e) {
            note = ` (not added to the menu: ${(e as Error).message})`;
          }
        }
        await onSaved(`${created.label_plural} created${note}`);
      } else {
        await api('PATCH', `/v1/schema/${object.api_name}`, {
          label_singular: singular.trim(),
          label_plural: plural.trim(),
          description: description.trim()
        });
        await onSaved(`${plural.trim()} saved`);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      locked={dirty || busy}
      title={isNew ? 'Create object' : `Rename ${object.label_plural}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !singular.trim() || !plural.trim() || !apiName.trim()}>
            {isNew ? 'Create' : 'Save'}
          </button>
        </>
      }
    >
      <div className="prop-editor">
        <div className="field-row">
          <label className="field grow">
            <span>Singular label</span>
            <input value={singular} maxLength={63} placeholder="Project" onChange={(e) => onSingular(e.target.value)} autoFocus />
          </label>
          <label className="field grow">
            <span>Plural label</span>
            <input value={plural} maxLength={63} placeholder="Projects" onChange={(e) => onPlural(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Internal name</span>
          <input
            value={apiName}
            maxLength={63}
            disabled={!isNew}
            onChange={(e) => { setAutoName(false); setApiName(e.target.value); }}
          />
        </label>
        {isNew && (
          <p className="muted small">
            The internal name is used by the API, imports and reports: lowercase letters, digits and underscores. It cannot be changed later.
          </p>
        )}
        <label className="field">
          <span>Description</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {isNew && (
          <>
            <div className="checks">
              <label><input type="checkbox" checked={addToMenu} onChange={(e) => setAddToMenu(e.target.checked)} /> Add to the sidebar menu</label>
            </div>
            <p className="muted small">
              Every object starts with a name and the system properties; add your own on the Properties page.
              Admins can use it right away; other roles need access to it in Settings, Roles.
            </p>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}
