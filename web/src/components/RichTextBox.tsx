import { forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { attachRichComplete, chipElement, mentionTrigger, snippetTrigger, MENTION_TOKEN, type Trigger } from '../lib/text-complete';
import { loadMentionUsers, loadSnippets, renderSnippet, SnippetRecordContext } from '../lib/snippets';

// A text box whose @mentions are real chips (the comment box): a
// contenteditable="plaintext-only" div, so a chip can be padded like a posted
// mention and is deleted as one piece. The value is the saved body: plain
// text with @[Name](<user id>) for each chip. Uncontrolled: `initial` is read
// once; remount it (a new key) to reset.

export interface RichTextBoxHandle {
  focus: (atEnd?: boolean) => void;
}

interface Props {
  initial: string;
  onChange: (body: string) => void;
  placeholder?: string;
  disabled?: boolean;
  snippets?: boolean;
  mentions?: boolean;
  className?: string;
  'aria-label'?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}

// The body the box shows: text and chips.
function fill(el: HTMLElement, body: string) {
  el.replaceChildren();
  let last = 0;
  for (const m of body.matchAll(MENTION_TOKEN)) {
    if (m.index! > last) el.append(body.slice(last, m.index));
    el.append(chipElement({ label: m[1]!, id: m[2]! }));
    last = m.index! + m[0].length;
  }
  if (last < body.length) el.append(body.slice(last));
}

// The box's text and chips back to a body.
function read(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += (child as Text).data;
      else if (child instanceof HTMLElement) {
        if (child.dataset.chipId) out += `@[${child.dataset.chipLabel}](${child.dataset.chipId})`;
        else if (child.tagName === 'BR') out += '\n';
        else {
          // a browser may still wrap a new line in a <div>
          if (child.tagName === 'DIV' && out && !out.endsWith('\n')) out += '\n';
          walk(child);
        }
      }
    }
  };
  walk(el);
  return out.replace(/ /g, ' ');
}

export const RichTextBox = forwardRef<RichTextBoxHandle, Props>(function RichTextBox(
  { initial, onChange, placeholder, disabled = false, snippets = true, mentions = true, className, onKeyDown, ...aria }, outer
) {
  const ref = useRef<HTMLDivElement>(null);
  const record = useContext(SnippetRecordContext);
  const latest = useRef({ record, onChange });
  latest.current = { record, onChange };

  const markEmpty = (el: HTMLElement, body: string) => el.classList.toggle('empty', body.trim() === '' && !el.querySelector('[data-chip-id]'));

  useLayoutEffect(() => {
    const el = ref.current!;
    fill(el, initial);
    markEmpty(el, initial);
    // read once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const triggers: Trigger[] = [];
    if (snippets) triggers.push(snippetTrigger(loadSnippets, (s) => renderSnippet(s, latest.current.record)));
    if (mentions) triggers.push(mentionTrigger(loadMentionUsers, () => {}));
    return triggers.length ? attachRichComplete(el, triggers) : undefined;
  }, [snippets, mentions]);

  useImperativeHandle(outer, () => ({
    focus: (atEnd = true) => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      if (!atEnd) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }), []);

  return (
    <div ref={ref} role="textbox" aria-multiline="true" {...aria}
      className={['rich-box', className].filter(Boolean).join(' ')}
      contentEditable={disabled ? 'false' : 'plaintext-only'} suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={(e) => {
        const body = read(e.currentTarget);
        markEmpty(e.currentTarget, body);
        latest.current.onChange(body);
      }}
      onKeyDown={onKeyDown} />
  );
});
