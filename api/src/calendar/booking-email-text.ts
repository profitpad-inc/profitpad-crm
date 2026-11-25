// Booking emails: the page's settings and the emails' text. Pure, so it can
// be tested without a database (booking-emails.ts queues and sends them).

export type BookingEmailKind = 'confirmation' | 'reminder' | 'rescheduled' | 'cancelled';

export interface EmailSettings {
  // confirmation, moved and cancelled emails
  confirm: boolean;
  // reminders, minutes before the start (longest first)
  reminders: number[];
  // a few lines from the host, added to every email
  note: string | null;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = { confirm: true, reminders: [1440], note: null };
export const MAX_REMINDERS = 3;
export const MAX_NOTE = 2000;

class SettingsError extends Error {}

// The settings from the page (JSON text). strict: refuse bad input (writes);
// otherwise fall back to the defaults (reads).
export function readEmailSettings(raw: unknown, strict = false): EmailSettings {
  if (raw === null || raw === undefined || raw === '') return { ...DEFAULT_EMAIL_SETTINGS };
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SettingsError('Email settings must be an object.');
    const o = v as Record<string, unknown>;
    const confirm = o.confirm === undefined ? true : o.confirm;
    if (typeof confirm !== 'boolean') throw new SettingsError('confirm must be true or false.');
    const list = o.reminders === undefined ? DEFAULT_EMAIL_SETTINGS.reminders : o.reminders;
    if (!Array.isArray(list) || !list.every((n) => Number.isInteger(n) && n >= 5 && n <= 10080)) {
      throw new SettingsError('Reminders must be whole minutes from 5 to 10080 (a week) before the meeting.');
    }
    const reminders = [...new Set(list as number[])].sort((a, b) => b - a);
    if (reminders.length > MAX_REMINDERS) throw new SettingsError(`At most ${MAX_REMINDERS} reminders.`);
    const note = o.note === undefined || o.note === null ? null : o.note;
    if (note !== null && typeof note !== 'string') throw new SettingsError('note must be text.');
    const trimmed = note?.trim() || null;
    if (trimmed && trimmed.length > MAX_NOTE) throw new SettingsError(`The note can be at most ${MAX_NOTE} characters.`);
    return { confirm, reminders, note: trimmed };
  } catch (err) {
    if (strict) throw err instanceof SettingsError ? err : new SettingsError('Email settings must be JSON.');
    return { ...DEFAULT_EMAIL_SETTINGS };
  }
}

export { SettingsError };

// "1 day", "2 hours", "30 minutes", "1 hour 30 minutes"
export function beforeLabel(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? '' : 's'}` : '');
  return [part(d, 'day'), part(h, 'hour'), part(m, 'minute')].filter(Boolean).join(' ');
}

export interface MeetingInfo {
  pageName: string;
  hostName: string | null;
  attendeeName: string | null;
  start: Date;
  end: Date;
  // the visitor's time zone (else the page's)
  timezone: string;
  meetingUrl: string | null;
  // google_meet, teams, zoom, phone, in_person, custom
  locationType: string | null;
  locationDetails: string | null;
  manageUrl: string | null;
  // cancellations: the visitor's reason
  reason?: string | null;
}

const LOCATION: Record<string, string> = { google_meet: 'Google Meet', teams: 'Microsoft Teams', zoom: 'Zoom', phone: 'Phone call', in_person: 'In person' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lines = (s: string) => esc(s).replace(/\r?\n/g, '<br>');

// "Tuesday, December 1, 2026, 10:00 AM to 10:30 AM (Toronto time)"
export function meetingTime(start: Date, end: Date, timezone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(start);
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  const zone = timezone.split('/').pop()!.replace(/_/g, ' ');
  return `${day}, ${clock.format(start)} to ${clock.format(end)} (${zone} time)`;
}

// The subject and HTML body of one booking email.
export function buildBookingEmail(
  kind: BookingEmailKind, info: MeetingInfo, settings: EmailSettings, minutesBefore?: number
): { subject: string; html: string } {
  const when = meetingTime(info.start, info.end, info.timezone);
  const shortDay = new Intl.DateTimeFormat('en-US', { timeZone: info.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(info.start);
  const withHost = info.hostName ? ` with ${info.hostName}` : '';
  const subject = {
    confirmation: `Confirmed: ${info.pageName} on ${shortDay}`,
    reminder: `Reminder: ${info.pageName} ${minutesBefore && minutesBefore >= 1440 ? 'on' : 'at'} ${shortDay}`,
    rescheduled: `Moved: ${info.pageName} is now on ${shortDay}`,
    cancelled: `Cancelled: ${info.pageName} on ${shortDay}`
  }[kind].replace(/[\r\n]+/g, ' ').slice(0, 900);
  const opening = {
    confirmation: `Your meeting${withHost} is booked.`,
    reminder: `A reminder: your meeting${withHost} starts in ${beforeLabel(minutesBefore ?? 0)}.`,
    rescheduled: `Your meeting${withHost} has moved to a new time.`,
    cancelled: `Your meeting${withHost} has been cancelled.`
  }[kind];
  const where = info.meetingUrl
    ? `<a href="${esc(info.meetingUrl)}">${esc(info.meetingUrl)}</a>`
    : info.locationDetails ? lines(info.locationDetails) : info.locationType ? esc(LOCATION[info.locationType] ?? '') : '';
  const greeting = info.attendeeName ? `Hi ${esc(info.attendeeName.split(' ')[0])},` : 'Hi,';
  const parts = [
    `<p>${greeting}</p>`,
    `<p>${esc(opening)}</p>`,
    `<p><strong>${esc(info.pageName)}</strong><br>${kind === 'cancelled' ? '<s>' : ''}${esc(when)}${kind === 'cancelled' ? '</s>' : ''}${
      where && kind !== 'cancelled' ? `<br>${where}` : ''}</p>`,
    ...(kind === 'cancelled' && info.reason ? [`<p>Reason: ${lines(info.reason)}</p>`] : []),
    ...(settings.note && kind !== 'cancelled' ? [`<p>${lines(settings.note)}</p>`] : []),
    ...(info.manageUrl && kind !== 'cancelled' ? [`<p>Need to reschedule or cancel? <a href="${esc(info.manageUrl)}">Change your booking</a>.</p>`] : [])
  ];
  return { subject, html: parts.join('\n') };
}
