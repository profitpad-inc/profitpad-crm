import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { findFolds, type CodeLang } from '../lib/code-folds';

// Copies text, showing a tick for a moment. Sits in the top right corner of a
// code box (the box is position: relative).
export function CopyCodeButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // clipboard blocked; nothing to show
    }
  }
  return (
    <button type="button" className="code-copy" onClick={copy} title={copied ? 'Copied' : 'Copy code'} aria-label={copied ? 'Copied' : 'Copy code'}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

// Code with line numbers (left out when copying) and VS Code style folding:
// a chevron beside a line that opens a block hides the block, and the dots
// after a folded line open it again. Unwrapped, long lines scroll sideways and
// the numbers stay put; wrapped, a long line keeps one number. The copy
// button always copies the whole text, folded parts included.
export function CodeBlock({ text, wrap, lang, className }: { text: string; wrap: boolean; lang: CodeLang; className?: string }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  const folds = useMemo(() => findFolds(text, lang), [text, lang]);
  const [folded, setFolded] = useState<Set<number>>(() => new Set());
  useEffect(() => setFolded(new Set()), [text]);

  const toggle = (i: number) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const end = folds.get(i);
    const isFolded = end !== undefined && folded.has(i);
    rows.push(
      <span key={i} className={`code-line${isFolded ? ' folded' : ''}`}>
        <span className="ln" aria-hidden>{i + 1}</span>
        <span className="fold" aria-hidden>
          {end !== undefined && (
            <button type="button" tabIndex={-1} onClick={() => toggle(i)} title={isFolded ? 'Unfold' : 'Fold'}>
              {isFolded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </span>
        <span className="lc">
          {lines[i] || (isFolded ? '' : ' ')}
          {isFolded && <button type="button" className="fold-dots" onClick={() => toggle(i)} title="Unfold">⋯</button>}
        </span>
      </span>,
    );
    if (isFolded) i = end;
  }

  return (
    <div className={`code-block${className ? ` ${className}` : ''}`}>
      <pre className={`view-code numbered${wrap ? ' wrap' : ''}`} style={{ ['--gutter' as string]: `${String(lines.length).length}ch` }}>
        {rows}
      </pre>
      <CopyCodeButton text={text} />
    </div>
  );
}
