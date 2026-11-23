import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';

// addresses are read when the module loads
process.env.UI_URL = 'https://crm.example.com';
process.env.PAGES_URL = 'https://pages.example.com';
const lp = await import('./landing-pages.js');

const row = (over: Partial<import('./landing-pages.js').LandingPageRow> = {}) => ({
  id: '00000000aa', name: 'Demo', slug: 'acme-demo', description: null, status: 'published' as const,
  draft_html: '<p>draft</p>', html: '<p>live</p>', published_at: new Date(), record_status: 'active', updated_at: new Date(), ...over
});

test('sameOriginAllowed: never on the CRM host, only on another host', () => {
  assert.equal(lp.sameOriginAllowed('crm.example.com'), false);
  assert.equal(lp.sameOriginAllowed('CRM.example.com'), false);
  assert.equal(lp.sameOriginAllowed(undefined), false);
  assert.equal(lp.sameOriginAllowed('pages.example.com'), true);
});

test('pageCsp: sandboxed, same-origin only when allowed, drafts framed by the CRM only', () => {
  const crm = lp.pageCsp(false, false);
  assert.match(crm, /^sandbox /);
  assert.match(crm, /allow-scripts/);
  assert.doesNotMatch(crm, /allow-same-origin/);
  assert.match(crm, /frame-ancestors \*/);
  assert.match(lp.pageCsp(true, false), /allow-same-origin/);
  assert.match(lp.pageCsp(false, true), /frame-ancestors 'self' https:\/\/crm\.example\.com$/);
});

test('preparePageHtml: helper script goes first in <head>, or at the top', () => {
  const withHead = lp.preparePageHtml('<!doctype html><html><head><title>x</title></head><body></body></html>');
  assert.match(withHead, /^<!doctype html><html><head><script data-pcrm-page>/);
  assert.match(withHead, /var UI="https:\/\/crm\.example\.com"/);
  assert.match(lp.preparePageHtml('<!DOCTYPE html><p>hi</p>'), /^<!DOCTYPE html><script data-pcrm-page>/);
  assert.match(lp.preparePageHtml('<p>hi</p>'), /^<script data-pcrm-page>[\s\S]*<\/script><p>hi<\/p>$/);
  // <header> is not <head>
  assert.match(lp.preparePageHtml('<header>x</header>'), /^<script data-pcrm-page>/);
});

test('draft links: signed for the page, refused when changed or for another page', () => {
  const page = row();
  const url = new URL(lp.draftHtmlUrl(page));
  assert.equal(url.origin, 'https://pages.example.com');
  assert.equal(url.pathname, '/v1/public/pages/acme-demo/html');
  const token = url.searchParams.get('draft')!;
  assert.equal(lp.draftTokenOk(page, token), true);
  assert.equal(lp.draftTokenOk(row({ id: '00000000bb' }), token), false);
  const [exp, sig] = token.split('.');
  assert.equal(lp.draftTokenOk(page, `${Number(exp) + 60}.${sig}`), false);
  assert.equal(lp.draftTokenOk(page, `${Math.floor(Date.now() / 1000) - 10}.${sig}`), false);
  assert.equal(lp.draftTokenOk(page, 'garbage'), false);
});

test('pageTitle: the <title>, else the name', () => {
  assert.equal(lp.pageTitle(row(), '<title> Acme &amp; Co\n demo </title>'), 'Acme & Co demo');
  assert.equal(lp.pageTitle(row(), '<p>no title</p>'), 'Demo');
  assert.equal(lp.publicPageOut(row()).html_url, 'https://pages.example.com/v1/public/pages/acme-demo/html');
});

test('renderRequestAllowed: https on named public hosts only', () => {
  assert.equal(lp.renderRequestAllowed('https://www.youtube.com/embed/x'), true);
  assert.equal(lp.renderRequestAllowed('data:image/png;base64,AAAA'), true);
  for (const bad of ['http://example.com/', 'https://api:3100/v1/x', 'https://localhost/', 'https://10.0.0.5/', 'https://[::1]/', 'https://db.internal/', 'https://u:p@example.com/', 'file:///etc/passwd']) {
    assert.equal(lp.renderRequestAllowed(bad), false, bad);
  }
});

test('helper script: valid JavaScript, bridges only the public form routes, loads embed.js from the CRM', () => {
  const html = lp.preparePageHtml('<p>x</p>');
  const code = html.match(/<script data-pcrm-page>([\s\S]*?)<\/script>/)![1];
  assert.doesNotThrow(() => new Script(code));
  assert.match(code, /\^\\\/v1\\\/public\\\/\(forms\|booking\|phone\)\\\//);
  assert.match(code, /UI\+'\/p\/embed\.js'/);
  // messages to the shell go only to the CRM's origin
  assert.match(code, /parent\.postMessage\(m,UI\|\|'\*'\)/);
});
