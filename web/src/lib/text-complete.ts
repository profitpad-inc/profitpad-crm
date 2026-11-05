import './text-complete.css';

// Pop-up suggestions while typing in a text box: # for snippets, @ for people.
// Plain DOM, so the same code runs in the CRM and in the sandboxed view frame
// (where it works on any <textarea> the view draws, React or not).
//
// Typing the trigger character at the start of a word opens a small menu at
// the caret, filtered by what follows it. Up/Down move, Enter or Tab pick,
// Escape closes. Picking replaces "#query" with the text the trigger returns,
// through execCommand('insertText') so undo works and React's onChange fires.

export interface CompleteItem {
  key: string;
  label: string;
  // shown before the label (#shortcut, initials)
  badge?: string;
  // a muted second line (the snippet's text)
  hint?: string;
}

export interface Trigger {
  char: string;
  // which characters may follow the trigger (the query)
  query: RegExp;
  items: (query: string) => CompleteItem[] | Promise<CompleteItem[]>;
  // the text that replaces the trigger and query
  pick: (item: CompleteItem) => string | Promise<string>;
}

type Box = HTMLTextAreaElement | HTMLInputElement;

interface Open {
  trigger: Trigger;
  start: number;
  end: number;
  items: CompleteItem[];
  active: number;
}

const MAX_ITEMS = 8;

// Where the caret is on screen: a hidden copy of the box with the text up to
// the caret, measured at a marker.
const COPIED = ['boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight',
  'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'] as const;
function caretPoint(el: Box, pos: number): { left: number; top: number; height: number } {
  const style = getComputedStyle(el);
  const div = document.createElement('div');
  for (const k of COPIED) div.style[k] = style[k];
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.top = '0';
  div.style.left = '-9999px';
  div.style.whiteSpace = el instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre';
  div.style.overflowWrap = 'break-word';
  div.textContent = el.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = el.value.slice(pos) || '.';
  div.appendChild(mark);
  document.body.appendChild(div);
  const rect = el.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
  const out = {
    left: rect.left + mark.offsetLeft - el.scrollLeft,
    top: rect.top + mark.offsetTop - el.scrollTop,
    height: lineHeight
  };
  div.remove();
  return out;
}

