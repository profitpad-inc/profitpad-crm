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
