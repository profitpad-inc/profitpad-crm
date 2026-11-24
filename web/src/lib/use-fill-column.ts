import { useLayoutEffect, useRef, useState, type DependencyList } from 'react';

// Sizes a box (a page or quote preview) to run down to the bottom of the record's middle
// column, refitting when the column resizes. Returns the ref for the box and its height;
// the height is null where the column does not scroll on its own (phones), so the box
// keeps its CSS height there. Pass deps that change what sits above the box.
export function useFillColumn<T extends HTMLElement>(deps: DependencyList) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    const scroller = box?.closest<HTMLElement>('.record-middle');
    if (!box || !scroller) return;
    const fit = () => {
      const style = getComputedStyle(scroller);
      if (style.overflowY === 'visible') return setHeight(null);
      const card = box.closest('.card');
      const bRect = box.getBoundingClientRect();
      const below = card ? card.getBoundingClientRect().bottom - bRect.bottom : 0;
      const top = bRect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const room = scroller.clientHeight - top - below - parseFloat(style.paddingBottom);
      setHeight(Math.max(360, Math.floor(room)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, deps);
  return { ref, height };
}
