// How the CRM shows dates and datetimes ("Oct 30, 2026" and "Oct 30, 2026,
// 2:13 PM" in the viewer's locale). Shared by record values (display.tsx) and
// the date picker's box when it is not being edited (DatePicker.tsx), which
// also runs in the custom view frame, so this file imports nothing.
export const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
export const dateTimeFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// "2026-10-30" (a date, read as UTC so it never shifts a day) or
// "2026-10-30T14:13" (local time) as shown; anything unreadable as it is.
export function friendlyDate(value: string, withTime = false): string {
  if (!value) return '';
  const d = withTime ? new Date(value) : new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? value : (withTime ? dateTimeFmt : dateFmt).format(d);
}
