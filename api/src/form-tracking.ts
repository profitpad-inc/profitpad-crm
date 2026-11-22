// Campaign tracking parameters every form submission keeps. They are read
// from the page URL the form was submitted on and stored as properties of
// the same name on the submission (db/migrations/0115_form_tracking_params.sql).
// web/src/lib/form-tracking.ts has the same list for the form builder.
export const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'
] as const;

const MAX_LENGTH = 500;

// The tracking parameters in a page URL, trimmed, on one line and at most 500
// characters. Names match case-insensitively (UTM_Source); the first non-empty
// value wins. Parameters after # (single page apps: /#/page?utm_source=x)
// count when the query before # does not have them.
export function trackingFromUrl(pageUrl: string | null | undefined): Partial<Record<(typeof TRACKING_PARAMS)[number], string>> {
  if (!pageUrl) return {};
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return {};
  }
  const hashQuery = url.hash.indexOf('?');
  const sources = [url.searchParams, ...(hashQuery === -1 ? [] : [new URLSearchParams(url.hash.slice(hashQuery + 1))])];
  const wanted = new Set<string>(TRACKING_PARAMS);
  const out: Record<string, string> = {};
  for (const params of sources) {
    for (const [k, raw] of params) {
      const key = k.toLowerCase();
      if (!wanted.has(key) || out[key]) continue;
      const v = raw.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_LENGTH);
      if (v) out[key] = v;
    }
  }
  return out;
}
