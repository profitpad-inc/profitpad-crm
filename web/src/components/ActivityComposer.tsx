import { useEffect, useRef, useState } from 'react';
import { api, ApiError, getSchema, type ObjectDef, type Property } from '../lib/api';
import { useApp } from '../lib/app-context';
import { TextArea } from '../lib/snippets';
import { encodeMentions, type MentionUser } from '../lib/text-complete';
import { PropertyInput, fromInput, isEditable } from './ui';
import { confirmDialog } from './confirm';

// The activities a record page can write in place, in the order the name
// card's buttons show them.
export const COMPOSE_OBJECTS = ['calls', 'emails', 'notes', 'tasks'] as const;
export type ComposeObject = (typeof COMPOSE_OBJECTS)[number];

// What starts a new one: the name card's button and the tab's own button.
export const COMPOSE_VERB: Record<ComposeObject, string> = { calls: 'Log', emails: 'Log', notes: 'Create', tasks: 'Create' };

// The fields beside the body, for each activity (those the object has and
// the user may set). The body is the big box; notes have nothing else.
const COMPOSE_FIELDS: Record<ComposeObject, string[]> = {
  calls: ['call_type', 'direction', 'status', 'started_at', 'duration_seconds'],
  emails: ['subject', 'direction', 'from_address', 'to_addresses', 'sent_at'],
  notes: [],
  tasks: ['name', 'task_type', 'status', 'priority', 'due_at', 'owner']
};
const STARTS_AS_ME = ['owner'];
const PLACEHOLDER: Record<ComposeObject, string> = {
  calls: 'Call notes… (# for a snippet)',
  emails: 'Email body… (# for a snippet)',
  notes: 'Write a note… (@ to tag someone, # for a snippet)',
  tasks: 'Notes… (# for a snippet)'
};

// A new call, email, note or task written in the activity stream and linked
// to the page's record. focusKey: changes each time a button asks for it, so
// the box comes into view and takes focus again (the name card is in another
// column, above it on narrow screens).
export function ActivityComposer({ object, page, pageLabel, focusKey, hidden, onSaved, onCancel, onDirty }: {
  object: ComposeObject;
  hidden?: boolean;
  // told whether there is unsaved text, so starting another activity can ask first
  onDirty?: (dirty: boolean) => void;
  page: { object: string; id: string };
  pageLabel: string;
  focusKey: number;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { me } = useApp();
  const [schema, setSchema] = useState<ObjectDef | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState('');
  // users picked from the @ menu (notes only: they notify)
  const [mentioned, setMentioned] = useState<MentionUser[]>([]);
  const [error, setError] = useState<{ message: string; property?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const bodyBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    getSchema(object)
      .then((s) => {
        if (cancelled) return;
        setSchema(s);
        const start: Record<string, string> = {};
        for (const n of STARTS_AS_ME) {
          const p = s.properties.find((x) => x.api_name === n);
          if (me.user && p?.dropdown_options?.some((o) => o.api_value === me.user!.id && o.record_status === 'active')) start[n] = me.user.id;
        }
        setValues(start);
      })
      .catch((err) => !cancelled && setError({ message: (err as Error).message }));
    return () => {
      cancelled = true;
    };
  }, [object, me.user]);

  const canSet = (p: Property | undefined): p is Property => !!p && p.record_status === 'active' && isEditable(p);
  const bodyProp = schema?.properties.find((p) => p.api_name === 'body');
  const hasBody = canSet(bodyProp);
  const fields = schema ? COMPOSE_FIELDS[object].map((n) => schema.properties.find((p) => p.api_name === n)).filter(canSet) : [];
  // tasks lead with their title; the others with the body
  const titleFirst = object === 'tasks';
  const dirty = !!body.trim() || fields.some((p) => values[p.api_name] && !STARTS_AS_ME.includes(p.api_name));
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  const ready = object === 'notes' ? !!body.trim() : object === 'tasks' && fields.some((p) => p.api_name === 'name') ? !!values.name?.trim() : dirty;

  useEffect(() => {
    if (!schema) return;
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const first = titleFirst ? box.current?.querySelector<HTMLElement>('.composer-fields input, .composer-fields .select-face') : bodyBox.current;
    (first ?? bodyBox.current)?.focus({ preventScroll: true });
  }, [schema, focusKey, titleFirst]);

  async function save() {
    if (!schema || !ready || saving) return;
    setSaving(true);
    setError(null);
    const properties: Record<string, unknown> = {};
    for (const p of fields) {
      const v = values[p.api_name];
      if (v !== undefined && v !== '') properties[p.api_name] = fromInput(p, v);
    }
    if (hasBody && body.trim()) properties.body = object === 'notes' ? encodeMentions(body.trim(), mentioned) : body.trim();
    try {
      await api('POST', `/v1/objects/${object}`, { properties, associations: [page] });
      setBody('');
      setMentioned([]);
      await onSaved();
    } catch (err) {
      const property = err instanceof ApiError ? err.details?.property : undefined;
      setError({ message: (err as Error).message, property: fields.some((p) => p.api_name === property) ? property : undefined });
    } finally {
      setSaving(false);
    }
  }

  async function cancel() {
    if (dirty && !(await confirmDialog('What you wrote is not saved.', { title: `Discard this ${schema?.label_singular.toLowerCase() ?? 'activity'}?`, confirmLabel: 'Discard', danger: true }))) return;
    onCancel();
  }

  const label = schema?.label_singular.toLowerCase() ?? object.replace(/s$/, '');
  const fieldGrid = fields.length > 0 && (
    <div className="composer-fields">
      {fields.map((p) => (
        <label key={p.api_name} className={`field${p.api_name === 'name' || p.api_name === 'subject' || p.api_name === 'to_addresses' ? ' wide' : ''}`}>
          <span>{p.label}</span>
          <PropertyInput property={p} object={object} value={values[p.api_name] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [p.api_name]: v }))} />
          {error?.property === p.api_name && <div className="error prop-error" role="alert">{error.message}</div>}
        </label>
      ))}
    </div>
  );
  const bodyBoxEl = hasBody && (
    <TextArea ref={bodyBox} grow rows={3} placeholder={PLACEHOLDER[object]} value={body} onChange={(e) => setBody(e.target.value)}
      aria-label={bodyProp?.label ?? 'Body'} onMention={object === 'notes' ? (u) => setMentioned((m) => [...m, u]) : undefined} />
  );

  return (
    <div className="composer" ref={box} hidden={hidden}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      }}>
      {titleFirst ? <>{fieldGrid}{bodyBoxEl}</> : <>{bodyBoxEl}{fieldGrid}</>}
      {schema && !schema.permissions.create && <div className="composer-note small muted">You cannot create {schema.label_plural.toLowerCase()}.</div>}
      {error && !error.property && <div className="error composer-note">{error.message}</div>}
      <div className="composer-foot">
        <span className="small muted">Saved to this {pageLabel.toLowerCase()}'s activity</span>
        <span className="composer-buttons">
          <button className="btn small" onClick={cancel} disabled={saving}>Cancel</button>
          <button className="btn primary small" onClick={save} disabled={saving || !ready || !schema?.permissions.create}>
            {saving ? 'Saving…' : `${COMPOSE_VERB[object] === 'Log' ? 'Log' : 'Save'} ${label}`}
          </button>
        </span>
      </div>
    </div>
  );
}
