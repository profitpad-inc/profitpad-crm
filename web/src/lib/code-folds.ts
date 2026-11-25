// Fold ranges for read-only code (components/ViewCode.tsx CodeBlock), close to
// what VS Code offers: a pair of brackets or an HTML element that spans lines
// folds the lines between them (the closing line stays shown), and otherwise a
// line followed by more deeply indented lines folds those lines.
//
// The scan is a heuristic, not a parser: strings and comments are skipped so
// their brackets do not count, quotes end at the line end (except template
// literals and SQL), and an unmatched closer is ignored.

// text: indentation folds only (plain text, logs, Markdown)
export type CodeLang = 'html' | 'js' | 'sql' | 'text';

// The language for a Markdown fence tag (```sql) or a file name (page.html)
export function langFor(tagOrName: string | null | undefined): CodeLang {
  const t = (tagOrName ?? '').trim().toLowerCase();
  const ext = t.includes('.') ? t.slice(t.lastIndexOf('.') + 1) : t;
  if (['html', 'htm', 'xml', 'svg', 'vue', 'xhtml'].includes(ext)) return 'html';
  if (['sql', 'pgsql', 'postgres', 'postgresql', 'psql'].includes(ext)) return 'sql';
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'css', 'scss', 'less', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'php', 'swift', 'kt', 'dart', 'javascript', 'typescript'].includes(ext)) return 'js';
  return 'text';
}

// line index -> last line index hidden when the line is folded
export type Folds = Map<number, number>;

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const OPEN: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

type Open = { kind: 'b'; ch: string; line: number } | { kind: 't'; name: string; line: number };

export function findFolds(text: string, lang: CodeLang): Folds {
  const lines = text.split('\n');
  const pairs: Folds = new Map();
  const stack: Open[] = [];
  let line = 0;
  let i = 0;
  const n = text.length;

  const addPair = (start: number, end: number) => {
    if (end - start < 2) return;
    const prev = pairs.get(start);
    if (prev === undefined || end - 1 > prev) pairs.set(start, end - 1);
  };
  // moves i to `to`, counting newlines on the way
  const advance = (to: number) => {
    for (; i < to && i < n; i++) if (text.charCodeAt(i) === 10) line++;
  };
  const skipTo = (needle: string, from: number) => {
    const at = text.indexOf(needle, from);
    advance(at < 0 ? n : at + needle.length);
  };
  const closeBracket = (ch: string) => {
    const want = OPEN[ch];
    for (let k = stack.length - 1; k >= 0; k--) {
      const o = stack[k];
      if (o.kind === 'b' && o.ch === want) {
        stack.length = k;
        addPair(o.line, line);
        return;
      }
      if (o.kind === 't') return; // brackets never close past an element
    }
  };

  // code: brackets, strings and comments; stops at `until` (e.g. "</script").
  // // comments only count in JS (in CSS, url(//cdn...) is not one).
  const scanCode = (until: string | null, mode: 'js' | 'css' | 'sql') => {
    while (i < n) {
      const c = text[i];
      if (until && c === '<' && text.slice(i, i + until.length).toLowerCase() === until) return;
      if (c === '\n') { line++; i++; continue; }
      if (c === '/' && text[i + 1] === '*') { skipTo('*/', i + 2); continue; }
      if (mode === 'js' && c === '/' && text[i + 1] === '/') { skipLine(); continue; }
      if (mode === 'sql' && c === '-' && text[i + 1] === '-') { skipLine(); continue; }
      if (c === '`' || ((c === '"' || c === "'") && mode === 'sql')) { skipString(c, true); continue; }
      if (c === '"' || c === "'") { skipString(c, false); continue; }
      if (c === '{' || c === '[' || c === '(') stack.push({ kind: 'b', ch: c, line });
      else if (c === '}' || c === ']' || c === ')') closeBracket(c);
      i++;
    }
  };
  const skipLine = () => {
    const at = text.indexOf('\n', i);
    i = at < 0 ? n : at; // the newline itself is counted by the caller's loop
  };
  const skipString = (q: string, multiline: boolean) => {
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '\\') { advance(i + 2); continue; }
      if (c === q) { i++; return; }
      if (c === '\n') {
        if (!multiline) return;
        line++;
      }
      i++;
    }
  };

  if (lang === 'html') {
    const tagRe = /<(\/?)([a-zA-Z][\w:-]*)/y;
    while (i < n) {
      const c = text[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === '<' && text.startsWith('<!--', i)) {
        const start = line;
        skipTo('-->', i + 4);
        addPair(start, line + 1); // a multi-line comment folds down to its last line
        continue;
      }
      if (c === '<') {
        tagRe.lastIndex = i;
        const m = tagRe.exec(text);
        if (m) {
          const closing = m[1] === '/';
          const name = m[2].toLowerCase();
          const startLine = line;
          // to the tag's end, past quoted attribute values
          advance(i + m[0].length);
          let selfClosed = false;
          while (i < n && text[i] !== '>') {
            const ch = text[i];
            if (ch === '"' || ch === "'") { skipString(ch, true); continue; }
            if (ch === '/' && text[i + 1] === '>') selfClosed = true;
            advance(i + 1);
          }
          advance(i + 1);
          if (closing) {
            for (let k = stack.length - 1; k >= 0; k--) {
              const o = stack[k];
              if (o.kind === 't' && o.name === name) {
                stack.length = k;
                addPair(o.line, startLine);
                break;
              }
            }
          } else if (!selfClosed && !VOID_TAGS.has(name)) {
            stack.push({ kind: 't', name, line: startLine });
            if (name === 'script' || name === 'style') scanCode(`</${name}`, name === 'script' ? 'js' : 'css');
          }
          continue;
        }
      }
      if (c === '{' || c === '[') stack.push({ kind: 'b', ch: c, line });
      else if (c === '}' || c === ']') closeBracket(c);
      i++;
    }
  } else if (lang !== 'text') {
    scanCode(null, lang);
  }

  // indentation folds for lines no pair starts on
  const folds: Folds = new Map(pairs);
  const indent = lines.map((l) => (l.trim() === '' ? -1 : l.length - l.trimStart().length));
  for (let s = 0; s < lines.length; s++) {
    if (indent[s] < 0 || folds.has(s)) continue;
    let last = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (indent[k] < 0) continue;
      if (indent[k] <= indent[s]) break;
      last = k;
    }
    if (last > s) folds.set(s, last);
  }
  return folds;
}
