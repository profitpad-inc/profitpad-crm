import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barcodeDataUrl, imageData, inlineImages, parseSources } from './templates.js';

test('data sources: SQL gets :record_id built in, integrations kept, names checked', () => {
  const s = parseSources({
    lines: { sql: 'select 1 as n from view_data.quotes where pc_0022_id = :record_id' },
    rate: { integration: 'fx-rate', data: { quote: '{{ quote.name }}' } }
  });
  assert.deepEqual(s.queries.lines.params, { record_id: 'text' });
  assert.equal(s.integrations.rate.integration, 'fx-rate');
  assert.throws(() => parseSources({ Bad: { sql: 'select 1' } }), /lowercase/);
  assert.throws(() => parseSources({ q: { sql: 'select :other' } }), /not in its params/);
  assert.throws(() => parseSources('{nope'), /JSON/);
  assert.deepEqual(parseSources(''), { queries: {}, integrations: {} });
});

test('barcodes are drawn here: linear ones stretch, 2D ones keep their shape', () => {
  const svg = (u: string) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64').toString();
  const line = barcodeDataUrl('code128', 'S2741474.0001');
  assert.match(line, /^data:image\/svg\+xml;base64,/);
  assert.match(svg(line), /preserveAspectRatio="none"/);
  assert.doesNotMatch(svg(barcodeDataUrl('qrcode', 'hello')), /preserveAspectRatio/);
  assert.throws(() => barcodeDataUrl('ean13', 'not digits'), /barcode ean13/);
  assert.throws(() => barcodeDataUrl('../x', '1'), /unknown barcode type/);
});

test('barcode addresses become data URLs in the page; unreachable images are left and reported', async () => {
  assert.match(String(await imageData('https://barcode.invalid/code39?text=ABC&amp;height=8')), /^data:image\/svg\+xml/);
  const warnings: string[] = [];
  const html = await inlineImages(
    '<img src="https://barcode.invalid/qrcode?text=Q-1"><div style="background:url(https://localhost/x.png)"></div>',
    warnings
  );
  assert.match(html, /<img src="data:image\/svg\+xml;base64,/);
  // a private address is refused, so it stays as written and the builder is told
  assert.match(html, /url\(https:\/\/localhost\/x\.png\)/);
  assert.equal(warnings.length, 1);
});
