import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPageUrl, isBot, readVisitorId } from './page-views.js';

test('visitor ids are v4 UUIDs, lower cased', () => {
  assert.equal(readVisitorId('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  assert.equal(readVisitorId('not-an-id'), null);
  assert.equal(readVisitorId('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), null); // v1
  assert.equal(readVisitorId(42), null);
});

test('page addresses drop the #part and credentials, http(s) only', () => {
  assert.equal(cleanPageUrl('https://a:b@example.com/pricing?utm_source=x#top')?.href, 'https://example.com/pricing?utm_source=x');
  assert.equal(cleanPageUrl('javascript:alert(1)'), null);
  assert.equal(cleanPageUrl('not a url'), null);
  assert.equal(cleanPageUrl(`https://example.com/${'a'.repeat(2100)}`), null);
});

test('bots and empty user agents are skipped', () => {
  assert.equal(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)'), true);
  assert.equal(isBot('Mozilla/5.0 HeadlessChrome/120'), true);
  assert.equal(isBot(undefined), true);
  assert.equal(isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15'), false);
});

test('the tracking params are the form submission list (one column each in 0132)', async () => {
  const { readFileSync } = await import('node:fs');
  const { TRACKING_PARAMS } = await import('./form-tracking.js');
  const sql = readFileSync(new URL('../../db/migrations/0132_page_views.sql', import.meta.url), 'utf8');
  for (const k of TRACKING_PARAMS) assert.match(sql, new RegExp(`\\n  ${k} text check`), `${k} column`);
});
