// The app's loading indicator: a spinning ring in the primary colour. The
// label is for screen readers only, nothing is shown next to the ring. Use it
// wherever something is still loading, in place of plain "Loading…" text.
// (Custom views have their own copy in the view kit, view-runtime/kit.tsx.)

export function Spinner({ className }: { className?: string }) {
  return <span className={`spinner${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

export function Loading({ label = 'Loading…', inline = false, className }: { label?: string; inline?: boolean; className?: string }) {
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className={`app-loading${inline ? ' inline' : ''}${className ? ` ${className}` : ''}`} role="status" aria-live="polite">
      <Spinner />
      <span className="sr-only">{label}</span>
    </Tag>
  );
}
