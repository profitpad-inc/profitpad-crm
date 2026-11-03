import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import type { PublicQuote } from '../routes/public.js';

// A one-file PDF of a quote, drawn like the customer's page on /p/quote/
// (web/src/public/quote.ts, document.ts, public.css): a sheet of paper with the
// title and status, label-over-value parties, a ledger of lines, the total on a
// double rule and signatures on a signing line. Same fonts as the page: Inter
// for text, Montserrat for the title and total, embedded from the @fontsource
// WOFF files (fontkit cannot subset their WOFF2 files). Those files hold the
// Latin subset only, so a string with other characters falls back to Helvetica,
// which is what the PDF used before (it shows Š and Ž, but not Ł or Cyrillic either).

const require = createRequire(import.meta.url);
const fontFile = (pkg: string, file: string) => require.resolve(`@fontsource/${pkg}/files/${file}`);
const FONTS = {
  Inter: fontFile('inter', 'inter-latin-400-normal.woff'),
  'Inter-Medium': fontFile('inter', 'inter-latin-500-normal.woff'),
  'Inter-SemiBold': fontFile('inter', 'inter-latin-600-normal.woff'),
  'Montserrat-Bold': fontFile('montserrat', 'montserrat-latin-700-normal.woff')
};
type Face = keyof typeof FONTS;
const FALLBACK: Record<Face, string> = {
  Inter: 'Helvetica', 'Inter-Medium': 'Helvetica', 'Inter-SemiBold': 'Helvetica-Bold', 'Montserrat-Bold': 'Helvetica-Bold'
};
// the unicode-range of the @fontsource "latin" files
const LATIN = /^[\u0000-ÿıŒœʻʼˆ˚˜̩̄̈ -⁯€™↑↓−∕﻿�]*$/;

// web/src/lib/theme.ts DEFAULT_THEME, for tenants without a saved theme
const DEFAULT_THEME = { text: '#18202b', muted_text: '#5d6878', border: '#dce1e8', surface: '#f3f5f8' };

const money = (v: number | null, currency: string | null) =>
  v === null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(v);

const STATUS_LABEL: Record<string, string> = {
  sent: 'Open', pending_countersign: 'Awaiting countersignature', accepted: 'Accepted', rejected: 'Declined', expired: 'Expired'
};
// public.css .pp-pill and .pp-note colours, which the theme does not change
const PILL: Record<string, { fill: string; stroke: string; text: string }> = {
  accepted: { fill: '#ecfdf3', stroke: '#abefc6', text: '#05603a' },
  rejected: { fill: '#fef3f2', stroke: '#fecdca', text: '#912018' },
  expired: { fill: '#fef3f2', stroke: '#fecdca', text: '#912018' },
  pending_countersign: { fill: '#fffaeb', stroke: '#fedf89', text: '#93370d' }
};
const NOTE = {
  good: { fill: '#ecfdf3', bar: '#17b26a', text: '#05603a' },
  wait: { fill: '#fffaeb', bar: '#f79009', text: '#93370d' },
  bad: { fill: '#fef3f2', bar: '#f04438', text: '#912018' }
};

// calendar days as the page shows them: November 2, 2026
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};
// signing times are shown in UTC, to the second: 2026-11-02 14:05:33 UTC
const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

// "data:image/png;base64,..." -> PNG bytes pdfkit can draw
const pngBytes = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

