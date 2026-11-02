import PDFDocument from 'pdfkit';
import type { PublicQuote } from '../routes/public.js';

// A one-file PDF of a quote, as the customer sees it on /p/quote/. Uses
// pdfkit's built-in Helvetica, so nothing is loaded from disk.

const money = (v: number | null, currency: string | null) =>
  v === null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(v);

const STATUS_LABEL: Record<string, string> = {
  sent: 'Open', pending_countersign: 'Awaiting countersignature', accepted: 'Accepted', rejected: 'Declined', expired: 'Expired'
};

const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
// signing times are shown in UTC, to the second: 2026-11-02 14:05:33 UTC
const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

// "data:image/png;base64,..." -> PNG bytes pdfkit can draw
const pngBytes = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

export function renderQuotePdf(q: PublicQuote, theme: Record<string, string>): Promise<Buffer> {
  const accent = theme.primary ?? '#1f7a74';
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: q.name ?? 'Quote' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  doc.fillColor(accent).font('Helvetica-Bold').fontSize(22).text(q.name ?? 'Quote', left, 54, { width });
  doc.moveDown(0.3).fillColor('#555555').font('Helvetica').fontSize(10);
  const meta = [
    `Status: ${STATUS_LABEL[q.status] ?? q.status}`,
    q.expiration_date ? `Valid until: ${q.expiration_date}` : null,
    q.company ? `For: ${q.company}` : null,
    q.contact?.name ? `Attention: ${q.contact.name}${q.contact.email ? ` (${q.contact.email})` : ''}` : null
  ].filter(Boolean) as string[];
  for (const line of meta) doc.text(line, { width });

  // line items
  const cols = [
    { title: 'Item', w: width * 0.4, align: 'left' as const },
    { title: 'Qty', w: width * 0.12, align: 'right' as const },
    { title: 'Unit price', w: width * 0.16, align: 'right' as const },
    { title: 'Discount', w: width * 0.14, align: 'right' as const },
    { title: 'Amount', w: width * 0.18, align: 'right' as const }
  ];
  const row = (cells: string[], bold = false) => {
    const y = doc.y;
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#111111');
    let bottom = y;
    cells.forEach((c, i) => {
      doc.text(c, x + 4, y, { width: cols[i].w - 8, align: cols[i].align });
      bottom = Math.max(bottom, doc.y);
      x += cols[i].w;
    });
    doc.x = left;
    doc.y = bottom + 6;
  };
  const rule = (color = '#dddddd') => {
    doc.moveTo(left, doc.y - 3).lineTo(left + width, doc.y - 3).strokeColor(color).lineWidth(0.75).stroke();
  };

  doc.moveDown(1.5);
  if (q.lines.length) {
    row(cols.map((c) => c.title), true);
    rule(accent);
    for (const l of q.lines) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      row([
        [l.name, l.sku ? `SKU ${l.sku}` : null].filter(Boolean).join('\n') || '',
        l.quantity === null ? '' : String(l.quantity),
        money(l.unit_price, q.currency),
        l.discount ? money(l.discount, q.currency) : '',
        money(l.amount, q.currency)
      ]);
      rule();
    }
  }

  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(13).fillColor('#111111')
    .text(`Total: ${money(q.amount, q.currency) || 'n/a'}`, left, doc.y, { width, align: 'right' });

  if (q.status === 'accepted' || q.status === 'rejected') {
    doc.moveDown(1.5).font('Helvetica').fontSize(10).fillColor('#555555');
    const when = day(q.responded_at);
    doc.text(`${q.status === 'accepted' ? 'Accepted' : 'Declined'} by ${q.responder_name ?? 'the customer'}${when ? ` on ${when}` : ''}.`, { width });
    if (q.status === 'rejected' && q.decline_reason) doc.text(`Reason: ${q.decline_reason}`, { width });
  }

  // signatures: the customer's (with the fields they filled in), then staff
  const signature = (title: string, png: string, who: string | null, when: string | null) => {
    if (doc.y > doc.page.height - 200) doc.addPage();
    doc.moveDown(1).font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(title, left, doc.y, { width });
    doc.moveDown(0.3);
    try {
      doc.image(pngBytes(png), left, doc.y, { fit: [260, 80] });
      doc.y += 84;
    } catch {
      doc.font('Helvetica').fontSize(10).fillColor('#555555').text('(signature image could not be read)', left, doc.y, { width });
    }
    rule();
    doc.font('Helvetica').fontSize(10).fillColor('#555555')
      .text([who, when ? `Signed ${utc(when)}` : null].filter(Boolean).join(', '), left, doc.y, { width });
  };
  if (q.customer_signature) {
    signature('Customer signature', q.customer_signature, q.responder_name, q.customer_signed_at);
    const answered = q.signing_fields.filter((f) => q.signed_fields?.[f.key]);
    if (answered.length) {
      doc.moveDown(0.5);
      for (const f of answered) doc.text(`${f.label}: ${q.signed_fields![f.key]}`, left, doc.y, { width });
    }
  }
  if (q.countersigner_signature) signature('Countersignature', q.countersigner_signature, q.countersigner_name, q.countersigned_at);

  doc.end();
  return done;
}
