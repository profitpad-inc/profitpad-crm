import lib from 'google-libphonenumber';

// Phone numbers, checked with Google's libphonenumber. Numbers without a
// country code are read as Canadian (+1, same plan as the US). Valid numbers
// are stored as E.164 plus an optional extension, "+16132220328ext4", and
// shown as "+1 613-222-0328 ext4". Used for text properties with display
// "phone" (every write, see values.ts), form fields with the phone format
// (forms.ts), and POST /v1/phone/validate.

const util = lib.PhoneNumberUtil.getInstance();
export const DEFAULT_REGION = 'CA';

export interface PhoneCheck {
  input: string;
  valid: boolean;
  // stored form, e.g. +16132220328ext4
  value: string | null;
  // shown form, e.g. +1 613-222-0328 ext4
  display: string | null;
  e164: string | null;
  extension: string | null;
  region: string | null;
  type: string | null;
  // why it is not valid
  reason: string | null;
}

const TYPES = Object.fromEntries(Object.entries(lib.PhoneNumberType).map(([k, v]) => [v, k.toLowerCase()]));
const REASONS: Record<number, string> = {
  [lib.PhoneNumberUtil.ValidationResult.INVALID_COUNTRY_CODE]: 'the country code is not valid',
  [lib.PhoneNumberUtil.ValidationResult.TOO_SHORT]: 'the number is too short',
  [lib.PhoneNumberUtil.ValidationResult.TOO_LONG]: 'the number is too long',
  [lib.PhoneNumberUtil.ValidationResult.INVALID_LENGTH]: 'the number has the wrong length'
};

export function checkPhone(input: string, region: string = DEFAULT_REGION): PhoneCheck {
  const invalid = (reason: string): PhoneCheck => ({ input, valid: false, value: null, display: null, e164: null, extension: null, region: null, type: null, reason });
  const raw = input.trim();
  if (!raw) return invalid('the number is empty');
  if (raw.length > 64) return invalid('the number is too long');
  let n: lib.PhoneNumber;
  try {
    n = util.parse(raw, region);
  } catch {
    return invalid('this does not look like a phone number');
  }
  if (!util.isValidNumber(n)) {
    return invalid(REASONS[util.isPossibleNumberWithReason(n)] ?? 'this is not a valid phone number');
  }
  const extension = n.getExtension() || null;
  const bare = n.clone();
  bare.clearExtension();
  const e164 = util.format(bare, lib.PhoneNumberFormat.E164);
  return {
    input,
    valid: true,
    value: `${e164}${extension ? `ext${extension}` : ''}`,
    display: `${util.format(bare, lib.PhoneNumberFormat.INTERNATIONAL)}${extension ? ` ext${extension}` : ''}`,
    e164,
    extension,
    region: util.getRegionCodeForNumber(n) ?? null,
    type: TYPES[util.getNumberType(n)] ?? null,
    reason: null
  };
}

// Region codes the library knows (for validating the optional region).
export const isRegion = (r: string) => (util.getSupportedRegions() as string[]).includes(r);

// Every region the library knows, with its calling code, for country pickers
// (the browser adds names with Intl.DisplayNames).
// main: the region a +code number is read as when nothing else says (GB for +44).
export function phoneRegions(): { region: string; code: number; main: boolean }[] {
  return (util.getSupportedRegions() as string[]).map((region) => {
    const code = util.getCountryCodeForRegion(region);
    return { region, code, main: util.getRegionCodeForCountryCode(code) === region };
  });
}
