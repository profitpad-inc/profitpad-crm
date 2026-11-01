// Country pickers for phone numbers, on forms and in the CRM. The regions and
// calling codes come from the API (GET /v1/public/phone/regions, Google's
// libphonenumber data), names from the browser (Intl.DisplayNames). Numbers
// are only checked by the API: the picker just puts "+<code> " in front of a
// number typed without one, so the API reads it in that country.

export interface PhoneRegion {
  region: string;
  code: number;
  // the region a +code number is read as by default (GB for +44)
  main: boolean;
  name: string;
  flag: string;
}

export interface PhoneRegions {
  default: string;
  regions: PhoneRegion[];
}

const cache = new Map<string, Promise<PhoneRegions>>();

const flagOf = (region: string) =>
  /^[A-Z]{2}$/.test(region) ? String.fromCodePoint(...[...region].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';

export function loadPhoneRegions(apiBase: string): Promise<PhoneRegions> {
  let p = cache.get(apiBase);
  if (!p) {
    p = fetch(`${apiBase.replace(/\/$/, '')}/v1/public/phone/regions`, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`regions: ${r.status}`))))
      .then((data: { default: string; regions: { region: string; code: number; main: boolean }[] }) => {
        let names: Intl.DisplayNames | null = null;
        try {
          names = new Intl.DisplayNames(undefined, { type: 'region' });
        } catch {
          // older browsers: codes only
        }
        const regions = data.regions.map((r) => ({ ...r, name: names?.of(r.region) ?? r.region, flag: flagOf(r.region) }));
        // the default region first, then by name
        regions.sort((a, b) => (a.region === data.default ? -1 : b.region === data.default ? 1 : a.name.localeCompare(b.name)));
        return { default: data.default, regions };
      });
    p.catch(() => cache.delete(apiBase));
    cache.set(apiBase, p);
  }
  return p;
}

// In the open list: "🇨🇦 Canada +1". On the closed picker: the flag only
// (the region code where the system has no flag emoji for it).
export const regionLabel = (r: PhoneRegion) => `${r.flag} ${r.name} +${r.code}`.trim();
export const regionShort = (r: PhoneRegion | undefined) => (r ? r.flag || r.region : '');

// The SVG chevron drawn on selects in forms' FORM_CSS (the browser's own
// cannot be moved in from the edge). styles.css draws the same one for the app.
export const CARET = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%236b7280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

// The number as sent to the API: unchanged when it already starts with + (or
// is empty), else with the picked country's calling code in front.
export function composePhone(text: string, region: PhoneRegion | undefined): string {
  const t = text.trim();
  if (!t || t.startsWith('+') || !region) return t;
  return `+${region.code} ${t}`;
}

// The region to show for a number that starts with +: the current one when
// its code matches, else the main region for that code.
export function regionForNumber(text: string, list: PhoneRegion[], current: string): string | null {
  const digits = /^\+(\d{1,3})/.exec(text.trim().replace(/[\s().-]/g, ''))?.[1];
  if (!digits) return null;
  for (const len of [3, 2, 1]) {
    const code = Number(digits.slice(0, len));
    const matches = list.filter((r) => r.code === code);
    if (matches.length) return (matches.find((r) => r.region === current) ?? matches.find((r) => r.main) ?? matches[0]).region;
  }
  return null;
}
