import { useEffect, useRef, useState, type ReactNode } from 'react';

// Content cut to a number of lines (6 by default) with a Show more / Show less
// link under it, shown only when the content is longer than that. Clicks on
// the link do not reach the parent (a property row opens its editor on click).
export function ShowMore({ lines = 6, className, children, as: Tag = 'span' }: {
  lines?: number;
  className?: string;
  children: ReactNode;
  as?: 'span' | 'div' | 'pre';
}) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children]);
  return (
    <span className="show-more">
      <Tag
        ref={ref as never}
        className={`${className ?? ''}${open ? '' : ' clamped'}`}
        style={{ ['--clamp-lines' as string]: lines }}
      >
        {children}
      </Tag>
      {(long || open) && (
        <button type="button" className="show-more-toggle" aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </span>
  );
}
