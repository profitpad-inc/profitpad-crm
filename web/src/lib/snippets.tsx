import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { api } from './api';
import { attachComplete, mentionTrigger, snippetTrigger, type MentionUser, type Snippet, type Trigger } from './text-complete';

// Snippets (# in a text box) and @mentions for the CRM's own text boxes.
// Settings → Snippets keeps them (api/src/snippets.ts).

// The record being worked on, for {{r.<property>}} merge fields: the record
// page sets it for everything on the page (note box, property boxes, create
// and log modals opened from it).
interface SnippetRecord { object: string; id: string }
const RecordContext = createContext<SnippetRecord | null>(null);

export function SnippetRecordProvider({ object, id, children }: SnippetRecord & { children: ReactNode }) {
  return <RecordContext.Provider value={{ object, id }}>{children}</RecordContext.Provider>;
}

// Read once a minute at most; Settings → Snippets clears it after a change.
const FRESH_MS = 60_000;
let snippets: { at: number; list: Promise<Snippet[]> } | null = null;
export function loadSnippets(): Promise<Snippet[]> {
  if (!snippets || Date.now() - snippets.at > FRESH_MS) {
    const list = api<{ results: Snippet[] }>('GET', '/v1/snippets').then((r) => r.results);
    snippets = { at: Date.now(), list };
    list.catch(() => { snippets = null; });
  }
  return snippets.list;
}
export function clearSnippetCache(): void {
  snippets = null;
}

let users: { at: number; list: Promise<MentionUser[]> } | null = null;
export function loadMentionUsers(): Promise<MentionUser[]> {
  if (!users || Date.now() - users.at > 5 * FRESH_MS) {
    const list = api<{ results: MentionUser[] }>('GET', '/v1/mentions/users').then((r) => r.results);
    users = { at: Date.now(), list };
    list.catch(() => { users = null; });
  }
  return users.list;
}

export function renderSnippet(s: Snippet, record: SnippetRecord | null): Promise<string> {
  return api<{ text: string }>('POST', `/v1/snippets/${s.id}/render`, record ? { object: record.object, record_id: record.id } : {})
    .then((r) => r.text);
}

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  // false: no snippet menu (code, settings)
  snippets?: boolean;
  // set: typing @ offers users; called with each one picked
  onMention?: (u: MentionUser) => void;
};

// A <textarea> that offers snippets on # (and users on @ with onMention).
export const TextArea = forwardRef<HTMLTextAreaElement, Props>(function TextArea({ snippets: withSnippets = true, onMention, ...rest }, outer) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ref.current!, []);
  const record = useContext(RecordContext);
  // the latest values, so the menu is not rebuilt on every render
  const latest = useRef({ record, onMention });
  latest.current = { record, onMention };
  const mentions = !!onMention;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const triggers: Trigger[] = [];
    if (withSnippets) triggers.push(snippetTrigger(loadSnippets, (s) => renderSnippet(s, latest.current.record)));
    if (mentions) triggers.push(mentionTrigger(loadMentionUsers, (u) => latest.current.onMention?.(u)));
    return triggers.length ? attachComplete(el, triggers) : undefined;
  }, [withSnippets, mentions]);
  return <textarea ref={ref} {...rest} />;
});
