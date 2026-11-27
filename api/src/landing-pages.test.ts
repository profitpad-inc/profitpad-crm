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

test('sniffType: reads the file type from its first bytes', () => {
  assert.equal(lp.sniffType(Buffer.from('89504e470d0a1a0a0000', 'hex')), 'image/png');
  assert.equal(lp.sniffType(Buffer.from('ffd8ffe000104a46', 'hex')), 'image/jpeg');
  assert.equal(lp.sniffType(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(lp.sniffType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(lp.sniffType(Buffer.from('%PDF-1.7')), 'application/pdf');
  assert.equal(lp.sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(lp.sniffType(Buffer.from('<!doctype html>')), null);
});

test('shellWithHead: title, description, canonical and preview tags; noindex removed; text escaped', () => {
  const shell = '<!doctype html><html><head><meta name="robots" content="noindex" /><title>&#8203;</title></head><body></body></html>';
  const out = lp.shellWithHead(shell, row({
    slug: 'acme-demo', html: '<title>Acme &amp; Co</title><meta name="description" content="From the page">', meta_title: null, meta_description: null,
    og_image: 'https://cdn.example.com/og.png'
  }));
  assert.doesNotMatch(out, /noindex/);
  assert.match(out, /<title>Acme &amp; Co<\/title>/);
  assert.match(out, /<meta name="description" content="From the page">/);
  assert.match(out, /<link rel="canonical" href="https:\/\/crm\.example\.com\/p\/page\/acme-demo">/);
  assert.match(out, /og:image" content="https:\/\/cdn\.example\.com\/og\.png"/);
  assert.match(out, /summary_large_image/);
  const own = lp.shellWithHead(shell, row({ meta_title: 'Hi "there" <b>', meta_description: 'Ours', og_image: null }));
  assert.match(own, /<title>Hi &quot;there&quot; &lt;b&gt;<\/title>/);
  assert.match(own, /content="Ours"/);
  assert.doesNotMatch(own, /og:image/);
});

test('page addresses: path form is the url, hash form still given', () => {
  const out = lp.pageOut(row({ slug: 'acme-demo' }), false);
  assert.equal(out.url, 'https://crm.example.com/p/page/acme-demo');
  assert.equal(out.hash_url, 'https://crm.example.com/p/page/#acme-demo');
  assert.equal(out.url_path, '/p/page/acme-demo');
});

test('renderRequestAllowed: https on named public hosts only', () => {
  assert.equal(lp.renderRequestAllowed('https://fonts.googleapis.com/css2?family=Inter'), true);
  assert.equal(lp.renderRequestAllowed('https://fonts.gstatic.com/s/inter/v1/x.woff2'), true);
  assert.equal(lp.renderRequestAllowed('data:image/png;base64,AA'), true);
  assert.equal(lp.renderRequestAllowed('http://example.com/'), false);
  assert.equal(lp.renderRequestAllowed('https://10.0.0.1/'), false);
  assert.equal(lp.renderRequestAllowed('https://[::1]/'), false);
  assert.equal(lp.renderRequestAllowed('https://api:3100/'), false);
  assert.equal(lp.renderRequestAllowed('https://db.internal/'), false);
  assert.equal(lp.renderRequestAllowed('https://user:pw@example.com/'), false);
});

test('links carry the visitor address params on, not the CRM own ones', () => {
  const html = lp.preparePageHtml('<html><head></head></html>');
  const js = html.match(/<script data-pcrm-page>([\s\S]*?)<\/script>/)![1];
  const body = js.slice(js.indexOf('var CARRY=[];'), js.indexOf('function linkOf'));
  const carry = new Function('location', 'URLSearchParams', `${body}; return carry;`)(
    { search: '?utm_source=google&gclid=abc&draft=123.sig&x=1' }, URLSearchParams
  ) as (a: unknown) => void;
  const run = (href: string, keep = false) => {
    let h = href;
    carry({ getAttribute: () => h, setAttribute: (_: string, v: string) => { h = v; }, hasAttribute: () => keep });
    return h;
  };
  assert.equal(run('/p/page/pricing'), '/p/page/pricing?utm_source=google&gclid=abc&x=1');
  assert.equal(run('https://example.com/a?utm_source=mine#top'), 'https://example.com/a?utm_source=mine&gclid=abc&x=1#top');
  assert.equal(run('pricing.html'), 'pricing.html?utm_source=google&gclid=abc&x=1');
  for (const same of ['#section', 'mailto:a@b.com', 'tel:123', '']) assert.equal(run(same), same);
  assert.equal(run('/p/page/pricing', true), '/p/page/pricing');
});

test('links, mailto: and tel: included, open in the whole window, not the sandboxed frame', () => {
  const html = lp.preparePageHtml('<html><head></head></html>');
  const js = html.match(/<script data-pcrm-page>([\s\S]*?)<\/script>/)![1];
  const body = js.slice(js.indexOf('function linkOf'), js.indexOf('var BRIDGED='));
  let onClick: ((e: unknown) => void) | undefined;
  const document = { addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'click') onClick = fn; } };
  new Function('document', 'carry', 'UI', `${body}`)(document, () => {}, 'https://crm.example.com');
  const click = (href: string, target = '') => {
    const a = { target, getAttribute: () => href, setAttribute: () => {}, hasAttribute: () => false };
    onClick!({ target: { closest: () => a }, defaultPrevented: false });
    return a.target;
  };
  for (const href of ['mailto:a@b.com', 'tel:123', 'sms:123', 'https://example.com/', '/p/page/x']) assert.equal(click(href), '_top', href);
  assert.equal(click('#section'), '');
  assert.equal(click('javascript:void(0)'), '');
  assert.equal(click('mailto:a@b.com', '_blank'), '_blank');
});
