import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Share2, Trash2 } from 'lucide-react';
import { api, getSchema, type AssociationLabel, type FilterGroup, type ObjectDef, type ObjectSummary } from '../lib/api';
import { useApp } from '../lib/app-context';
import { FilterBuilder, describeFilterGroups, emptyGroup, filtersComplete } from './FilterBuilder';
import { EmptyState, SettingsSection } from './settings';
import { Select } from './Select';

// Settings → Roles: sharing rules widen which records a role's users see (or
// edit) beyond their own or their team's: records of one object that match
// conditions, plus records linked to them. See docs/architecture.md.

type Access = 'read' | 'edit';

interface RuleLink {
  object: string;
  object_type_id: string;
  label_id: string | null;
  access: Access;
}

interface SharingRule {
  id: string;
  name: string;
  object: string;
  object_type_id: string;
  filter_groups: FilterGroup[];
  access: Access;
  associations: RuleLink[];
  problem: string | null;
}

interface Draft {
  id: string | null;
  name: string;
  object: string;
  filter_groups: FilterGroup[];
  access: Access;
  associations: RuleLink[];
}

const ACCESS_LABEL: Record<Access, string> = { read: 'view', edit: 'view and edit' };

// activities are shared together, as one row
const ACTIVITIES = ['calls', 'emails', 'notes', 'tasks'];

interface LinkRow {
  key: string;
  label: string;
  objects: ObjectSummary[];
}

