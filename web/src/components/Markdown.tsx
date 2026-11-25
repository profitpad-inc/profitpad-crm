import type { ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';
import { langFor } from '../lib/code-folds';

// Renders simple Markdown as React elements (never raw HTML, so nothing in the
// text can inject markup). Covers what people and AI agents write in the
// knowledge base: headings, paragraphs, bullet and numbered lists, quotes,
// code blocks, rules, tables, **bold**, *italic*, `code`, ~~strike~~ and
// [links](url). Links only open http(s) and mailto addresses. With onLink (the
// custom view kit passes openUrl, since the view frame cannot open links
// itself) a link is a button that hands its address over instead.

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

type OnLink = ((url: string) => void) | undefined;

function link(k: string, url: string, label: ReactNode, onLink: OnLink): ReactNode {
  if (onLink) return <button key={k} type="button" className="md-link" onClick={() => onLink(url)}>{label}</button>;
  return <a key={k} href={url} target="_blank" rel="noopener noreferrer">{label}</a>;
}

function inline(text: string, key = 'i', onLink?: OnLink): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+?\*\*|__[^_]+?__)|(~~[^~]+?~~)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*?\*|\b_[^_\s][^_]*?_\b)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), k, onLink)}</strong>);
    else if (m[3]) out.push(<s key={k}>{inline(t.slice(2, -2), k, onLink)}</s>);
    else if (m[4]) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      out.push(SAFE_URL.test(url) ? link(k, url, inline(label, k, onLink), onLink) : label);
    } else if (m[5]) out.push(<em key={k}>{inline(t.slice(1, -1), k, onLink)}</em>);
    else if (m[6]) out.push(link(k, t, t, onLink));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Lines of a paragraph keep their line breaks, as the plain-text view did.
function lines(text: string[], key: string, onLink?: OnLink): ReactNode[] {
  return text.flatMap((l, i) => (i ? [<br key={`${key}-br${i}`} />, ...inline(l, `${key}-${i}`, onLink)] : inline(l, `${key}-${i}`, onLink)));
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*```/;
// a table: a row with pipes, then a separator row (| --- | :---: |)
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const startsTable = (rows: string[], i: number) => rows[i].includes('|') && i + 1 < rows.length && TABLE_SEP.test(rows[i + 1]);

function blocks(src: string, key = 'b', onLink?: OnLink): ReactNode[] {
  const rows = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const k = `${key}${out.length}`;
    if (!row.trim()) { i++; continue; }
    if (FENCE.test(row)) {
      const tag = row.trim().slice(3).trim().split(/\s/)[0];
      const code: string[] = [];
      i++;
      while (i < rows.length && !FENCE.test(rows[i])) code.push(rows[i++]);
      i++;
      out.push(<CodeBlock key={k} text={code.join('\n')} wrap={false} lang={langFor(tag)} className="md-code" />);
      continue;
    }
    const h = HEADING.exec(row);
    if (h) {
      const Tag = `h${Math.min(h[1].length + 2, 6)}` as 'h3';
      out.push(<Tag key={k}>{inline(h[2], k, onLink)}</Tag>);
      i++;
      continue;
    }
    if (RULE.test(row)) { out.push(<hr key={k} />); i++; continue; }
    if (startsTable(rows, i)) {
      const head = cells(row);
      i += 2;
      const body: string[][] = [];
      while (i < rows.length && rows[i].includes('|') && rows[i].trim()) body.push(cells(rows[i++]));
      out.push(
        <div key={k} className="md-table">
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${k}h${j}`, onLink)}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? '', `${k}r${ri}c${j}`, onLink)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }
    if (/^\s*>/.test(row)) {
      const quote: string[] = [];
      while (i < rows.length && /^\s*>/.test(rows[i])) quote.push(rows[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={k}>{blocks(quote.join('\n'), `${k}q`, onLink)}</blockquote>);
      continue;
    }
    if (BULLET.test(row) || NUMBER.test(row)) {
      const ordered = !BULLET.test(row);
      const pat = ordered ? NUMBER : BULLET;
      const start = ordered ? Number(NUMBER.exec(row)![1]) : 1;
      const items: string[][] = [];
      while (i < rows.length) {
        const m = pat.exec(rows[i]);
        if (m) { items.push([ordered ? m[2] : m[1]]); i++; continue; }
        // an indented line carries on the item above
        if (items.length && /^\s{2,}\S/.test(rows[i]) && !BULLET.test(rows[i]) && !NUMBER.test(rows[i])) {
          items[items.length - 1].push(rows[i].trim()); i++; continue;
        }
        break;
      }
      const lis = items.map((it, j) => <li key={j}>{lines(it, `${k}-${j}`, onLink)}</li>);
      out.push(ordered ? <ol key={k} start={start === 1 ? undefined : start}>{lis}</ol> : <ul key={k}>{lis}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < rows.length && rows[i].trim() && !FENCE.test(rows[i]) && !HEADING.test(rows[i])
      && !RULE.test(rows[i]) && !/^\s*>/.test(rows[i]) && !BULLET.test(rows[i]) && !NUMBER.test(rows[i]) && !startsTable(rows, i)) {
      para.push(rows[i++]);
    }
    out.push(<p key={k}>{lines(para, k, onLink)}</p>);
  }
  return out;
}

export function Markdown({ children, onLink }: { children: string; onLink?: (url: string) => void }) {
  return <>{blocks(children, 'b', onLink)}</>;
}
