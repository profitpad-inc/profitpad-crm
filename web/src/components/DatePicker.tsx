import { useEffect, useRef } from 'react';
import flatpickr from 'flatpickr';
import type { Instance } from 'flatpickr/dist/types/instance';

// Calendar dropdown for date and datetime values (the same flatpickr setup as
// camo-cpq): the native date popup is browser chrome CSS can't restyle.
// Values use the native inputs' formats, "2026-10-31" and "2026-10-31T12:24"
// (local time), so it drops in where <input type="date|datetime-local"> was.
// The visible box shows "2026-10-31" or "2026-10-31 12:24" (24-hour) so a
// typed edit has an unambiguous format.
// The calendar is rendered on <body> so flatpickr can keep it inside the
// window (it opens upward or right-aligned when there's no room); editors that
// close on outside clicks must treat clicks in `.flatpickr-calendar` as
// inside. onCommit fires with the final value when the calendar closes.
// flatpickr rewrites the DOM around its input, so React only owns the outer
// span and the input is made here.
// noPastDays greys out the days before today (the user's local date), except
// the value it opened with, so an old saved date still shows and isn't cleared.
export function localToday(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function DatePicker({ value, onChange, withTime, autoFocus, onCommit, ariaLabel, noPastDays }: {
  value: string; onChange: (v: string) => void; withTime?: boolean; autoFocus?: boolean;
  onCommit?: (value: string) => void; ariaLabel?: string; noPastDays?: boolean;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const fp = useRef<Instance | null>(null);
  const latest = useRef({ onChange, onCommit });
  latest.current = { onChange, onCommit };

  useEffect(() => {
    const host = hostRef.current!;
    const input = document.createElement('input');
    input.placeholder = withTime ? 'YYYY-MM-DD HH:MM' : 'YYYY-MM-DD'; // copied to the visible box
    host.appendChild(input);
    // flatpickr places the calendar against the page, so follow scrolling containers
    const follow = (e: Event) => {
      if (!instance.calendarContainer.contains(e.target as Node)) instance._positionCalendar();
    };
    const opened = value.slice(0, 10);
    const instance = flatpickr(input, {
      disable: noPastDays ? [(d: Date) => { const day = localToday(d); return day < localToday() && day !== opened; }] : [],
      dateFormat: withTime ? 'Y-m-d\\TH:i' : 'Y-m-d',
      altInput: true,
      altFormat: withTime ? 'Y-m-d H:i' : 'Y-m-d',
      allowInput: true,
      enableTime: withTime,
      time_24hr: true,
      minuteIncrement: 1,
      disableMobile: true,
      defaultDate: value || undefined,
      onChange: (_dates, dateStr) => latest.current.onChange(dateStr),
      onOpen: () => window.addEventListener('scroll', follow, true),
      onClose: (_dates, dateStr) => {
        window.removeEventListener('scroll', follow, true);
        latest.current.onCommit?.(dateStr);
      }
    });
    fp.current = instance;
    if (ariaLabel) instance.altInput?.setAttribute('aria-label', ariaLabel);
    if (autoFocus) {
      instance.altInput?.focus();
      instance.open();
    }
    return () => {
      window.removeEventListener('scroll', follow, true);
      instance.destroy(); // turns the hidden input back into a text box,
      fp.current = null;
      host.replaceChildren(); // so remove it (the ref may already be cleared here)
    };
  }, [withTime, noPastDays]); // eslint-disable-line react-hooks/exhaustive-deps

  // follow value changes made outside the calendar
  useEffect(() => {
    const instance = fp.current;
    if (instance && instance.input.value !== value) instance.setDate(value || [], false);
  }, [value]);

  return <span ref={hostRef} className="date-picker" />;
}