export function renderQuotePdf(q: PublicQuote, theme: Record<string, string>): Promise<Buffer> {
  const c = { ...DEFAULT_THEME, ...theme };
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: q.name ?? 'Quote' } });
  for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  // set the face, size and colour for a string; returns the string for chaining
  const style = (face: Face, size: number, color: string, s = '') => {
    doc.font(LATIN.test(s) ? face : FALLBACK[face]).fontSize(size).fillColor(color);
    return s;
  };
  const write = (s: string, face: Face, size: number, color: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}) => {
    doc.text(style(face, size, color, s), x, y, { lineGap: 1.5, ...opts });
    return doc.y;
  };
  const measure = (s: string, face: Face, size: number) => doc.widthOfString(style(face, size, c.text, s));
  const hrule = (y: number, x0: number, x1: number, color: string, w = 0.75) =>
    doc.moveTo(x0, y).lineTo(x1, y).lineWidth(w).strokeColor(color).stroke();
  const room = (h: number) => {
    if (doc.y + h > bottom()) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
  };

  // head: title on the left, status pill on the right
  const status = STATUS_LABEL[q.status] ?? q.status;
  const pill = PILL[q.status] ?? { fill: c.surface, stroke: c.border, text: c.text };
  const pillW = measure(status, 'Inter-SemiBold', 8.5) + 18;
  const pillH = 17;
  const titleBottom = write(q.name ?? 'Quote', 'Montserrat-Bold', 21, c.text, left, 54, { width: width - pillW - 16, lineGap: 0 });
  doc.roundedRect(left + width - pillW, 56, pillW, pillH, pillH / 2).lineWidth(0.75).fillAndStroke(pill.fill, pill.stroke);
  write(status, 'Inter-SemiBold', 8.5, pill.text, left + width - pillW, 56 + 4.5, { width: pillW, align: 'center', lineBreak: false });
  doc.y = Math.max(titleBottom, 56 + pillH);

  // parties: label over value, side by side, under a light rule
  const contact = q.contact;
  const attention: [string | null, string | null] = !contact ? [null, null]
    : contact.name ? [contact.name, contact.email] : [contact.email, null];
  const parties = ([
    ['Prepared for', q.company, null],
    ['Attention', ...attention],
    ['Valid until', q.expiration_date ? day(q.expiration_date) : null, null]
  ] as [string, string | null, string | null][]).filter(([, value]) => value);
  if (parties.length) {
    doc.y += 18;
    hrule(doc.y, left, left + width, c.border);
    let x = left;
    let y = doc.y + 13;
    let rowBottom = y;
    const gap = 32;
    for (const [label, value, sub] of parties) {
      const w = Math.min(width, Math.max(measure(label, 'Inter', 8.5), measure(value!, 'Inter-Medium', 10), sub ? measure(sub, 'Inter', 10) : 0) + 1);
      if (x > left && x + w > left + width) {
        x = left;
        y = rowBottom + 10;
      }
      let yy = write(label, 'Inter', 8.5, c.muted_text, x, y, { width: w });
      yy = write(value!, 'Inter-Medium', 10, c.text, x, yy + 1, { width: w });
      if (sub) yy = write(sub, 'Inter', 10, c.muted_text, x, yy, { width: w });
      rowBottom = Math.max(rowBottom, yy);
      x += w + gap;
    }
    doc.y = rowBottom;
  }

  // the lines, as a ledger: one dark rule under the header, light rules between rows
  const cols = [
    { title: 'Item', w: width * 0.4, align: 'left' as const },
    { title: 'Qty', w: width * 0.1, align: 'right' as const },
    { title: 'Unit price', w: width * 0.17, align: 'right' as const },
    { title: 'Discount', w: width * 0.15, align: 'right' as const },
    { title: 'Amount', w: width * 0.18, align: 'right' as const }
  ];
  const pad = 7;
  // cell box: no outer padding on the first and last columns, like the page
  const cell = (i: number) => {
    const x = left + cols.slice(0, i).reduce((s, col) => s + col.w, 0);
    const l = i === 0 ? 0 : pad;
    const r = i === cols.length - 1 ? 0 : pad;
    return { x: x + l, w: cols[i].w - l - r };
  };
  const header = () => {
    const y = doc.y;
    cols.forEach((col, i) => write(col.title, 'Inter-Medium', 8.5, c.muted_text, cell(i).x, y, { width: cell(i).w, align: col.align, lineBreak: false }));
    doc.y = y + 15;
    hrule(doc.y, left, left + width, c.text);
  };
  if (q.lines.length) {
    doc.y += 26;
    header();
    for (const l of q.lines) {
      const cells: [string, Face][] = [
        [l.quantity === null ? '' : String(l.quantity), 'Inter'],
        [money(l.unit_price, q.currency), 'Inter'],
        [l.discount ? money(l.discount, q.currency) : '', 'Inter'],
        [money(l.amount, q.currency), 'Inter-SemiBold']
      ];
      const item = cell(0);
      style('Inter-Medium', 10, c.text, l.name ?? '');
      let h = doc.heightOfString(l.name ?? '', { width: item.w, lineGap: 1.5 });
      if (l.sku) h += 2 + (style('Inter', 8.5, c.muted_text, `SKU ${l.sku}`), doc.heightOfString(`SKU ${l.sku}`, { width: item.w, lineGap: 1.5 }));
      if (doc.y + h + 20 > bottom()) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        header();
      }
      const y = doc.y + 10;
      let yy = write(l.name ?? '', 'Inter-Medium', 10, c.text, item.x, y, { width: item.w });
      if (l.sku) yy = write(`SKU ${l.sku}`, 'Inter', 8.5, c.muted_text, item.x, yy + 2, { width: item.w });
      cells.forEach(([s, face], i) => {
        const box = cell(i + 1);
        write(s, face, 10, c.text, box.x, y, { width: box.w, align: 'right', lineBreak: false });
      });
      doc.y = Math.max(yy, y + 13) + 10;
      hrule(doc.y, left, left + width, c.border);
    }
  }

  // the total: right-aligned under the amounts, closed by a double rule
  {
    room(50);
    const amount = money(q.amount, q.currency) || 'n/a';
    const amountW = measure(amount, 'Montserrat-Bold', 20);
    const y = doc.y + 14;
    const amountX = left + width - amountW;
    write(amount, 'Montserrat-Bold', 20, c.text, amountX, y, { lineBreak: false });
    const labelW = measure('Total', 'Inter-Medium', 10);
    write('Total', 'Inter-Medium', 10, c.muted_text, amountX - 16 - 16 - labelW, y + 8, { lineBreak: false });
    const ruleY = y + 26;
    hrule(ruleY, amountX - 16, left + width, c.text, 0.9);
    hrule(ruleY + 2.4, amountX - 16, left + width, c.text, 0.9);
    doc.y = ruleY + 3;
  }

  // status note, as on the page
  const note = (kind: keyof typeof NOTE | null, main: string, extra?: string | null) => {
    const colors = kind ? NOTE[kind] : { fill: c.surface, bar: c.border, text: c.text };
    const w = width - 26;
    style('Inter', 10, colors.text, main);
    let h = doc.heightOfString(main, { width: w, lineGap: 1.5 });
    if (extra) h += 3 + (style('Inter', 10, c.muted_text, extra), doc.heightOfString(extra, { width: w, lineGap: 1.5 }));
    doc.y += 20;
    room(h + 20);
    const y = doc.y;
    doc.roundedRect(left, y, width, h + 20, 5).fill(colors.fill);
    doc.rect(left, y, 2.25, h + 20).fill(colors.bar);
    let yy = write(main, 'Inter', 10, colors.text, left + 14, y + 10, { width: w });
    if (extra) yy = write(extra, 'Inter', 10, c.muted_text, left + 14, yy + 3, { width: w });
    doc.y = y + h + 20;
  };
  if (q.status === 'accepted' || q.status === 'rejected') {
    const when = q.responded_at ? ` on ${day(q.responded_at)}` : '';
    note(q.status === 'accepted' ? 'good' : 'bad',
      `${q.status === 'accepted' ? 'Accepted' : 'Declined'} by ${q.responder_name ?? 'the customer'}${when}.`,
      q.status === 'rejected' && q.decline_reason ? `Reason: ${q.decline_reason}` : null);
  } else if (q.status === 'pending_countersign') {
    const when = q.customer_signed_at ? ` on ${utc(q.customer_signed_at)}` : '';
    note('wait', `Signed by ${q.responder_name ?? 'the customer'}${when}. We will countersign and confirm shortly.`);
  } else if (q.status === 'expired') {
    note(null, 'This quote has expired. Contact us if you would like an updated one.');
  }

  // signatures side by side, each on a signing line with an x, then the name and the signing time
  const blocks = [
    { title: 'Customer signature', png: q.customer_signature, who: q.responder_name, when: q.customer_signed_at },
    { title: 'Countersignature', png: q.countersigner_signature, who: q.countersigner_name, when: q.countersigned_at }
  ].filter((b) => b.png);
  if (blocks.length) {
    doc.y += 26;
    room(120);
    const top = doc.y;
    const gap = 32;
    const colW = Math.min(214, (width - gap) / 2);
    let lowest = top;
    blocks.forEach((b, i) => {
      const x = left + i * (colW + gap);
      let y = write(b.title, 'Inter-Medium', 8.5, c.muted_text, x, top, { width: colW });
      const imgH = 58;
      const lineY = y + 4 + imgH;
      try {
        doc.image(pngBytes(b.png!), x + 15, y + 4, { fit: [Math.min(174, colW - 15), imgH], valign: 'bottom' });
      } catch {
        write('(signature image could not be read)', 'Inter', 8.5, c.muted_text, x + 15, lineY - 14, { width: colW - 15 });
      }
      write('×', 'Inter', 12, c.muted_text, x, lineY - 15, { lineBreak: false });
      hrule(lineY, x, x + colW, c.text);
      y = lineY + 6;
      if (b.who) y = write(b.who, 'Inter-SemiBold', 10, c.text, x, y, { width: colW });
      if (b.when) y = write(`Signed ${utc(b.when)}`, 'Inter', 8.5, c.muted_text, x, y + 1, { width: colW });
      lowest = Math.max(lowest, y);
    });
    doc.y = lowest;
  }

  // the fields the customer filled in when signing: label and value pairs
  const answered = q.customer_signature ? q.signing_fields.filter((f) => q.signed_fields?.[f.key]) : [];
  if (answered.length) {
    doc.y += 14;
    const labelW = Math.min(width / 2, Math.max(...answered.map((f) => measure(f.label, 'Inter', 10))) + 1);
    for (const f of answered) {
      const value = q.signed_fields![f.key];
      style('Inter', 10, c.text, value);
      room(doc.heightOfString(value, { width: width - labelW - 14 }) + 4);
      const y = doc.y + 4;
      const a = write(f.label, 'Inter', 10, c.muted_text, left, y, { width: labelW });
      const b = write(value, 'Inter', 10, c.text, left + labelW + 14, y, { width: width - labelW - 14 });
      doc.y = Math.max(a, b);
    }
  }

  doc.end();
  return done;
}
