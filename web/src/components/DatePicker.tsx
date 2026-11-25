import { useEffect, useRef, type CSSProperties } from 'react';
import flatpickr from 'flatpickr';
import type { Instance } from 'flatpickr/dist/types/instance';
import { friendlyDate } from '../lib/date-format';
import { useIsMobile } from '../lib/use-mobile';

// Calendar dropdown for date and datetime values (the same flatpickr setup as
// camo-cpq): the native date popup is browser chrome CSS can't restyle.
// Values use the native inputs' formats, "2026-10-31" and "2026-10-31T12:24"
// (local time), so it drops in where <input type="date|datetime-local"> was.
// While it is being edited the visible box shows "2026-10-31" or "2026-10-31
// 12:24" (24-hour) so a typed edit has an unambiguous format; otherwise it
// shows the date as the CRM does everywhere else ("Oct 31, 2026", "Oct 31,
// 2026, 12:24 PM"). flatpickr compares the box with its own format on blur,
// so the friendly text only goes in after blur and after the calendar closes.
// The calendar is rendered on <body> so flatpickr can keep it inside the
// window (it opens upward or right-aligned when there's no room); editors that
// close on outside clicks must treat clicks in `.flatpickr-calendar` as
// inside. onCommit fires with the final value when the calendar closes.
// flatpickr rewrites the DOM around its input, so React only owns the outer
// span and the input is made here.
// noPastDays greys out the days before today (the user's local date), except
// the value it opened with, so an old saved date still shows and isn't cleared.
// inputClassName and inputStyle go on the visible box (custom views give it
// their .v-input look and sizes).
// On a phone the box can't be typed in (the keyboard would cover the
// calendar): it is read-only, always shows the friendly date, and the
// calendar has a Clear button to empty it.
export function localToday(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function DatePicker({ value, onChange, withTime, autoFocus, onCommit, ariaLabel, noPastDays, inputClassName, inputStyle }: {
  value: string; onChange: (v: string) => void; withTime?: boolean; autoFocus?: boolean;
  onCommit?: (value: string) => void; ariaLabel?: string; noPastDays?: boolean; inputClassName?: string; inputStyle?: CSSProperties;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const fp = useRef<Instance | null>(null);
  const showFriendlyRef = useRef<(() => void) | null>(null);
  const latest = useRef({ onChange, onCommit });
  latest.current = { onChange, onCommit };
  const mobile = useIsMobile();

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
      ...(inputClassName !== undefined ? { altInputClass: inputClassName } : {}),
      altFormat: withTime ? 'Y-m-d H:i' : 'Y-m-d',
      allowInput: !mobile,
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
        setTimeout(showFriendly);
      },
      onValueUpdate: () => showFriendly()
    });
    fp.current = instance;
    const box = instance.altInput;
    // the box's text: friendly when idle, flatpickr's own format while editing
    function showFriendly() {
      if (!box || (!mobile && (document.activeElement === box || instance.isOpen))) return;
      box.value = friendlyDate(instance.input.value, withTime);
    }
    function showEditable() {
      if (mobile) return;
      if (box) box.value = instance.input.value ? instance.input.value.replace('T', ' ') : '';
    }
    const onBlur = () => setTimeout(showFriendly);
    box?.addEventListener('focus', showEditable);
    box?.addEventListener('blur', onBlur);
    showFriendly();
    showFriendlyRef.current = showFriendly;
    if (ariaLabel) instance.altInput?.setAttribute('aria-label', ariaLabel);
    // nothing to backspace on a phone, so the calendar empties the date itself
    if (mobile) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'date-picker-clear';
      clear.textContent = 'Clear';
      clear.addEventListener('click', () => {
        instance.clear();
        instance.close();
      });
      instance.calendarContainer.appendChild(clear);
    }
    if (autoFocus) {
      instance.altInput?.focus();
      instance.open();
    }
    return () => {
      box?.removeEventListener('focus', showEditable);
      box?.removeEventListener('blur', onBlur);
      showFriendlyRef.current = null;
      window.removeEventListener('scroll', follow, true);
      instance.destroy(); // turns the hidden input back into a text box,
      fp.current = null;
      host.replaceChildren(); // so remove it (the ref may already be cleared here)
    };
  }, [withTime, noPastDays, mobile]); // eslint-disable-line react-hooks/exhaustive-deps

  // class and inline styles on the visible box, kept current
  useEffect(() => {
    const box = fp.current?.altInput;
    if (!box) return;
    if (inputClassName !== undefined) box.className = inputClassName;
    box.removeAttribute('style');
    for (const [k, v] of Object.entries(inputStyle ?? {})) {
      if (v == null || v === '') continue;
      const css = k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      box.style.setProperty(css, typeof v === 'number' && !/^(opacity|z-index|flex|flex-grow|flex-shrink|order|font-weight|line-height)$/.test(css) ? `${v}px` : String(v));
    }
  });

  // follow value changes made outside the calendar
  useEffect(() => {
    const instance = fp.current;
    if (instance && instance.input.value !== value) {
      instance.setDate(value || [], false);
      showFriendlyRef.current?.();
    }
  }, [value]);

  return <span ref={hostRef} className="date-picker" />;
}
