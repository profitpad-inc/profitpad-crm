// Phone properties store +18882345678ext9 (the API checks them with Google's
// libphonenumber). Shown as +1 888-234-5678 ext9; other countries keep the
// stored digits, since grouping them needs the library's metadata. Shared by
// record values (display.tsx) and the custom view kit (formatPhone), which
// runs in the view frame, so this file imports nothing.
export function displayPhone(v: string): string {
  const m = /^\+(\d+?)(?:ext(\d+))?$/.exec(v);
  if (!m) return v;
  const [, digits, ext] = m;
  const main = digits.length === 11 && digits.startsWith('1')
    ? `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`
    : `+${digits}`;
  return ext ? `${main} ext${ext}` : main;
}
