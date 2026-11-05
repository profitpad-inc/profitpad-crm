import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AtSign } from 'lucide-react';
import { api } from '../lib/api';
import { onFrameFocus } from '../lib/frame-focus';

// The sidebar's Mentions button: notes and comments you were tagged in (@Name),
// with a count of the unread ones. Opening a mention marks it read; "Mark all
// as read" does the rest. "Unread only" (remembered per browser) hides read ones.

interface Mention {
  kind: 'note' | 'comment';
  note_id?: string;
  comment_id?: string;
  // the note, or the record the comment is on
  activity: { object: string; object_type_id: string; id: string };
  created_at: string;
  seen: boolean;
  mentioned_by: { id: string; name: string | null } | null;
  excerpt: string;
  record: { object: string; label: string; id: string; name: string | null } | null;
}

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// objects listed in a record's activity stream (RecordPage's ACTIVITY_OBJECTS)
const STREAM_OBJECTS = ['calls', 'emails', 'notes', 'tasks', 'form_submissions'];

// The note, or the activity with the comment, opened in its record's activity
// stream (?pc_0032=<id>); otherwise the commented record's own page.
// ?comment= marks the comment.
function mentionLink(m: Mention): string {
  const a = m.activity;
  const comment = m.kind === 'comment' ? `comment=${m.comment_id}` : '';
  if (m.record && STREAM_OBJECTS.includes(a.object)) return `/objects/${m.record.object}/${m.record.id}?${a.object_type_id}=${a.id}${comment ? `&${comment}` : ''}`;
  return `/objects/${a.object}/${a.id}${comment ? `?${comment}` : ''}`;
}

const UNREAD_KEY = 'pc.mentions.unreadOnly';
const loadUnreadOnly = () => {
  try { return localStorage.getItem(UNREAD_KEY) === '1'; } catch { return false; }
};

export function MentionsButton({ expanded }: { expanded: boolean }) {
  const [unseen, setUnseen] = useState(0);
  const [list, setList] = useState<Mention[] | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(loadUnreadOnly);
  const ref = useRef<HTMLDivElement>(null);

  // the badge: the unread count, up to the API's 100
  const refreshCount = useCallback(() => api<{ unseen: number }>('GET', '/v1/me/mentions?unread=1&limit=100')
    .then((r) => setUnseen(r.unseen))
    .catch(() => undefined), []);

  const load = useCallback((onlyUnread: boolean) => api<{ results: Mention[] }>('GET', `/v1/me/mentions${onlyUnread ? '?unread=1' : ''}`)
    .then((r) => r.results)
    .catch(() => null), []);

  const refresh = refreshCount;

  // the count: now, every two minutes, and when the tab comes back
  useEffect(() => {
    void refresh();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 120_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const close = useCallback(() => setAnchor(null), []);
  useEffect(() => {
    if (anchor === null) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.mentions-btn')) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    const offFrame = onFrameFocus(close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      offFrame();
    };
  }, [anchor, close]);

  async function open(bottom: number) {
    setAnchor(bottom);
    setList(null);
    void refreshCount();
    setList((await load(unreadOnly)) ?? []);
  }

  async function toggleUnreadOnly(on: boolean) {
    setUnreadOnly(on);
    try { localStorage.setItem(UNREAD_KEY, on ? '1' : '0'); } catch { /* not stored */ }
    setList(null);
    setList((await load(on)) ?? []);
  }

  const idOf = (m: Mention) => m.comment_id ?? m.note_id;

  function markRead(m: Mention) {
    if (m.seen) return;
    setList((l) => l && l.map((x) => (x === m ? { ...x, seen: true } : x)));
    setUnseen((n) => Math.max(0, n - 1));
    void api('POST', '/v1/me/mentions/seen', m.kind === 'comment' ? { comment_ids: [m.comment_id] } : { note_ids: [m.note_id] }).catch(() => undefined);
  }

  async function markAllRead() {
    setUnseen(0);
    // with "Unread only" on, the list empties; otherwise everything turns read
    setList((l) => l && (unreadOnly ? [] : l.map((x) => ({ ...x, seen: true }))));
    await api('POST', '/v1/me/mentions/seen', {}).catch(() => undefined);
    void refreshCount();
  }

  const label = unseen ? `Mentions (${unseen} new)` : 'Mentions';
  return (
    <>
      <button className={`nav-item mentions-btn${anchor !== null ? ' active' : ''}`} title={expanded ? undefined : label} aria-label={label}
        onClick={(e) => (anchor === null ? void open(e.currentTarget.getBoundingClientRect().bottom) : close())}>
        <AtSign size={18} strokeWidth={1.75} />
        {expanded && <span>Mentions</span>}
        {unseen > 0 && <span className="nav-count">{unseen > 99 ? '99+' : unseen}</span>}
      </button>
      {anchor !== null && (
        <div className="mentions-menu" ref={ref} style={{ bottom: Math.max(8, window.innerHeight - anchor) }} role="dialog" aria-label="Mentions">
          <div className="mentions-head">
            <h3>Mentions</h3>
            <button type="button" className="btn ghost small push-right" disabled={unseen === 0} onClick={() => void markAllRead()}>Mark all as read</button>
          </div>
          <label className="mentions-filter small">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => void toggleUnreadOnly(e.target.checked)} />
            <span>Unread only</span>
          </label>
          {list === null ? (
            <div className="muted small mentions-empty">Loading…</div>
          ) : list.length === 0 ? (
            <div className="muted small mentions-empty">{unreadOnly ? 'No unread mentions.' : 'When someone tags you in a note or comment with @ and your name, it shows here.'}</div>
          ) : (
            <div className="mentions-list">
              {list.map((m) => (
                <Link key={`${m.kind}-${idOf(m)}`} to={mentionLink(m)} className={`mention-item${m.seen ? '' : ' new'}`} onClick={() => { markRead(m); close(); }}>
                  <div className="mention-head">
                    <strong>{m.mentioned_by?.name ?? 'Someone'}</strong>
                    <span> tagged you{m.kind === 'comment' ? ' in a comment' : ''}{m.record ? <> on <strong>{m.record.name || m.record.label}</strong></> : null}</span>
                    <time className="push-right muted" dateTime={m.created_at}>{ago(m.created_at)}</time>
                  </div>
                  <div className="mention-excerpt">{m.excerpt}</div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
