import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, wordsFromTsv, wordsToLines } from './card-parse.js';

// Line lists are what Tesseract read off phone photos of the synthetic cards in scripts/card-bench.

test('a classic card: company, name, title, two phones, address', () => {
  const f = parseCard([
    'NORTHGATE AVIONICS', 'Dana Whitfield', 'Director of Business Development', 'Direct +1 613 555 0142', 'Mobile +1 613 555 0199',
    '1200 Merivale Road, Suite 400', 'Ottawa, ON K2C 3P4', 'dana.whitfield@northgateavionics.com', 'Canada', 'northgateavionics.com'
  ]);
  assert.equal(f.first_name, 'Dana');
  assert.equal(f.last_name, 'Whitfield');
  assert.equal(f.job_title, 'Director of Business Development');
  assert.equal(f.company, 'NORTHGATE AVIONICS');
  assert.equal(f.email, 'dana.whitfield@northgateavionics.com');
  assert.equal(f.phone, '+1 613-555-0142');
  assert.deepEqual(f.other_phones, [{ label: 'Mobile', number: '+1 613 555 0199' }]);
  assert.equal(f.website, 'northgateavionics.com');
  assert.equal(f.address_street_1, '1200 Merivale Road, Suite 400');
  assert.equal(f.address_city, 'Ottawa');
  assert.equal(f.address_province, 'ON');
  assert.equal(f.address_postalcode, 'K2C 3P4');
  assert.equal(f.address_country, 'CA');
  assert.equal(f.is_business_card, true);
});

test('a two-column card: the name split over lines that are not next to each other', () => {
  const f = parseCard([
    'Rebecca', 'Office 202-555-0154 ext. 312', 'Lindqvist', 'Mobile 202-555-0193', 'rebecca.lindqvist@corvane.com',
    'Account Executive, Federal', 'corvane.com', '1100 New York Ave NW', 'Corvane Data', 'Washington, DC 20005'
  ]);
  assert.equal(f.first_name, 'Rebecca');
  assert.equal(f.last_name, 'Lindqvist');
  assert.equal(f.job_title, 'Account Executive, Federal');
  assert.equal(f.company, 'Corvane Data');
  assert.match(f.phone, /202-555-0154/);
  assert.equal(f.address_street_1, '1100 New York Ave NW');
  assert.equal(f.address_city, 'Washington');
  assert.equal(f.address_province, 'DC');
});

test('logo junk before the company, city and state without a postal code', () => {
  const f = parseCard(['A) quillon analytics', 'Oliver Pemberton-Hayes', 'Head of Partnerships', '+1 646 555 0138', 'oliver.ph@quillon.co', 'quillon.co', 'New York, NY']);
  assert.equal(f.company, 'quillon analytics');
  assert.equal(f.first_name, 'Oliver');
  assert.equal(f.last_name, 'Pemberton-Hayes');
  assert.equal(f.address_city, 'New York');
  assert.equal(f.address_province, 'NY');
  assert.equal(f.address_postalcode, '');
});

test('a rank stays out of the name; the street shares a line with the city', () => {
  const f = parseCard([
    'US ARMY PEO SENSORS', 'Col. Andrew Mercer', 'Program Executive Officer', '6001 Combat Drive - Aberdeen Proving Ground, MD 21005',
    'Comm (410) 555-0124 DSN 312-555-0124', 'andrew.j.mercer.mil@army.mil'
  ]);
  assert.equal(f.first_name, 'Andrew');
  assert.equal(f.last_name, 'Mercer');
  assert.equal(f.job_title, 'Program Executive Officer');
  assert.equal(f.address_city, 'Aberdeen Proving Ground');
  assert.equal(f.address_street_1, '6001 Combat Drive');
  assert.match(f.phone, /410/);
  assert.deepEqual(f.other_phones.map((p) => p.label), ['Dsn']);
});

test('no comma between city and province', () => {
  const f = parseCard(['Elise', '403-555-0172', 'Fontaine', 'efontaine@vireo-instruments.com', 'vireo-instruments.com', 'Marketing Coordinator', '700 2 St SW', 'Vireo Instruments', 'Calgary,AB T2P 2W2', 'Canada']);
  assert.equal(f.first_name, 'Elise');
  assert.equal(f.last_name, 'Fontaine');
  assert.equal(f.company, 'Vireo Instruments');
  assert.equal(f.address_city, 'Calgary');
  assert.equal(f.address_province, 'AB');
  assert.equal(f.address_postalcode, 'T2P 2W2');
});

test('a photo with no card on it', () => {
  const f = parseCard(['Lorem', 'ipsum dolor']);
  assert.equal(f.is_business_card, false);
});

test('TSV words become lines, a wide gap splits a row into two', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t10\t10\t60\t20\t96\tDana',
    '5\t1\t1\t1\t1\t2\t80\t10\t90\t20\t95\tWhitfield',
    '5\t1\t1\t1\t1\t3\t600\t12\t120\t20\t91\tDirect',
    '5\t1\t1\t1\t2\t1\t10\t40\t60\t20\t12\t~~',
    '5\t1\t1\t1\t2\t2\t10\t70\t60\t20\t90\tCEO'
  ].join('\n');
  const lines = wordsToLines(wordsFromTsv(tsv));
  assert.deepEqual(lines.map((l) => l.text), ['Dana Whitfield', 'Direct', 'CEO']);
});

test('phones read off a card come back formatted, "×" extensions included', async () => {
  const { formatPhones } = await import('./card-scan.js');
  const f = parseCard(['Dana Whitfield', 'dana@northgate.example', 'T 1 888 706 7227 × 703', 'F 613.555.0148']);
  f.phone = '1 888 706 7227 × 703';
  f.address_country = 'GB';
  formatPhones(f);
  assert.equal(f.phone, '+1 888-706-7227 ext703');
  assert.equal(f.other_phones[0]?.number, '+1 613-555-0148');
});

test('card corners from Claude: kept when they make a card, dropped otherwise', async () => {
  const { cardCorners } = await import('./card-scan.js');
  const pt = (x: number, y: number) => ({ x, y });
  const tilted = { top_left: pt(0.2, 0.25), top_right: pt(0.82, 0.2), bottom_right: pt(0.85, 0.7), bottom_left: pt(0.18, 0.75) };
  assert.deepEqual(cardCorners(tilted), [pt(0.2, 0.25), pt(0.82, 0.2), pt(0.85, 0.7), pt(0.18, 0.75)]);
  // a point a little outside the photo is pulled to its edge
  assert.deepEqual(cardCorners({ ...tilted, top_left: pt(-0.05, 0.25) })?.[0], pt(0, 0.25));
  // the whole photo, a sliver, a mirrored order (would flip the image) and nothing: no crop
  assert.equal(cardCorners({ top_left: pt(0, 0), top_right: pt(1, 0), bottom_right: pt(1, 1), bottom_left: pt(0, 1) }), null);
  assert.equal(cardCorners({ top_left: pt(0.5, 0.5), top_right: pt(0.52, 0.5), bottom_right: pt(0.52, 0.52), bottom_left: pt(0.5, 0.52) }), null);
  assert.equal(cardCorners({ ...tilted, top_right: tilted.bottom_left, bottom_left: tilted.top_right }), null);
  assert.equal(cardCorners(null), null);
});
