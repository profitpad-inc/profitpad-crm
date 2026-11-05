import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Italic, Link2, List, ListOrdered, RemoveFormatting, Underline as UnderlineIcon } from 'lucide-react';
import { effectiveSnippets, matchSnippets, type Snippet } from '../lib/text-complete';
import { loadSnippets, renderSnippet } from '../lib/snippets';
import '../lib/text-complete.css';
import './rich-text.css';

// A small rich text box for email bodies: bold, italic, underline, lists and
// links (TipTap). Typing # at the start of a word offers snippets, like the
// CRM's plain text boxes (lib/text-complete.ts), filled in for `record`.

export interface RichTextHandle {
  setHTML: (html: string) => void;
  focus: () => void;
}

interface Menu { from: number; to: number; items: Snippet[]; active: number; left: number; top: number }

const SNIPPET_RE = /(?:^|\s)#([a-z0-9_-]{0,40})$/i;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const RichTextEditor = forwardRef<RichTextHandle, {
  value: string;
  onChange: (html: string, empty: boolean) => void;
  placeholder?: string;
  record?: { object: string; id: string } | null;
  ariaLabel?: string;
}>(function RichTextEditor({ value, onChange, placeholder, record, ariaLabel }, ref) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const menuRef = useRef<Menu | null>(null);
  menuRef.current = menu;
  const snippets = useRef<Promise<Snippet[]> | null>(null);
  const seq = useRef(0);
  const pickRef = useRef<(s: Snippet) => void>(() => undefined);

  const list = () => {
    snippets.current ??= loadSnippets().then(effectiveSnippets).catch(() => {
      snippets.current = null;
      return [];
    });
    return snippets.current;
  };

  // the # query before the caret, if any, opens or updates the menu
  async function look(editor: Editor) {
    const { $from, empty } = editor.state.selection;
    const before = empty ? $from.parent.textBetween(0, $from.parentOffset, undefined, '￼') : '';
    const m = SNIPPET_RE.exec(before);
    const mine = ++seq.current;
    if (!m) {
      setMenu(null);
      return;
    }
    const items = matchSnippets(await list(), m[1]).slice(0, 8);
    if (mine !== seq.current) return;
    if (!items.length) {
      setMenu(null);
      return;
    }
    const from = $from.pos - m[1].length - 1;
    const at = editor.view.coordsAtPos(from);
    setMenu((old) => ({ from, to: $from.pos, items, active: old && old.from === from ? Math.min(old.active, items.length - 1) : 0, left: at.left, top: at.bottom + 4 }));
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, code: false, horizontalRule: false }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto', 'tel'], HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
      Placeholder.configure({ placeholder: placeholder ?? '' })
    ],
    content: value,
    editorProps: {
      attributes: { class: 'rte-content', role: 'textbox', 'aria-multiline': 'true', ...(ariaLabel ? { 'aria-label': ariaLabel } : {}) },
      handleKeyDown: (_view, e) => {
        // Cmd/Ctrl+Enter belongs to the form around the box (send), not a new line
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) return true;
        const m = menuRef.current;
        if (!m) return false;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const step = e.key === 'ArrowDown' ? 1 : -1;
          setMenu({ ...m, active: (m.active + step + m.items.length) % m.items.length });
          return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          pickRef.current(m.items[m.active]);
          return true;
        }
        if (e.key === 'Escape') {
          setMenu(null);
          return true;
        }
        return false;
      }
    },
    onUpdate: ({ editor: ed }) => {
      onChange(ed.getHTML(), ed.isEmpty);
      void look(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => void look(ed),
    onBlur: () => setTimeout(() => setMenu(null), 150)
  });

  pickRef.current = async (s: Snippet) => {
    const m = menuRef.current;
    if (!editor || !m) return;
    setMenu(null);
    let text = s.body;
    try {
      text = await renderSnippet(s, record ?? null);
    } catch {
      // the snippet as written
    }
    const html = escapeHtml(text).replace(/\r?\n/g, '<br>');
    editor.chain().focus().insertContentAt({ from: m.from, to: m.to }, html).run();
  };

  useImperativeHandle(ref, () => ({
    setHTML: (html: string) => {
      editor?.commands.setContent(html, true);
    },
    focus: () => editor?.commands.focus('end')
  }), [editor]);

  useEffect(() => () => setMenu(null), []);

  if (!editor) return <div className="rte" />;

  const tool = (label: string, active: boolean, run: () => void, Icon: typeof Bold) => (
    <button type="button" className={`rte-tool${active ? ' active' : ''}`} aria-label={label} title={label} aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()} onClick={run}>
      <Icon size={15} />
    </button>
  );

  function applyLink() {
    if (linking === null || !editor) return;
    const href = linking.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) chain.unsetLink().run();
    else chain.setLink({ href: /^(https?:|mailto:|tel:)/i.test(href) ? href : `https://${href}` }).run();
    setLinking(null);
  }

  return (
    <div className="rte">
      <div className="rte-toolbar" role="toolbar" aria-label="Formatting">
        {tool('Bold', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), Bold)}
        {tool('Italic', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), Italic)}
        {tool('Underline', editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run(), UnderlineIcon)}
        <span className="rte-sep" />
        {tool('Bulleted list', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), List)}
        {tool('Numbered list', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), ListOrdered)}
        <span className="rte-sep" />
        {tool('Link', editor.isActive('link'), () => setLinking(editor.getAttributes('link').href ?? ''), Link2)}
        {tool('Clear formatting', false, () => editor.chain().focus().unsetAllMarks().clearNodes().run(), RemoveFormatting)}
        {linking !== null && (
          <span className="rte-link">
            <input autoFocus type="url" placeholder="https://…" value={linking} aria-label="Link address"
              onChange={(e) => setLinking(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
                if (e.key === 'Escape') { e.preventDefault(); setLinking(null); editor.commands.focus(); }
              }} />
            <button type="button" className="btn small" onClick={applyLink}>{linking.trim() ? 'Set link' : 'Remove link'}</button>
          </span>
        )}
      </div>
      <EditorContent editor={editor} />
      {menu && createPortal(
        <div className="tc-menu" role="listbox" style={{ left: menu.left, top: menu.top }} onMouseDown={(e) => e.preventDefault()}>
          {menu.items.map((s, i) => (
            <div key={s.id} role="option" aria-selected={i === menu.active} className={`tc-item${i === menu.active ? ' active' : ''}`}
              onMouseEnter={() => setMenu({ ...menu, active: i })} onClick={() => pickRef.current(s)}>
              <div className="tc-head"><span className="tc-badge">#{s.shortcut}</span><span className="tc-label">{s.name}</span></div>
              <div className="tc-hint">{s.body.replace(/\s+/g, ' ').trim().slice(0, 90)}</div>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
});
