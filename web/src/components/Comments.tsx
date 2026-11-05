import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { initials } from '../lib/display';
import { TextArea } from '../lib/snippets';
import { MENTION_TOKEN, encodeMentions, mentionParts, mentionsAsText, type MentionUser } from '../lib/text-complete';
import { MentionText } from './MentionText';
import { confirmDialog, alertDialog } from './confirm';
import { useLiveVersion } from '../lib/live';

// Comments on a call, email, note, task, form submission, marketing event
// participation or object event occurrence (native object comments, pc_0034;
// api/src/comments.ts). Oldest first, a box at the end to add one; @ tags a
// user (they see it under Mentions). Authors edit their own; authors and
// admins delete them.

export const COMMENT_TARGETS = ['calls', 'emails', 'notes', 'tasks', 'form_submissions', 'marketing_event_participations', 'object_event_occurrences'];

export interface Comment {
  id: string;
  body: string;
  author: { id: string; name: string | null } | null;
  created_by: string;
  created_at: string;
  edited_at: string | null;
  can_edit: boolean;
  can_delete: boolean;
}

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
const full = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const tokensOf = (body: string): MentionUser[] => [...body.matchAll(MENTION_TOKEN)].map((m) => ({ name: m[1]!, id: m[2]! }));
const authorName = (c: Comment) => c.author?.name ?? (c.created_by.startsWith('api:') ? 'API key' : 'Someone');

