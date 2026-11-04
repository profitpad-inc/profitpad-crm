import sanitizeHtml from 'sanitize-html';
import { badRequest } from './errors.js';

// Email signatures (users.email_signature, migration 0076): HTML that ends up
// in other people's inboxes, so it keeps what mail clients draw (text,
// tables, images, links, inline styles) and loses scripts, frames, forms and
// event handlers. Images and links must be web addresses: a CRM file's public
// link or any public address (no data: or cid: images, which many clients
// block or drop).
const SIGNATURE_OPTIONS: sanitizeHtml.IOptions = {
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

const MAX_SIGNATURE = 100_000;

export function cleanSignature(raw: string): string | null {
  if (raw.length > MAX_SIGNATURE) throw badRequest(`the email signature is too long (at most ${MAX_SIGNATURE.toLocaleString('en-US')} characters)`, { property: 'email_signature' });
  const html = sanitizeHtml(raw, SIGNATURE_OPTIONS).trim();
  return html || null;
}
