import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PropertyDef } from './registry.js';
import { formatProperty, showable } from './quote-document.js';
import { renderQuotePdf } from './pdf/quote.js';
import type { PublicQuote } from './routes/public.js';

const prop = (over: Partial<PropertyDef>): PropertyDef => ({
  pc_0002_id: 'pc_x', object_type_id: 'pc_0022', api_name: 'x', label: 'X', description: null, type: 'text', options: {},
  calc_sql: null, calc_output_type: null, calc_last_error: null, is_base: false, is_native: false, read_only: false,
  record_status: 'active', dropdown_options: [], ...over
});
const option = (api_value: string, label: string) => ({
  api_value, label, display_order: 1, record_status: 'active', parent_values: [], is_closed: false, is_won: false, probability: null, color: null
});

test('dropdowns show their labels', () => {
  const p = prop({ type: 'dropdown', dropdown_options: [option('true', 'Yes'), option('us', 'United States')] });
  assert.equal(formatProperty(p, ['true'], {}, null), 'Yes');
  assert.equal(formatProperty(p, ['true', 'us', 'zz'], {}, null), 'Yes, United States, zz');
});

test('currency numbers use the record currency, then the document currency, then the fixed one', () => {
  const p = prop({ type: 'number', options: { format: 'currency', currency_code: 'USD', currency_property: 'currency' } });
  assert.equal(formatProperty(p, '1240', { currency: ['EUR'] }, 'CAD'), '€1,240.00');
  assert.equal(formatProperty(p, '1240', {}, 'CAD'), 'CA$1,240.00');
  assert.equal(formatProperty(p, '1240', {}, null), '$1,240.00');
});

test('numbers, percentages, dates, datetimes and phones', () => {
  assert.equal(formatProperty(prop({ type: 'number', options: { suffix: ' lb' } }), '1860.5', {}, null), '1,860.5 lb');
  assert.equal(formatProperty(prop({ type: 'number', options: { format: 'percentage' } }), '0.125', {}, null), '12.5%');
  assert.equal(formatProperty(prop({ type: 'date' }), '2026-12-15', {}, null), 'December 15, 2026');
  assert.equal(formatProperty(prop({ type: 'datetime' }), new Date('2026-12-15T14:05:00Z'), {}, null), 'December 15, 2026 at 2:05 PM UTC');
  assert.equal(formatProperty(prop({ type: 'text', options: { display: 'phone' } }), '+18882345678ext9', {}, null), '+1 888-234-5678 ext9');
  assert.equal(formatProperty(prop({ type: 'calculation', calc_output_type: 'number', options: { decimals: 0 } }), '42.4', {}, null), '42');
  assert.equal(formatProperty(prop({}), null, {}, null), '');
});

test('secrets, signatures and files are never showable', () => {
  assert.equal(showable(prop({ api_name: 'public_key' })), false);
  assert.equal(showable(prop({ api_name: 'customer_signature' })), false);
  assert.equal(showable(prop({ type: 'file' })), false);
  assert.equal(showable(prop({ record_status: 'archived' })), false);
  assert.equal(showable(prop({ api_name: 'payment_terms' })), true);
});

test('the PDF draws configured columns, details, terms and tables', async () => {
  const q: PublicQuote = {
    id: 'x', name: 'Quote', status: 'sent', expiration_date: '2026-12-15', amount: 100, currency: 'USD', responded_at: null,
    responder_name: null, decline_reason: null, company: 'Acme', contact: null,
    lines: Array.from({ length: 40 }, (_, i) => ({ name: `Line ${i}`, sku: null, quantity: 1, unit_price: 100, discount: null, amount: 100, extra: { lead_time: '4 weeks' } })),
    layout: {
      orientation: 'landscape', item: { label: 'Item', width: 30 },
      columns: [
        { key: 'quantity', label: 'Qty', width: 8, align: 'right', builtin: true },
        { key: 'lead_time', label: 'Lead time', width: 12, align: 'left', builtin: false },
        { key: 'amount', label: 'Amount', width: 15, align: 'right', builtin: true }
      ],
      details: [{ label: 'Payment terms', value: 'Net 30', wide: false }],
      terms_title: 'Terms',
      terms: [{ label: 'Notes', value: 'FOB destination.\nPartial shipments allowed.', wide: true }],
      tables: [{ title: 'Kit', columns: [{ label: 'Part', width: 1, align: 'left' }], rows: [['Radio']] }]
    },
    signing_fields: [], signed_fields: null, customer_signature: null, customer_signed_at: null, requires_countersign: false,
    countersigner_name: null, countersigner_signature: null, countersigned_at: null, payment: null
  };
  const pdf = await renderQuotePdf(q, {});
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  // landscape letter: 792 wide
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 792 612\]/);
});
