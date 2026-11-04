import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AtSign } from 'lucide-react';
import { api } from '../lib/api';
import { onFrameFocus } from '../lib/frame-focus';

// The sidebar's Mentions button: notes and comments you were tagged in (@Name),
// with a count of the ones not looked at yet. Opening the list marks them seen.

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

export function MentionsButton({ expanded }: { expanded: boolean }) {
  const [unseen, setUnseen] = useState(0);
  const [list, setList] = useState<Mention[] | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => api<{ results: Mention[]; unseen: number }>('GET', '/v1/me/mentions')
    .then((r) => { setUnseen(r.unseen); return r.results; })
    .catch(() => null), []);

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
    const results = await refresh();
    setList(results ?? []);
    if (results?.some((m) => !m.seen)) {
      await api('POST', '/v1/me/mentions/seen', {}).catch(() => undefined);
      setUnseen(0);
    }
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
          <h3>Mentions</h3>
          {list === null ? (
            <div className="muted small mentions-empty">Loading…</div>
          ) : list.length === 0 ? (
            <div className="muted small mentions-empty">When someone tags you in a note or comment with @ and your name, it shows here.</div>
          ) : (
            <div className="mentions-list">
              {list.map((m) => (
                <Link key={`${m.kind}-${m.comment_id ?? m.note_id}`} to={mentionLink(m)} className={`mention-item${m.seen ? '' : ' new'}`} onClick={close}>
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