function insert(el: Box, start: number, end: number, text: string): void {
  el.focus();
  el.setSelectionRange(start, end);
  // keeps undo, and fires a real input event (React's onChange)
  const done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  if (!done || el.value.slice(start, start + text.length) !== text) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export function attachComplete(el: Box, triggers: Trigger[]): () => void {
  let open: Open | null = null;
  let menu: HTMLDivElement | null = null;
  let seq = 0;
  let busy = false;

  function close() {
    open = null;
    seq++;
    menu?.remove();
    menu = null;
  }

  function draw() {
    if (!open || open.items.length === 0) {
      menu?.remove();
      menu = null;
      return;
    }
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'tc-menu';
      menu.setAttribute('role', 'listbox');
      // keep the focus in the box
      menu.addEventListener('mousedown', (e) => e.preventDefault());
      document.body.appendChild(menu);
    }
    menu.replaceChildren(...open.items.map((item, i) => {
      const row = document.createElement('div');
      row.className = `tc-item${i === open!.active ? ' active' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === open!.active));
      const head = document.createElement('div');
      head.className = 'tc-head';
      if (item.badge) {
        const b = document.createElement('span');
        b.className = 'tc-badge';
        b.textContent = item.badge;
        head.appendChild(b);
      }
      const l = document.createElement('span');
      l.className = 'tc-label';
      l.textContent = item.label;
      head.appendChild(l);
      row.appendChild(head);
      if (item.hint) {
        const h = document.createElement('div');
        h.className = 'tc-hint';
        h.textContent = item.hint;
        row.appendChild(h);
      }
      row.addEventListener('mouseenter', () => {
        if (open && open.active !== i) {
          open.active = i;
          draw();
        }
      });
      row.addEventListener('click', () => choose(i));
      return row;
    }));
    const at = caretPoint(el, open.start);
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    const below = at.top + at.height + 4;
    const h = menu.offsetHeight;
    menu.style.top = `${below + h > window.innerHeight - 8 && at.top - h - 4 > 8 ? at.top - h - 4 : below}px`;
    menu.querySelector('.tc-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  // the trigger and query just before the caret, if any
  function find(): { trigger: Trigger; start: number; end: number; query: string } | null {
    const end = el.selectionStart ?? 0;
    if (end !== el.selectionEnd) return null;
    const before = el.value.slice(Math.max(0, end - 60), end);
    for (const t of triggers) {
      const i = before.lastIndexOf(t.char);
      if (i < 0) continue;
      const start = end - before.length + i;
      // only at the start of a word: not in an email address or a URL#hash
      if (start > 0 && !/[\s([{"']/.test(el.value[start - 1])) continue;
      const query = before.slice(i + 1);
      if (!t.query.test(query)) continue;
      return { trigger: t, start, end, query };
    }
    return null;
  }

  async function update() {
    if (busy) return;
    const hit = find();
    if (!hit) {
      close();
      return;
    }
    const mine = ++seq;
    const items = (await hit.trigger.items(hit.query)).slice(0, MAX_ITEMS);
    if (mine !== seq) return;
    const sameList = open && open.trigger === hit.trigger && open.items.length === items.length && open.items.every((x, i) => x.key === items[i].key);
    open = { trigger: hit.trigger, start: hit.start, end: hit.end, items, active: sameList ? Math.min(open!.active, items.length - 1) : 0 };
    draw();
  }

  async function choose(i: number) {
    if (!open || busy) return;
    const { trigger, start, end } = open;
    const item = open.items[i];
    const typed = el.value.slice(start, end);
    close();
    busy = true;
    try {
      const text = await trigger.pick(item);
      // the typed #query is still there: replace it
      if (el.value.slice(start, end) === typed) insert(el, start, end, text);
    } catch (err) {
      console.warn('could not insert', err);
    } finally {
      busy = false;
    }
  }

  function onKey(e: Event) {
    const k = e as KeyboardEvent;
    if (!open || open.items.length === 0 || k.isComposing) return;
    if (k.key === 'ArrowDown' || k.key === 'ArrowUp') {
      open.active = (open.active + (k.key === 'ArrowDown' ? 1 : -1) + open.items.length) % open.items.length;
      draw();
    } else if (k.key === 'Enter' || k.key === 'Tab') {
      void choose(open.active);
    } else if (k.key === 'Escape') {
      close();
    } else {
      return;
    }
    k.preventDefault();
    k.stopPropagation();
  }

  const onInput = () => void update();
  const onCaret = (e: Event) => {
    const k = (e as KeyboardEvent).key;
    if (e.type === 'keyup' && k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Home' && k !== 'End') return;
    void update();
  };
  const onBlur = () => close();
  const onScroll = () => {
    if (open) draw();
  };

  el.addEventListener('input', onInput);
  el.addEventListener('keydown', onKey, true);
  el.addEventListener('keyup', onCaret);
  el.addEventListener('click', onCaret);
  el.addEventListener('blur', onBlur);
  el.addEventListener('scroll', onScroll);
  window.addEventListener('resize', onScroll);
  return () => {
    close();
    el.removeEventListener('input', onInput);
    el.removeEventListener('keydown', onKey, true);
    el.removeEventListener('keyup', onCaret);
    el.removeEventListener('click', onCaret);
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };
}

// ---- snippets ------------------------------------------------------------------

export interface Snippet {
  id: string;
  shortcut: string;
  name: string;
  body: string;
  shared: boolean;
}

// One per shortcut: a personal snippet hides the shared one with its shortcut.
export function effectiveSnippets(all: Snippet[]): Snippet[] {
  const byShortcut = new Map<string, Snippet>();
  for (const s of all) {
    const had = byShortcut.get(s.shortcut);
    if (!had || (had.shared && !s.shared)) byShortcut.set(s.shortcut, s);
  }
  return [...byShortcut.values()];
}

// Shortcut matches first (starts with, then contains), then name matches.
export function matchSnippets(list: Snippet[], query: string): Snippet[] {
  const q = query.toLowerCase();
  const rank = (s: Snippet) => (s.shortcut.startsWith(q) ? 0 : s.shortcut.includes(q) ? 1 : s.name.toLowerCase().includes(q) ? 2 : 3);
  return list.filter((s) => rank(s) < 3).sort((a, b) => rank(a) - rank(b) || a.shortcut.localeCompare(b.shortcut));
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function snippetTrigger(load: () => Promise<Snippet[]>, render: (s: Snippet) => Promise<string>): Trigger {
  let cache: Promise<Snippet[]> | null = null;
  const list = () => {
    cache ??= load().then(effectiveSnippets).catch(() => {
      cache = null;
      return [];
    });
    return cache;
  };
  return {
    char: '#',
    query: /^[a-z0-9_-]{0,40}$/i,
    items: async (q) => matchSnippets(await list(), q).map((s) => ({
      key: s.id, label: s.name, badge: `#${s.shortcut}`, hint: oneLine(s.body).slice(0, 90)
    })),
    pick: async (item) => {
      const s = (await list()).find((x) => x.id === item.key);
      return s ? render(s) : '';
    }
  };
}