export function Comments({ object, id, readOnly = false, onCount, highlight }: {
  object: string; id: string; readOnly?: boolean;
  // called with the number of comments after each load and change
  onCount?: (n: number) => void;
  // a comment to scroll to and mark (from a Mentions link)
  highlight?: string | null;
}) {
  const [list, setList] = useState<Comment[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countRef = useRef(onCount);
  countRef.current = onCount;

  // a live change on the record (a comment added, edited or removed) loads
  // the thread again in place
  const version = useLiveVersion(object, id);
  const shownFor = useRef('');
  useEffect(() => {
    let cancelled = false;
    if (shownFor.current !== `${object}:${id}`) setList(null);
    shownFor.current = `${object}:${id}`;
    api<{ results: Comment[] }>('GET', `/v1/objects/${object}/${id}/comments`)
      .then((r) => { if (!cancelled) { setList(r.results); countRef.current?.(r.results.length); } })
      .catch((err) => {
        if (cancelled) return;
        // a role without comments: no thread at all
        if (err instanceof ApiError && err.status === 403) setHidden(true);
        else setError((err as Error).message);
      });
    return () => { cancelled = true; };
  }, [object, id, version]);

  useEffect(() => {
    if (!highlight || !list?.some((c) => c.id === highlight)) return;
    document.getElementById(`comment-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [highlight, list]);

  const change = (next: Comment[]) => {
    setList(next);
    onCount?.(next.length);
  };

  async function remove(c: Comment) {
    if (!(await confirmDialog('The comment is removed for everyone.', { title: 'Delete this comment?', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api('DELETE', `/v1/comments/${c.id}`);
      change((list ?? []).filter((x) => x.id !== c.id));
    } catch (err) {
      await alertDialog((err as Error).message, { title: 'Could not delete the comment' });
    }
  }

  if (hidden) return null;
  return (
    <div className="comments" onClick={(e) => e.stopPropagation()}>
      <div className="comments-head">
        <MessageSquare size={14} strokeWidth={1.75} aria-hidden />
        <span>Comments{list && list.length > 0 ? ` (${list.length})` : ''}</span>
      </div>
      {error && <div className="error">{error}</div>}
      {list === null && !error && <div className="muted small">Loading…</div>}
      {list && list.length > 0 && (
        <ul className="comment-list">
          {list.map((c) => (
            <CommentItem key={c.id} comment={c} highlighted={c.id === highlight}
              onSaved={(u) => change(list.map((x) => (x.id === u.id ? u : x)))} onDelete={() => remove(c)} />
          ))}
        </ul>
      )}
      {list && !readOnly && <CommentBox object={object} id={id} onPosted={(c) => change([...list, c])} />}
      {list && list.length === 0 && readOnly && <div className="muted small">No comments</div>}
    </div>
  );
}

function CommentItem({ comment: c, highlighted, onSaved, onDelete }: { comment: Comment; highlighted: boolean; onSaved: (c: Comment) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const name = authorName(c);
  return (
    <li id={`comment-${c.id}`} className={`comment${highlighted ? ' highlighted' : ''}`}>
      <span className="comment-avatar" aria-hidden>{initials(name)}</span>
      <div className="comment-main">
        <div className="comment-head">
          {c.author ? <Link to={`/objects/users/${c.author.id}`} className="comment-author">{name}</Link> : <strong className="comment-author">{name}</strong>}
          <time dateTime={c.created_at} title={full(c.created_at)}>{ago(c.created_at)}</time>
          {c.edited_at && <span className="muted" title={`Edited ${full(c.edited_at)}`}>(edited)</span>}
          {!editing && (c.can_edit || c.can_delete) && (
            <span className="comment-actions">
              {c.can_edit && <button className="comment-icon-btn" title="Edit" aria-label="Edit comment" onClick={() => setEditing(true)}><Pencil size={14} strokeWidth={1.75} /></button>}
              {c.can_delete && <button className="comment-icon-btn danger" title="Delete" aria-label="Delete comment" onClick={onDelete}><Trash2 size={14} strokeWidth={1.75} /></button>}
            </span>
          )}
        </div>
        {editing ? (
          <CommentEditor initial={c.body} submitLabel="Save" autoFocus
            onSubmit={async (body) => { onSaved(await api<Comment>('PATCH', `/v1/comments/${c.id}`, { body })); setEditing(false); }}
            onCancel={() => setEditing(false)} />
        ) : (
          <div className="comment-body"><MentionText text={c.body} /></div>
        )}
      </div>
    </li>
  );
}

function CommentBox({ object, id, onPosted }: { object: string; id: string; onPosted: (c: Comment) => void }) {
  // remounted after each post, so the box starts empty
  const [key, setKey] = useState(0);
  return (
    <CommentEditor key={key} initial="" submitLabel="Comment" placeholder="Add a comment… type @ to tag someone"
      onSubmit={async (body) => { onPosted(await api<Comment>('POST', `/v1/objects/${object}/${id}/comments`, { body })); setKey((k) => k + 1); }} />
  );
}

// The comment text box: @ tags users, Cmd/Ctrl+Enter submits, Escape cancels
// an edit. A new comment's buttons show once there is text.
function CommentEditor({ initial, submitLabel, placeholder, autoFocus = false, onSubmit, onCancel }: {
  initial: string; submitLabel: string; placeholder?: string; autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>; onCancel?: () => void;
}) {
  const [text, setText] = useState(() => mentionsAsText(initial));
  const [mentioned, setMentioned] = useState<MentionUser[]>(() => tokensOf(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!autoFocus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);
  const changed = text.trim() !== mentionsAsText(initial).trim();

  async function submit() {
    if (saving || !text.trim()) return;
    if (onCancel && !changed) { onCancel(); return; }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(encodeMentions(text.trim(), mentioned));
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  async function cancel() {
    if (!onCancel) { setText(''); setMentioned([]); return; }
    if (changed && !(await confirmDialog('Your changes are not saved.', { title: 'Discard your changes?', confirmLabel: 'Discard', danger: true }))) return;
    onCancel();
  }

  const showFoot = !!onCancel || text.trim() !== '';
  return (
    <div className="comment-editor">
      {/* the picked @mentions drawn as chips on a copy of the text behind the box */}
      <div className="mention-field">
      <div className="mention-backdrop" ref={backdrop} aria-hidden="true">
        {mentionParts(text, mentioned).map((p, i) => (p.mention ? <mark key={i}>{p.text}</mark> : p.text))}
        {'\u200b'}
      </div>
      <TextArea ref={box} grow rows={1} value={text} placeholder={placeholder} aria-label="Comment" disabled={saving}
        onScroll={(e) => { if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop; }}
        onChange={(e) => setText(e.target.value)}
        onMention={(u) => setMentioned((m) => [...m, u])}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
          else if (e.key === 'Escape' && !e.defaultPrevented && onCancel) { e.preventDefault(); void cancel(); }
        }} />
      </div>
      {error && <div className="error">{error}</div>}
      {showFoot && (
        <div className="comment-editor-foot">
          <button className="btn small" onClick={() => void cancel()} disabled={saving}>Cancel</button>
          <button className="btn primary small" onClick={() => void submit()} disabled={saving || !text.trim()}>{saving ? 'Saving…' : submitLabel}</button>
        </div>
      )}
    </div>
  );
}
