import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublic, isPublicAddress, publicHttpsUrl } from './safe-fetch.js';

test('isPublicAddress: private, loopback, link-local, metadata and mapped addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::a00:1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '142.250.72.14', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress('not an ip'), false);
});

test('publicHttpsUrl: https on a named host only', () => {
  assert.ok(publicHttpsUrl('https://example.com/a.png'));
  assert.equal(publicHttpsUrl('http://example.com/'), null);
  assert.equal(publicHttpsUrl('https://127.0.0.1/'), null);
  assert.equal(publicHttpsUrl('https://localhost/'), null);
  assert.equal(publicHttpsUrl('https://web/'), null);
  assert.equal(publicHttpsUrl('file:///etc/passwd'), null);
});

test('fetchPublic: a name that resolves to an inside address is refused at connect time', async () => {
  // localtest.me and its subdomains resolve to 127.0.0.1 (public DNS); skip when offline
  await assert.rejects(fetchPublic('https://localtest.me/', { timeoutMs: 5000 }), (e: Error & { code?: string }) =>
    e.code === 'EADDRNOTPUBLIC' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN');
});