// ---- mentions --------------------------------------------------------------------

export interface MentionUser { id: string; name: string }

// The note box shows "@Ann Lee"; the saved body carries @[Ann Lee](<id>) so the
// API knows who was tagged (ui.mentions).
export const MENTION_TOKEN = /@\[([^\]\n]{1,100})\]\(([0-9a-f]{10})\)/g;

export function mentionTrigger(load: () => Promise<MentionUser[]>, onPick: (u: MentionUser) => void): Trigger {
  let cache: Promise<MentionUser[]> | null = null;
  const list = () => {
    cache ??= load().catch(() => {
      cache = null;
      return [];
    });
    return cache;
  };
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return {
    char: '@',
    // a name may have spaces: "@ann l"
    query: /^[\p{L}\p{N}_.'-]{0,30}(?: [\p{L}\p{N}_.'-]{0,30}){0,2}$/u,
    items: async (q) => {
      const t = q.toLowerCase();
      return (await list())
        .filter((u) => u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t)) || u.name.toLowerCase().startsWith(t))
        .map((u) => ({ key: u.id, label: u.name, badge: initials(u.name) }));
    },
    pick: async (item) => {
      const u = (await list()).find((x) => x.id === item.key);
      if (!u) return '';
      onPick(u);
      return `@${u.name} `;
    }
  };
}

// Turns the "@Name" texts the box shows back into tokens, for the users picked.
// Longer names first, so "@Ann Lee" wins over "@Ann".
export function encodeMentions(text: string, picked: MentionUser[]): string {
  const users = [...new Map(picked.map((u) => [u.id, u])).values()].sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const u of users) {
    const esc = u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[\\s([{"'])@${esc}(?![\\p{L}\\p{N}_])`, 'gu'), `$1@[${u.name}](${u.id})`);
  }
  return out;
}

// The text split into plain runs and "@Name" runs for the users picked (same
// matching as encodeMentions), so a text box can draw the mentions as chips.
export function mentionParts(text: string, picked: MentionUser[]): { text: string; mention: boolean }[] {
  const names = [...new Set(picked.map((u) => u.name))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return [{ text, mention: false }];
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(^|[\\s([{"'])(@(?:${alt}))(?![\\p{L}\\p{N}_])`, 'gu');
  const parts: { text: string; mention: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1]!.length;
    if (start > at) parts.push({ text: text.slice(at, start), mention: false });
    parts.push({ text: m[2]!, mention: true });
    at = start + m[2]!.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mention: false });
  return parts;
}

// The tokens shown as "@Name" (plain text: search, excerpts).
export const mentionsAsText = (text: string) => text.replace(MENTION_TOKEN, '@$1');