function joinList(items: string[], word = 'and'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

function possessive(plural: string): string {
  return plural.endsWith('s') ? `${plural}'` : `${plural}'s`;
}

export function describeRule(rule: Pick<Draft, 'object' | 'filter_groups' | 'access' | 'associations'>, schema: ObjectDef, objectByName: Map<string, ObjectSummary>): string {
  const singular = schema.label_singular.toLowerCase();
  const plural = schema.label_plural.toLowerCase();
  let text = `People with this role can ${ACCESS_LABEL[rule.access]} any ${singular} where ${describeFilterGroups(schema, rule.filter_groups)}.`;
  const names = (access: Access) => [...new Set(rule.associations.filter((a) => a.access === access)
    .map((a) => (objectByName.get(a.object)?.label_plural ?? a.object).toLowerCase()))];
  const parts: string[] = [];
  if (names('read').length) parts.push(`view ${joinList(names('read'))}`);
  if (names('edit').length) parts.push(`view and edit ${joinList(names('edit'))}`);
  if (parts.length) text += ` They can also ${joinList(parts)} linked to those ${plural}.`;
  return text;
}

function countText(counts: { object: string; count: number }[], objectByName: Map<string, ObjectSummary>): string {
  const parts = counts.map((c) => {
    const o = objectByName.get(c.object);
    const label = (c.count === 1 ? o?.label_singular : o?.label_plural) ?? c.object;
    return `${c.count.toLocaleString()} ${label.toLowerCase()}`;
  });
  return `Right now that's ${joinList(parts)}.`;
}

export function SharingRules({ roleId, recordAccess }: { roleId: string; recordAccess: 'own' | 'team' | 'all' }) {
  const { objects, objectByName } = useApp();
  const [rules, setRules] = useState<SharingRule[]>([]);
  const [schemas, setSchemas] = useState<Map<string, ObjectDef>>(new Map());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const res = await api<{ results: SharingRule[] }>('GET', `/v1/roles/${roleId}/sharing-rules`);
    setRules(res.results);
  }

  useEffect(() => {
    setDraft(null);
    setError(null);
    reload().catch((err) => setError((err as Error).message));
  }, [roleId]); // eslint-disable-line react-hooks/exhaustive-deps

  // schemas of every object a rule (or the draft) is on, for descriptions
  const needed = useMemo(() => [...new Set([...rules.map((r) => r.object), ...(draft ? [draft.object] : [])])], [rules, draft]);
  useEffect(() => {
    for (const name of needed) {
      if (schemas.has(name)) continue;
      getSchema(name).then((s) => setSchemas((m) => new Map(m).set(name, s))).catch((err) => setError((err as Error).message));
    }
  }, [needed]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startNew() {
    const first = objectByName.get('companies') ?? objects[0];
    const schema = await getSchema(first.api_name);
    setSchemas((m) => new Map(m).set(first.api_name, schema));
    setDraft({ id: null, name: '', object: first.api_name, filter_groups: [emptyGroup(schema)], access: 'read', associations: [] });
  }

  function edit(rule: SharingRule) {
    setError(null);
    setDraft({ id: rule.id, name: rule.name, object: rule.object, filter_groups: rule.filter_groups, access: rule.access, associations: rule.associations });
  }

  async function remove(rule: SharingRule) {
    if (!window.confirm(`Delete the sharing rule "${rule.name}"? People with this role stop seeing the records it shared.`)) return;
    setError(null);
    try {
      await api('DELETE', `/v1/roles/${roleId}/sharing-rules/${rule.id}`);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) return setError('Give the rule a name.');
    const body = { name: draft.name.trim(), object: draft.object, filter_groups: draft.filter_groups, access: draft.access, associations: draft.associations };
    setError(null);
    try {
      if (draft.id) await api('PUT', `/v1/roles/${roleId}/sharing-rules/${draft.id}`, body);
      else await api('POST', `/v1/roles/${roleId}/sharing-rules`, body);
      setDraft(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const add = <button className="btn" onClick={() => startNew().catch((err) => setError((err as Error).message))}><Plus size={14} /> Add sharing rule</button>;

  return (
    <SettingsSection
      title="Sharing rules"
      description={<>
        Sharing rules let this role see records it otherwise wouldn't, without opening up everything: for example every company whose
        name contains "ACME", plus those companies' contacts. The object access above still decides what they can do with them, and a
        rule never lets anyone delete.
      </>}
      actions={!draft && rules.length > 0 ? add : undefined}
    >
      {recordAccess === 'all' && (
        <div className="callout">This role already sees every record, so its sharing rules add nothing until record access is set to their own or their team's records.</div>
      )}
      {error && <div className="error">{error}</div>}
      {rules.map((rule) => {
        const schema = schemas.get(rule.object);
        if (draft?.id === rule.id) return <RuleEditor key={rule.id} roleId={roleId} draft={draft} setDraft={setDraft} schema={schemas.get(draft.object)} onSave={save} />;
        return (
          <div key={rule.id} className="rule-card">
            <div className="rule-head">
              <strong>{rule.name}</strong>
              <button className="icon-btn" aria-label={`Edit ${rule.name}`} onClick={() => edit(rule)}><Pencil size={14} /></button>
              <button className="icon-btn" aria-label={`Delete ${rule.name}`} onClick={() => remove(rule)}><Trash2 size={14} /></button>
            </div>
            {schema && <p>{describeRule(rule, schema, objectByName)}</p>}
            {rule.problem && <div className="error">This rule shares nothing right now: {rule.problem}. Edit it to fix the conditions.</div>}
          </div>
        );
      })}
      {draft && draft.id === null && (
        <RuleEditor roleId={roleId} draft={draft} setDraft={setDraft} schema={schemas.get(draft.object)} onSave={save} />
      )}
      {!draft && rules.length === 0 && (
        <EmptyState icon={<Share2 size={18} />} title="No sharing rules yet" action={add}>
          Add one to let this role see a chosen set of records beyond its record access.
        </EmptyState>
      )}
    </SettingsSection>
  );
}

function RuleEditor({ roleId, draft, setDraft, schema, onSave }: {
  roleId: string;
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  schema: ObjectDef | undefined;
  onSave: () => void;
}) {
  const { objects, objectByName } = useApp();
  const [labels, setLabels] = useState<AssociationLabel[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    api<{ results: AssociationLabel[] }>('GET', `/v1/association-labels?object=${draft.object}`).then((r) => setLabels(r.results)).catch(() => setLabels([]));
  }, [draft.object]);

  // objects that can be linked to the rule's object, activities as one row
  const rows = useMemo<LinkRow[]>(() => {
    if (!schema) return [];
    const byId = new Map(objects.map((o) => [o.object_type_id, o]));
    const linked = new Map<string, ObjectSummary>();
    for (const l of labels) {
      const otherId = l.from_object_type === schema.object_type_id ? l.to_object_type : l.from_object_type;
      const o = byId.get(otherId);
      if (o) linked.set(o.api_name, o);
    }
    const list = [...linked.values()].sort((a, b) => a.label_plural.localeCompare(b.label_plural));
    const activities = list.filter((o) => ACTIVITIES.includes(o.api_name));
    const out: LinkRow[] = list.filter((o) => !ACTIVITIES.includes(o.api_name)).map((o) => ({ key: o.api_name, label: o.label_plural, objects: [o] }));
    if (activities.length) out.push({ key: 'activities', label: `Activities (${joinList(activities.map((o) => o.label_plural.toLowerCase()))})`, objects: activities });
    return out;
  }, [labels, schema, objects]);

  const complete = !!schema && filtersComplete(draft.filter_groups, schema);

  // live count of what the rule would share
  useEffect(() => {
    setPreview(null);
    if (!complete) return;
    const t = setTimeout(() => {
      api<{ counts: { object: string; count: number }[] }>('POST', `/v1/roles/${roleId}/sharing-rules/preview`, {
        name: draft.name || 'preview', object: draft.object, filter_groups: draft.filter_groups, access: draft.access, associations: draft.associations
      })
        .then((r) => setPreview(countText(r.counts, objectByName)))
        .catch((err) => setPreview(`Can't count yet: ${(err as Error).message}`));
    }, 400);
    return () => clearTimeout(t);
  }, [roleId, complete, draft.object, draft.filter_groups, draft.access, draft.associations]); // eslint-disable-line react-hooks/exhaustive-deps

  async function setObject(name: string) {
    const s = await getSchema(name);
    setDraft({ ...draft, object: name, filter_groups: [emptyGroup(s)], associations: [] });
  }

  // rows act on "any label" links; links limited to one label (API-only) are kept
  function rowAccess(row: LinkRow): Access | null {
    const link = draft.associations.find((a) => a.label_id === null && row.objects.some((o) => o.api_name === a.object));
    return link?.access ?? null;
  }

  function setRow(row: LinkRow, access: Access | null) {
    const names = row.objects.map((o) => o.api_name);
    const kept = draft.associations.filter((a) => a.label_id !== null || !names.includes(a.object));
    const added = access ? row.objects.map((o) => ({ object: o.api_name, object_type_id: o.object_type_id, label_id: null, access })) : [];
    setDraft({ ...draft, associations: [...kept, ...added] });
  }

  const anchor = objectByName.get(draft.object);

  return (
    <div className="rule-card editing">
      <label className="field">
        <span>Rule name</span>
        <input value={draft.name} maxLength={100} placeholder="Acme accounts" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <div className="rule-sentence">
        <span>Let this role</span>
        <Select value={draft.access} aria-label="Access" onChange={(v) => setDraft({ ...draft, access: v as Access })}>
          <option value="read">view</option>
          <option value="edit">view and edit</option>
        </Select>
        <span>every</span>
        <Select value={draft.object} aria-label="Object" onChange={(v) => setObject(v)}>
          {objects.map((o) => <option key={o.api_name} value={o.api_name}>{o.label_singular}</option>)}
        </Select>
        <span>where</span>
      </div>
      {schema ? (
        <FilterBuilder schema={schema} groups={draft.filter_groups} onChange={(filter_groups) => setDraft({ ...draft, filter_groups })} />
      ) : (
        <p className="muted">Loading…</p>
      )}

      {rows.length > 0 && (
        <>
          <p className="rule-subhead">Also share records linked to those {anchor?.label_plural.toLowerCase()}</p>
          <div className="rule-links">
            {rows.map((row) => {
              const access = rowAccess(row);
              return (
                <div key={row.key} className="rule-link">
                  <label>
                    <input type="checkbox" checked={access !== null} onChange={(e) => setRow(row, e.target.checked ? 'read' : null)} />
                    {row.label}
                  </label>
                  {access !== null && (
                    <Select value={access} aria-label={`${row.label} access`} onChange={(v) => setRow(row, v as Access)}>
                      <option value="read">view only</option>
                      <option value="edit">view and edit</option>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {schema && complete && (
        <div className="rule-summary">
          <p>{describeRule(draft, schema, objectByName)}</p>
          <p className="small">{preview ?? 'Counting…'}</p>
        </div>
      )}
      {schema && !complete && <p className="muted small">Fill in every condition to see what this rule shares.</p>}

      <div className="actions">
        <button className="btn primary" onClick={onSave} disabled={!complete}>{draft.id ? 'Save rule' : 'Create rule'}</button>
        <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </div>
  );
}
