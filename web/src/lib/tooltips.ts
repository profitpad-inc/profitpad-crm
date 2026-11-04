// App-wide tooltips. Browsers show a `title` only after a long, fixed delay,
// so this takes over every `title` attribute on the page: while the mouse is
// on the element the title is parked in `data-tip` (so the native one never
// appears) and our own bubble shows after SHOW_DELAY. Once one is showing,
// moving to another titled element shows its tooltip straight away.
// Styles: `.app-tooltip` in styles.css and view-runtime/frame.css.

const SHOW_DELAY = 500;
const WARM_FOR = 300; // ms after a tooltip hides during which the next one shows at once
const GAP = 6;
const EDGE = 8;

export function installTooltips(): void {
  if (typeof document === 'undefined' || (window as { __tooltips?: boolean }).__tooltips) return;
  (window as { __tooltips?: boolean }).__tooltips = true;

  const tip = document.createElement('div');
  tip.className = 'app-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;

  let target: HTMLElement | SVGElement | null = null;
  let timer = 0;
  let warmUntil = 0;

  const park = (el: HTMLElement | SVGElement) => {
    const t = el.getAttribute('title');
    if (t) {
      el.setAttribute('data-tip', t);
      el.removeAttribute('title');
    }
  };
  const unpark = (el: HTMLElement | SVGElement) => {
    const t = el.getAttribute('data-tip');
    el.removeAttribute('data-tip');
    // if the app set a new title meanwhile, that one wins
    if (t && !el.hasAttribute('title')) el.setAttribute('title', t);
  };

  const show = () => {
    if (!target || !target.isConnected) return hide();
    const text = target.getAttribute('data-tip');
    if (!text) return;
    if (!tip.isConnected) document.body.appendChild(tip);
    tip.textContent = text;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let top = r.bottom + GAP;
    if (top + h > vh - EDGE && r.top - GAP - h >= EDGE) top = r.top - GAP - h;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), Math.max(EDGE, vw - w - EDGE));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };

  const hide = () => {
    window.clearTimeout(timer);
    if (!tip.hidden) warmUntil = Date.now() + WARM_FOR;
    tip.hidden = true;
    if (target) unpark(target);
    target = null;
  };

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = (e.target as Element | null)?.closest?.('[title], [data-tip]') as HTMLElement | SVGElement | null;
    if (el === target) return;
    const wasShowing = !tip.hidden || Date.now() < warmUntil;
    hide();
    if (!el || !(el.getAttribute('title') || el.getAttribute('data-tip'))) return;
    target = el;
    park(el);
    if (wasShowing) show();
    else timer = window.setTimeout(show, SHOW_DELAY);
  }, true);

  document.addEventListener('pointerout', (e) => {
    if (!target) return;
    const to = e.relatedTarget as Node | null;
    if (to && target.contains(to)) return;
    hide();
  }, true);

  const dismiss = () => { if (target) { hide(); warmUntil = 0; } };
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
  document.addEventListener('scroll', dismiss, true);
  window.addEventListener('blur', dismiss);
}
