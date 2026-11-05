import sanitizeHtml from 'sanitize-html';
import { Parser } from 'htmlparser2';

// Email bodies written in the CRM go to other people's inboxes, so they keep
// what mail clients draw (text, lists, tables, images, links, inline styles)
// and lose scripts, frames, forms and event handlers. Same rules as email
// signatures (signature.ts); images must be web addresses.
const EMAIL_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'font', 'center',
    'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col', 'caption'
  ],
  allowedAttributes: {
    '*': ['class', 'style', 'title', 'align', 'valign', 'width', 'height', 'bgcolor', 'dir', 'lang'],
    a: ['href', 'target', 'rel', 'name'],
    img: ['src', 'alt', 'border'],
    font: ['color', 'face', 'size'],
    table: ['border', 'cellpadding', 'cellspacing', 'role'],
    td: ['colspan', 'rowspan', 'nowrap'],
    th: ['colspan', 'rowspan', 'nowrap'],
    col: ['span']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard'
};

export const MAX_BODY = 1_000_000;

export function cleanEmailHtml(raw: string): string {
  return sanitizeHtml(raw, EMAIL_OPTIONS).trim();
}

// The body with the sender's signature under it (both already cleaned).
export function withSignature(body: string, signature: string | null): string {
  if (!signature?.trim()) return body;
  return `${body}<br><div class="pcrm-signature">${signature}</div>`;
}

const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'tr', 'ul', 'ol', 'center', 'hr']);

// The plain-text part sent beside the HTML: paragraphs and line breaks kept,
// list items as "- ", links as "text (address)".
export function htmlToText(html: string): string {
  let out = '';
  const links: (string | null)[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'br') out += '\n';
        else if (name === 'li') out += '\n- ';
        else if (BLOCKS.has(name)) out += '\n\n';
        else if (name === 'td' || name === 'th') out += ' ';
        if (name === 'a') links.push(attrs.href && !attrs.href.startsWith('mailto:') ? attrs.href : null);
        if (name === 'img' && attrs.alt) out += attrs.alt;
      },
      ontext(text) {
        out += text.replace(/\s+/g, ' ');
      },
      onclosetag(name) {
        if (BLOCKS.has(name)) out += '\n\n';
        if (name === 'a') {
          const href = links.pop();
          if (href && !out.trimEnd().endsWith(href)) out += ` (${href})`;
        }
      }
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();
  return out
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
