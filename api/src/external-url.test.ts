import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExternalUrl } from './external-url.js';
// the CRM page's copy, which really opens the tabs: both must agree
import { checkExternalUrl as pageCheck, hasScheme } from '../../web/src/view-runtime/external-url.js';

const opens: [string, string, string][] = [
  ['https://sam.gov/opp/123/view', 'https://sam.gov/opp/123/view', 'sam.gov'],
  ['  http://Partner.Example.com/a?b=1#c ', 'http://partner.example.com/a?b=1#c', 'partner.example.com'],
  ['https://bücher.example/', 'https://xn--bcher-kva.example/', 'xn--bcher-kva.example'],
  ['HTTPS://SAM.GOV', 'https://sam.gov/', 'sam.gov']
];
const refused = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  ' javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'blob:https://crm.example/1234',
  'file:///etc/passwd',
  'mailto:someone@example.com',
  'ftp://example.com/x',
  '/objects/deals',
  'sam.gov',
  '//sam.gov/x',
  'https://sam.gov@evil.example/',
  'https://user:pw@sam.gov/',
  '',
  '   ',
  `https://example.com/${'a'.repeat(2048)}`
];

for (const [name, check] of [['api', checkExternalUrl], ['page', pageCheck]] as const) {
  test(`${name}: opens http and https addresses, normalized`, () => {
    for (const [raw, url, host] of opens) assert.deepEqual(check(raw), { ok: true, url, host }, raw);
  });
  test(`${name}: refuses other schemes, relative paths and credentials`, () => {
    for (const raw of refused) assert.equal(check(raw).ok, false, raw);
    for (const raw of [null, undefined, 42, {}, ['https://sam.gov']]) assert.equal(check(raw).ok, false, String(raw));
  });
  test(`${name}: explains a refused scheme`, () => {
    const r = check('javascript:alert(1)');
    assert.ok(!r.ok && /only opens http and https/.test(r.error));
  });
}

test('page: hands links with a scheme to openUrl, leaves relative ones', () => {
  for (const href of ['https://sam.gov', 'javascript:void(0)', 'mailto:a@b.c', 'HTTP://x']) assert.equal(hasScheme(href), true, href);
  for (const href of ['#top', '/objects/deals', 'page.html', '?a=1', '']) assert.equal(hasScheme(href), false, href);
});
