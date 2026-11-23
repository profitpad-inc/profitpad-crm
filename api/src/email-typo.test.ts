import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGmailTypo } from './email-typo.js';

test('one typo away from gmail.com is refused', () => {
  for (const e of ['a@gmail.co', 'a@gnail.com', 'a@gmial.com', 'a@gmaill.com', 'a@gmai.com', 'A@GMAIL.CO', 'a@gmail.cm']) assert.equal(isGmailTypo(e), true, e);
});

test('real addresses pass', () => {
  for (const e of ['a@gmail.com', 'a@mail.com', 'a@email.com', 'a@hotmail.com', 'a@profitpad.com', 'a@gmx.com', 'nonsense']) assert.equal(isGmailTypo(e), false, e);
});
