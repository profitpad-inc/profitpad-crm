// Guests a visitor adds to a booked meeting: extra email addresses that go on
// the calendar invite next to the visitor's own (booking page "Guests allowed").

import { badRequest } from '../errors.js';
import { isGmailTypo } from '../email-typo.js';

export const MAX_GUESTS = 20;
const GUEST_EMAIL_RE = /^(?!.*\.\.)[^@\s<>(),;:"[\]\\]+@[^@\s<>(),;:"[\]\\]+\.[^@\s<>(),;:"[\]\\]+$/;

// The guests a visitor added: a list of email addresses, checked like the
// composer's (format, length, Gmail typos), lower cased, duplicates and the
// visitor's own address dropped, at most the page's limit.
export function readGuests(raw: unknown, max: number, attendeeEmail: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) throw badRequest('guests must be a list of email addresses', { field: 'guests' });
  const own = attendeeEmail.trim().toLowerCase();
  const out: string[] = [];
  for (const g of raw as string[]) {
    const email = g.trim().toLowerCase();
    if (!email) continue;
    if (email.length > 254 || !GUEST_EMAIL_RE.test(email)) throw badRequest(`${g.trim()} is not a valid email address.`, { field: 'guests' });
    if (isGmailTypo(email)) throw badRequest(`${g.trim()}: did you mean @gmail.com? Please check the address.`, { field: 'guests' });
    if (email !== own && !out.includes(email)) out.push(email);
  }
  if (out.length > max) {
    throw badRequest(max === 0 ? 'This booking page does not take guests.' : `You can add up to ${max} guest${max === 1 ? '' : 's'}.`, { field: 'guests' });
  }
  return out;
}
