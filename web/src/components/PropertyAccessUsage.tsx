import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { api, type View } from '../lib/api';
import { filterParam } from '../lib/filters';
import { Select } from './Select';
import { Loading } from './Loading';

// The property editor's Access and Usage tabs (Settings, Properties).
// Access: GET/PUT /v1/schema/{object}/properties/{property}/access (migration
// 0142). Usage: GET .../usage (api/src/property-usage.ts).

export type AccessLevel = 'full' | 'read_only' | 'hidden';
export type AccessMode = 'admins' | 'everyone_edit' | 'everyone_view' | 'roles';

export interface PropertyAccess {
  property: string;
  system: boolean;
  default: AccessLevel;
  roles: { id: string; name: string; is_admin: boolean; override: AccessLevel | null; access: AccessLevel }[];
}

export interface AccessDraft {
  mode: AccessMode;
  // roles mode: each non-admin role's access
  roles: Record<string, AccessLevel>;
}

const LEVEL_LABELS: Record<AccessLevel, string> = { full: 'View and edit', read_only: 'View', hidden: 'No access' };

const MODES: { value: AccessMode; label: string; hint: string }[] = [
  { value: 'admins', label: 'Private to Super Admins only', hint: 'Everyone else no longer sees it on records, tables, filters, exports, views or the API.' },
  { value: 'everyone_edit', label: 'Allow everyone to view and edit', hint: 'Anyone who can read and edit the records.' },
  { value: 'everyone_view', label: 'Allow everyone to view', hint: 'Only Super Admins can change its values.' },
  { value: 'roles', label: 'Assign to roles', hint: 'Pick what each role gets. Roles added later get no access until given some here.' }
];

// what the API sent, as the tab's choices
export function accessDraftOf(a: PropertyAccess): AccessDraft {
  const others = a.roles.filter((r) => !r.is_admin);
  const roles = Object.fromEntries(others.map((r) => [r.id, r.access]));
  if (others.some((r) => r.override !== null)) return { mode: 'roles', roles };
  const mode: AccessMode = a.default === 'full' ? 'everyone_edit' : a.default === 'read_only' ? 'everyone_view' : 'admins';
  return { mode, roles };
}

// the choices as the PUT body
export function accessBody(d: AccessDraft): { default: AccessLevel; roles: Record<string, AccessLevel> } {
  switch (d.mode) {
    case 'everyone_edit': return { default: 'full', roles: {} };
    case 'everyone_view': return { default: 'read_only', roles: {} };
    case 'admins': return { default: 'hidden', roles: {} };
    case 'roles': return { default: 'hidden', roles: d.roles };
  }
}

