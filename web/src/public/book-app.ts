import { el, publicApi, queryParamsFromLocation, PublicApiError, type BookingResult, type PublicBookingPage } from './public-api';
import { injectFormCss, renderForm } from './form-renderer';

// The booking flow, drawn into a container: the hosted page (/p/book/,
// book.ts) and booking pages embedded in other websites (embed.js, inside a
// shadow root). Steps: the form before the time (if the page has one), a
// month calendar with open times in the visitor's time zone, the form after
// the time (if any), then the booking. Answers stay in the page until the
// booking is sent; the API checks them again and applies both forms in the
// same transaction as the booking.
//
// Embedded, every request comes from the website itself, so the API only
// answers websites listed in Settings -> Forms (the same list as forms).

export interface BookingMountOptions {
  apiBase: string;
  key: string;
  embedded: boolean;
  // where the form styles go: the page, or the embed's shadow root
  styleTarget: Document | ShadowRoot;
  onTheme: (theme: Record<string, string>) => void;
}

export function mountBooking(root: HTMLElement, opts: BookingMountOptions): void {
  const api = publicApi(opts.apiBase);
  const key = opts.key;
  const loadedAt = Date.now();

  const LOCATION: Record<string, string> = { google_meet: 'Google Meet', teams: 'Microsoft Teams', phone: 'Phone call', in_person: 'In person' };
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let page: PublicBookingPage;
  let tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let beforeValues: Record<string, unknown> | null = null;
  let afterValues: Record<string, unknown> | null = null;
  let honeypot = '';
  let chosen: string | null = null;
  let notice: string | null = null;
  // calendar: the month shown (in the visitor's zone) and its open times by day
  let month = { y: 0, m: 0 };
  let slotsByDay = new Map<string, string[]>();
  let pickedDay: string | null = null;
  let loadingSlots = false;
  let slotError: string | null = null;

  const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts });
  const longDate = (d: Date) => fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d);
  const clock = (d: Date) => fmt({ hour: 'numeric', minute: '2-digit' }).format(d);
  const zones = (): string[] => (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [tz];

  // the page the visitor is on: the hosted page, or the website embedding it
  function pageUrl(): string {
    const query = queryParamsFromLocation().toString();
    const base = window.location.href.split('#')[0].split('?')[0];
    return query ? `${base}?${query}` : base;
  }

  function message(text: string): void {
    root.replaceChildren(el('main', { class: 'pp-page' }, el('div', { class: 'pp-card pp-center' }, el('p', {}, text))));
  }

  type Step = 'before' | 'time' | 'after' | 'done';
  let lastStep: Step | null = null;

  function shell(step: Step, ...content: (Node | null)[]): void {
    const steps: [Step, string][] = [
      ...(page.form_before ? [['before', 'Your details'] as [Step, string]] : []),
      ['time', 'Time'],
      ...(page.form_after ? [['after', 'A few questions'] as [Step, string]] : []),
      ['done', 'Booked']
    ];
    const facts = [`${page.duration_minutes} minutes`, page.host_name ? `with ${page.host_name}` : null, page.location_type ? LOCATION[page.location_type] : null].filter(Boolean);
    root.replaceChildren(el('main', { class: 'pp-page bk-page' },
      el('div', { class: 'pp-card' },
        el('h1', {}, page.name ?? 'Book a meeting'),
        el('div', { class: 'bk-facts' }, ...facts.map((f) => el('span', {}, f as string))),
        page.description ? el('p', { class: 'pp-muted' }, page.description) : null,
        step === 'done' ? null : stepPills(steps, step),
        notice ? el('p', { class: 'pp-error', role: 'alert' }, notice) : null,
        el('div', { class: 'bk-step' }, ...content))));
    notice = null;
    // embedded: bring the top of a new step into view
    if (opts.embedded && lastStep !== null && step !== lastStep && root.getBoundingClientRect().top < 0) {
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    lastStep = step;
  }

  // Steps with ">" between them; earlier steps can be clicked to go back.
  function stepPills(steps: [Step, string][], current: Step): HTMLElement {
    const at = steps.findIndex(([s]) => s === current);
    const back: Partial<Record<Step, () => void>> = { before: showBefore, time: () => void showPicker() };
    const parts: HTMLElement[] = [];
    steps.forEach(([s, label], i) => {
      if (i > 0) parts.push(el('span', { class: 'bk-step-sep', 'aria-hidden': 'true' }, '>'));
      const go = i < at ? back[s] : undefined;
      if (go) {
        const b = el('button', { class: 'bk-step-pill', type: 'button' }, label);
        b.addEventListener('click', go);
        parts.push(b);
      } else {
        parts.push(el('span', { class: `bk-step-pill${s === current ? ' on' : ''}`, 'aria-current': s === current ? 'step' : undefined }, label));
      }
    });
    return el('nav', { class: 'bk-steps', 'aria-label': 'Steps' }, ...parts);
  }

  function formFor(which: 'before' | 'after') {
    const f = which === 'before' ? page.form_before! : page.form_after!;
    return { ...f, description: null, theme: page.theme };
  }

  // ---- step 1: form before the time ----------------------------------------------------

  function showBefore(): void {
    const holder = el('div', {});
    shell('before', holder);
    renderForm(holder, {
      apiBase: opts.apiBase,
      key,
      form: formFor('before'),
      checkPhone: (n) => api.bookingPhone(key, n),
      submitLabel: 'Next',
      initialValues: beforeValues ?? undefined,
      onSubmit: async (values, bot) => {
        await api.bookingBefore(key, values);
        beforeValues = values;
        honeypot ||= bot.hp;
        await showPicker(!month.y);
      }
    });
  }

  // ---- step 2: date and time -------------------------------------------------------------

  async function loadMonth(): Promise<void> {
    loadingSlots = true;
    slotError = null;
    // every day the grid shows, widened for any time zone
    const now = Date.now();
    const { start, cells } = grid();
    const from = new Date(Math.max(now, start - 14 * 3600000));
    const to = new Date(Math.min(start + cells * 86400000 + 14 * 3600000, now + (page.max_days_ahead + 1) * 86400000));
    slotsByDay = new Map();
    if (to > from) {
      try {
        const { slots } = await api.bookingSlots(key, from, to);
        for (const s of slots) {
          const k = dayKey(new Date(s));
          slotsByDay.set(k, [...(slotsByDay.get(k) ?? []), s]);
        }
      } catch (err) {
        slotError = (err as Error).message;
      }
    }
    loadingSlots = false;
  }

  const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
  const utcDayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  // The month's grid: whole weeks from the Sunday on or before the 1st to the
  // Saturday on or after the last day (start as a UTC midnight).
  function grid(): { start: number; cells: number } {
    const first = Date.UTC(month.y, month.m - 1, 1);
    const lead = new Date(first).getUTCDay();
    const days = new Date(Date.UTC(month.y, month.m, 0)).getUTCDate();
    return { start: first - lead * 86400000, cells: Math.ceil((lead + days) / 7) * 7 };
  }
  const inMonth = (k: string) => k.startsWith(monthKey(month.y, month.m));

  function shiftMonth(by: number): void {
    const d = new Date(Date.UTC(month.y, month.m - 1 + by, 1));
    month = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
    pickedDay = null;
  }

  async function showPicker(first = false): Promise<void> {
    if (!month.y || first) {
      const [y, m] = dayKey(new Date()).split('-').map(Number);
      month = { y, m };
    }
    shell('time', el('p', { class: 'pp-muted' }, 'Finding open times…'));
    await loadMonth();
    // nothing left this month: start on the next one
    if (first && ![...slotsByDay.keys()].some(inMonth) && !slotError) {
      shiftMonth(1);
      await loadMonth();
    }
    if (!pickedDay || !slotsByDay.has(pickedDay)) pickedDay = [...slotsByDay.keys()].filter(inMonth).sort()[0] ?? null;
    drawPicker();
  }

  function drawPicker(): void {
    const today = dayKey(new Date());
    const [ty, tm] = today.split('-').map(Number);
    const last = new Date(Date.now() + page.max_days_ahead * 86400000);
    const [ly, lm] = dayKey(last).split('-').map(Number);
    const canBack = month.y * 12 + month.m > ty * 12 + tm;
    const canNext = month.y * 12 + month.m < ly * 12 + lm;
    const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(month.y, month.m - 1, 1)));

    const { start, cells: count } = grid();
    const cells: HTMLElement[] = DOW.map((d) => el('div', { class: 'bk-dow' }, d));
    for (let i = 0; i < count; i++) {
      const k = utcDayKey(start + i * 86400000);
      const open = slotsByDay.has(k);
      // days of the months before and after are shown faded; open ones can still be picked
      const other = !inMonth(k);
      const b = el('button', {
        class: `bk-date${open ? ' open' : ''}${other ? ' other' : ''}${k === pickedDay ? ' picked' : ''}`,
        type: 'button', disabled: !open, 'aria-label': open ? `${k}, open times` : k
      }, String(Number(k.slice(8))));
      if (open) b.addEventListener('click', () => { pickedDay = k; drawPicker(); });
      cells.push(b);
    }
    const back = el('button', { class: 'bk-nav', type: 'button', disabled: !canBack || loadingSlots, 'aria-label': 'Previous month' }, '‹');
    const next = el('button', { class: 'bk-nav', type: 'button', disabled: !canNext || loadingSlots, 'aria-label': 'Next month' }, '›');
    back.addEventListener('click', async () => { shiftMonth(-1); await loadMonth(); drawPicker(); });
    next.addEventListener('click', async () => { shiftMonth(1); await loadMonth(); drawPicker(); });

    const times = pickedDay ? slotsByDay.get(pickedDay) ?? [] : [];
    const timeList = el('div', { class: 'bk-times' },
      ...(pickedDay ? [el('strong', {}, longDate(new Date(times[0])))] : []),
      ...times.map((s) => {
        const b = el('button', { class: 'bk-time', type: 'button' }, clock(new Date(s)));
        b.addEventListener('click', () => pick(s));
        return b;
      }),
      ...(!pickedDay ? [el('p', { class: 'pp-muted' }, slotsByDay.size ? 'Pick a day.' : 'No open times this month.')] : []));

    const zoneSelect = el('select', { 'aria-label': 'Time zone' }, ...[...new Set([tz, ...zones()])].map((z) => el('option', { value: z, selected: z === tz }, z.replace(/_/g, ' '))));
    zoneSelect.addEventListener('change', async () => {
      tz = zoneSelect.value;
      await loadMonth();
      pickedDay = null;
      drawPicker();
    });

    shell('time',
      slotError ? el('p', { class: 'pp-error', role: 'alert' }, slotError) : null,
      el('div', { class: 'bk-picker' },
        el('div', {}, el('div', { class: 'bk-month-head' }, back, el('strong', {}, title), next), el('div', { class: 'bk-grid' }, ...cells)),
        timeList),
      el('label', { class: 'bk-tz' }, 'Times are shown in', zoneSelect),
      page.form_before ? backLink('Change your details', showBefore) : null);
  }

  function backLink(text: string, to: () => void): HTMLElement {
    const b = el('button', { class: 'bk-link', type: 'button' }, text);
    b.addEventListener('click', to);
    return el('p', {}, b);
  }

  function chosenBox(): HTMLElement {
    const change = el('button', { class: 'bk-link', type: 'button' }, 'Change');
    change.addEventListener('click', () => void showPicker());
    const d = new Date(chosen!);
    return el('div', { class: 'bk-chosen' }, el('strong', {}, `${longDate(d)}, ${clock(d)} (${tz.replace(/_/g, ' ')})`), change);
  }

  function pick(start: string): void {
    chosen = start;
    if (page.form_after) showAfter();
    else showConfirm();
  }

  // ---- step 3: form after the time, or a plain confirm ---------------------------------

  function showAfter(): void {
    const holder = el('div', {});
    shell('after', chosenBox(), holder);
    renderForm(holder, {
      apiBase: opts.apiBase,
      key,
      form: formFor('after'),
      checkPhone: (n) => api.bookingPhone(key, n),
      submitLabel: 'Book',
      initialValues: afterValues ?? undefined,
      onSubmit: async (values, bot) => {
        afterValues = values;
        honeypot ||= bot.hp;
        await book();
      }
    });
  }

  function showConfirm(): void {
    const button = el('button', { class: 'pp-btn primary', type: 'button' }, 'Book');
    const error = el('p', { class: 'pp-error', role: 'alert' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      error.textContent = '';
      try {
        await book();
      } catch (err) {
        error.textContent = (err as Error).message;
        button.disabled = false;
      }
    });
    shell('after', chosenBox(), error, el('div', { class: 'pp-actions' }, button));
  }

  // ---- booking -------------------------------------------------------------------------

  // Errors on the after form are thrown back to it (shown under the field);
  // others send the visitor back to the step that needs fixing.
  async function book(): Promise<void> {
    let res: BookingResult;
    try {
      res = await api.book(key, {
        start: chosen!,
        ...(page.form_before ? { before: { values: beforeValues ?? {} } } : {}),
        ...(page.form_after ? { after: { values: afterValues ?? {} } } : {}),
        page_url: pageUrl(),
        _hp: honeypot,
        _elapsed: Date.now() - loadedAt
      });
    } catch (err) {
      const e = err as PublicApiError;
      if (e.status === 409) {
        notice = 'That time was just taken. Pick another.';
        chosen = null;
        void showPicker();
        return;
      }
      if (e.form === 'before' && page.form_before) {
        notice = e.message;
        showBefore();
        return;
      }
      throw err;
    }
    showDone(res);
  }

  function showDone(res: BookingResult): void {
    const start = new Date(res.start);
    const where = res.meeting_url
      ? el('a', { href: res.meeting_url, target: '_blank', rel: 'noreferrer' }, res.meeting_url)
      : res.location_details ?? (res.location_type ? LOCATION[res.location_type] : null);
    shell('done', el('div', { class: 'bk-done' },
      el('h2', {}, 'You are booked'),
      el('dl', { class: 'pp-meta' },
        el('dt', {}, 'When'), el('dd', {}, `${longDate(start)}, ${clock(start)} to ${clock(new Date(res.end))}`),
        el('dt', {}, 'Time zone'), el('dd', {}, tz.replace(/_/g, ' ')),
        ...(where ? [el('dt', {}, 'Where'), el('dd', {}, where)] : [])),
      res.location_details && res.meeting_url ? el('p', { class: 'bk-message' }, res.location_details) : null,
      el('p', { class: 'pp-muted' }, 'A calendar invite is on its way to your email.'),
      res.confirmation_message ? el('p', { class: 'bk-message' }, res.confirmation_message) : null));
  }

  // ---- start ---------------------------------------------------------------------------

  async function load(): Promise<void> {
    if (!key) return message('This link is missing its booking page key.');
    try {
      page = await api.booking(key);
      opts.onTheme(page.theme);
      if (!opts.embedded) document.title = page.name ?? 'Book a meeting';
      injectFormCss(opts.styleTarget);
      if (page.form_before) showBefore();
      else await showPicker(true);
    } catch (err) {
      const status = (err as { status?: number }).status;
      // embedded on a website not in Settings -> Forms, the browser blocks the answer (status 0)
      message(status === 404 ? 'This booking page is not available.'
        : opts.embedded && status === 0 ? 'This booking page is not available on this website.' : (err as Error).message);
    }
  }

  void load();
}
