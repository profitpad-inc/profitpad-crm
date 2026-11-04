import { useRef, type TextareaHTMLAttributes } from 'react';

// A code box you can type in, with line numbers beside it. Lines do not wrap
// (one number per line); the numbers scroll with the text.
export function CodeTextarea({ value, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const gutter = useRef<HTMLDivElement>(null);
  const count = value.split('\n').length;
  return (
    <div className={`code-editor${className ? ` ${className}` : ''}`} style={{ ['--gutter' as string]: `${String(count).length}ch` }}>
      <div ref={gutter} className="code-editor-gutter" aria-hidden>
        {Array.from({ length: count }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <textarea
        {...rest}
        value={value}
        wrap="off"
        spellCheck={false}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
      />
    </div>
  );
}