export function AccessTab({ access, draft, setDraft, objectLabel, canEdit }: {
  access: PropertyAccess | null; draft: AccessDraft | null; setDraft: (d: AccessDraft) => void; objectLabel: string; canEdit: boolean;
}) {
  if (!access || !draft) return <Loading />;
  if (access.system) {
    return <p className="muted">This is a system property: everyone who can read {objectLabel} sees it. Its access can't be changed.</p>;
  }
  const others = access.roles.filter((r) => !r.is_admin);
  const admins = access.roles.filter((r) => r.is_admin);
  return (
    <div className="prop-access">
      <p className="muted small">
        Who can see and change this property. It works with each role's object access: a role still needs Read on {objectLabel} to see it, and Edit to change it.
        Super Admins always have full access.
      </p>
      <div className="prop-access-modes" role="radiogroup" aria-label="Property access">
        {MODES.map((m) => (
          <label key={m.value} className={`prop-access-mode${draft.mode === m.value ? ' active' : ''}`}>
            <input
              type="radio" name="property-access" value={m.value} checked={draft.mode === m.value} disabled={!canEdit}
              onChange={() => setDraft({ ...draft, mode: m.value })}
            />
            <span>
              <span className="prop-access-label">{m.label}</span>
              <span className="muted small">{m.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {draft.mode === 'roles' && (
        <div className="access-table">
          <table className="grid">
            <thead><tr><th>Role</th><th>Access</th></tr></thead>
            <tbody>
              {admins.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="muted">View and edit (Super Admin)</td>
                </tr>
              ))}
              {others.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>
                    <Select
                      value={draft.roles[r.id] ?? 'hidden'} disabled={!canEdit} aria-label={`Access for ${r.name}`}
                      onChange={(v) => setDraft({ ...draft, roles: { ...draft.roles, [r.id]: v as AccessLevel } })}
                    >
                      {(['full', 'read_only', 'hidden'] as AccessLevel[]).map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {others.length === 0 && <p className="muted small">There are no roles besides Super Admin yet.</p>}
        </div>
      )}
      {!canEdit && <p className="muted small">Changing access needs the Roles permission.</p>}
    </div>
  );
}

interface UsageItem { name: string; detail?: string; href?: string; updated_at?: string | null; updated_by?: string | null }
interface Usage { fill: { filled: number; total: number }; groups: { kind: string; label: string; items: UsageItem[] }[] }

const pct = (n: number, d: number) => {
  if (!d) return '0%';
  const v = (n / d) * 100;
  return `${v < 10 && v > 0 ? v.toFixed(2) : v.toFixed(1).replace(/\.0$/, '')}%`;
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function UsageTab({ object, property, label, objectLabel }: { object: string; property: string; label: string; objectLabel: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<Usage>('GET', `/v1/schema/${object}/properties/${encodeURIComponent(property)}/usage`)
      .then(setUsage)
      .catch((e) => setError((e as Error).message));
  }, [object, property]);

  // Review opens the object's default "All ..." view (the first shared view
  // made, so renaming or reordering it doesn't matter) filtered to records
  // that have this property, which also adds the property as a column there
  const [allViewId, setAllViewId] = useState<number | null>(null);
  useEffect(() => {
    api<{ results: View[] }>('GET', `/v1/ui/views?object=${object}`)
      .then((r) => {
        const shared = r.results.filter((v) => v.owner === null).sort((a, b) => a.id - b.id);
        setAllViewId(shared[0]?.id ?? null);
      })
      .catch(() => undefined);
  }, [object]);
  const reviewParams = new URLSearchParams();
  if (allViewId !== null) reviewParams.set('view', String(allViewId));
  reviewParams.set('filters', filterParam([{ filters: [{ property, operator: 'has_property' }] }]));

  if (error) return <div className="error">{error}</div>;
  if (!usage) return <Loading />;
  const places = usage.groups.reduce((n, g) => n + g.items.length, 0);
  const toggle = (k: string) => setClosed((s) => {
    const next = new Set(s);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });

  return (
    <div className="prop-usage">
      <h3 className="prop-usage-title">{label} is used in {places} {places === 1 ? 'place' : 'places'}</h3>
      <div className="prop-usage-fill">
        <div>
          <div className="small">{objectLabel} fill rate for this property</div>
          <div className="prop-usage-rate">
            {pct(usage.fill.filled, usage.fill.total)}
            <span className="muted small"> {usage.fill.filled.toLocaleString()} out of {usage.fill.total.toLocaleString()}</span>
          </div>
        </div>
        <Link className="link-btn" to={`/objects/${object}?${reviewParams}`} target="_blank">Review {objectLabel} <ExternalLink size={13} /></Link>
      </div>
      {places === 0 && <p className="muted">Nothing else in the CRM uses this property yet: no views, templates, forms, calculations, webhooks or sharing rules.</p>}
      {usage.groups.map((g) => {
        const open = !closed.has(g.kind);
        return (
          <section key={g.kind} className="prop-usage-group">
            <button className="prop-usage-head" onClick={() => toggle(g.kind)} aria-expanded={open}>
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {g.label} ({g.items.length})
            </button>
            {open && (
              <table className="grid">
                <thead><tr><th>Name</th><th className="prop-usage-when">Last updated</th></tr></thead>
                <tbody>
                  {g.items.map((it, i) => (
                    <tr key={i}>
                      <td>
                        {it.href
                          ? <Link className="link-btn" to={it.href} target="_blank">{it.name} <ExternalLink size={12} /></Link>
                          : it.name}
                        {it.detail && <div className="muted small">{it.detail}</div>}
                      </td>
                      <td className="prop-usage-when">
                        {it.updated_at ? when(it.updated_at) : ''}
                        {it.updated_by && <div className="muted small">by {it.updated_by}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
      <p className="muted small">Custom views and document templates count when their queries read the property. Code that reads it some other way isn't found.</p>
    </div>
  );
}
