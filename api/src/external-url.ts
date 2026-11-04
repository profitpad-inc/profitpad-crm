// Which links a custom view may open in a new tab (openUrl in the kit,
// stubbed by render_view here). Only absolute http: and https: addresses:
// javascript:, data:, blob:, file:, mailto: and anything else are refused, as
// are addresses with a user name or password in them (https://sam.gov@evil.example
// goes to evil.example). The CRM page (web/src/view-runtime/external-url.ts)
// applies the same rule; keep the two in step (external-url.test.ts checks both).

export const MAX_URL_LENGTH = 2048;

export type ExternalUrl = { ok: true; url: string; host: string } | { ok: false; error: string };

export function checkExternalUrl(raw: unknown): ExternalUrl {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'openUrl takes a web address as a string, like https://sam.gov' };
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH) return { ok: false, error: `openUrl takes addresses up to ${MAX_URL_LENGTH} characters` };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: `openUrl takes a full address starting with https:// (got "${text.slice(0, 100)}")` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `openUrl only opens http and https links, not ${u.protocol}` };
  if (u.username || u.password) return { ok: false, error: 'openUrl does not open addresses with a user name or password in them' };
  if (!u.hostname) return { ok: false, error: 'openUrl needs an address with a domain' };
  // hostname is already lower case, and punycode for international names, so
  // a look-alike domain shows as xn--... in the confirmation
  return { ok: true, url: u.href, host: u.hostname };
}

