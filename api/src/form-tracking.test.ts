import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKING_PARAMS, trackingFromUrl } from './form-tracking.js';
import { TRACKING_PARAMS as builderList } from '../../web/src/lib/form-tracking.js';

test('the form builder lists the same parameters', () => {
  assert.deepEqual([...builderList], [...TRACKING_PARAMS]);
});

test('reads tracking parameters from the page URL', () => {
  assert.deepEqual(
    trackingFromUrl('https://example.com/demo?utm_source=google&utm_medium=cpc&gclid=abc123&topic=Sales'),
    { utm_source: 'google', utm_medium: 'cpc', gclid: 'abc123' }
  );
});

test('names match in any case, values are trimmed, empty ones dropped', () => {
  assert.deepEqual(trackingFromUrl('https://example.com/?UTM_Source=%20news%20&utm_term=&fbclid=x'), { utm_source: 'news', fbclid: 'x' });
});

test('the first non-empty value wins, the query before the hash first', () => {
  assert.deepEqual(trackingFromUrl('https://example.com/?utm_campaign=&utm_campaign=spring#/p?utm_campaign=other&msclkid=m1'), {
    utm_campaign: 'spring', msclkid: 'm1'
  });
});

test('values stay on one line and at most 500 characters', () => {
  const r = trackingFromUrl(`https://example.com/?utm_content=a%0Ab&ttclid=${'x'.repeat(600)}`);
  assert.equal(r.utm_content, 'a b');
  assert.equal(r.ttclid?.length, 500);
});

test('no URL, or not a URL, gives nothing', () => {
  assert.deepEqual(trackingFromUrl(null), {});
  assert.deepEqual(trackingFromUrl('not a url'), {});
});
