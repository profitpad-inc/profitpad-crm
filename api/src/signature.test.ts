import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSignature } from './signature.js';

test('signatures keep layout, styles, links and web images', () => {
  const html = '<table cellpadding="0"><tr><td style="color:#333"><b>Sam</b><br><a href="https://example.com">example.com</a></td>'
    + '<td><img src="https://api.example.com/files/abc/logo.png" alt="Logo" width="120"></td></tr></table>';
  assert.equal(cleanSignature(html), html.replace('<br>', '<br />').replace('width="120">', 'width="120" />'));
});

test('signatures lose scripts, handlers, frames, forms and non-web images', () => {
  const out = cleanSignature('<p onclick="x()">Hi</p><script>alert(1)</script><iframe src="https://x.com"></iframe>'
    + '<form><input name="a"></form><img src="data:image/png;base64,AAAA"><img src="cid:logo"><a href="javascript:alert(1)">x</a>')!;
  assert.doesNotMatch(out, /script|onclick|iframe|form|input|data:|cid:|javascript:/i);
  assert.match(out, /<p>Hi<\/p>/);
});

test('an empty signature is null', () => {
  assert.equal(cleanSignature('  <script>x</script> '), null);
});
