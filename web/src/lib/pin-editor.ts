import { useEffect, type RefObject } from 'react';

// On a phone, the property being edited is scrolled to the top of the screen
// and the page stops scrolling until the editor closes. Lists inside the
// editor (address suggestions, dropdown lists, a long text box) still scroll
// on their own. The scroller gets room at its end (.pin-editing) so the last
// property can reach the top too.

const GAP = 8; // room above the row for its focus frame

function scrollerOf(el: HTMLElement): HTMLElement {
  // (not .prop-section.main, the property list's own first section)
  const main = el.closest<HTMLElement>('.main-col > .main');
  if (main) return main; // the app's page scroller
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

// true when the touch is inside something that scrolls by itself (not the page)
function innerScroll(target: EventTarget | null, page: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== page; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const y = getComputedStyle(el).overflowY;
    if ((y === 'auto' || y === 'scroll') && el.scrollHeight > el.clientHeight) return true;
  }
  return false;
}

// key: what is being edited (null when nothing is); container: holds the
// rows; selector: finds the edited row inside it.
export function usePinWhileEditing(active: boolean, key: string | null, container: RefObject<HTMLElement | null>, selector: string): void {
  useEffect(() => {
    if (!active || !key) return;
    const row = container.current?.querySelector<HTMLElement>(selector);
    if (!row) return;
    const page = scrollerOf(row);
    page.classList.add('pin-editing');

    const pin = (smooth: boolean) => {
      const top = page === document.scrollingElement ? 0 : page.getBoundingClientRect().top;
      const by = row.getBoundingClientRect().top - Math.max(top, 0) - GAP;
      if (Math.abs(by) > 1) page.scrollBy({ top: by, behavior: smooth ? 'smooth' : 'auto' });
    };
    pin(true);
    // the keyboard opening can move things (iOS scrolls a focused box into
    // view): put the row back where it belongs
    const vv = window.visualViewport;
    const again = () => pin(false);
    vv?.addEventListener('resize', again);

    const onTouch = (e: TouchEvent) => {
      if (!innerScroll(e.target, page)) e.preventDefault();
    };
    document.addEventListener('touchmove', onTouch, { passive: false });
    return () => {
      page.classList.remove('pin-editing');
      vv?.removeEventListener('resize', again);
      document.removeEventListener('touchmove', onTouch);
    };
  }, [active, key, container, selector]);
}

// On a phone, while an editor is open (key set), taps outside it do nothing:
// they neither close it, save it, open another one nor follow a link. keep:
// what still takes taps (the editor itself and lists or dialogs it opens on
// <body>). The editor closes only with its own Save or Cancel.
export function useHoldTapsOutside(active: boolean, key: string | null, keep: string): void {
  useEffect(() => {
    if (!active || !key) return;
    const block = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(keep)) return;
      if (e.cancelable) e.preventDefault(); // no focus change, no click
      e.stopPropagation();
    };
    const types = ['touchend', 'mousedown', 'mouseup', 'click'] as const;
    for (const t of types) window.addEventListener(t, block, { capture: true, passive: false });
    return () => {
      for (const t of types) window.removeEventListener(t, block, { capture: true });
    };
  }, [active, key, keep]);
}

// On a phone, while a dialog is open the page behind it holds still; the
// dialog's own lists still scroll. Dialogs can stack (a confirm over a
// modal), so the page unlocks when the last one closes.
let locks = 0;
const onLockedTouch = (e: TouchEvent) => {
  const page = lockedPage();
  if (!innerScroll(e.target, page)) e.preventDefault();
};
function lockedPage(): HTMLElement {
  return document.querySelector<HTMLElement>('.main-col > .main')
    ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}
export function useLockPageScroll(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (locks++ === 0) {
      lockedPage().classList.add('scroll-locked');
      document.addEventListener('touchmove', onLockedTouch, { passive: false });
    }
    return () => {
      if (--locks === 0) {
        document.querySelectorAll('.scroll-locked').forEach((el) => el.classList.remove('scroll-locked'));
        document.removeEventListener('touchmove', onLockedTouch);
      }
    };
  }, [active]);
}
