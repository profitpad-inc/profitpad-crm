import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

// A search box whose text also lives in the URL (?s= by default), so a
// refresh or a copied link keeps it. The box updates at once; the URL follows
// after a short pause and is replaced rather than pushed, so typing doesn't
// fill the back button. Returns the box's text, its setter and the settled
// (trimmed, debounced) text that is in the URL.
export function useUrlSearch(key = 's', delay = 300): [string, (v: string) => void, string] {
  const [params, setParams] = useSearchParams();
  const urlValue = params.get(key) ?? '';
  const [value, setValue] = useState(urlValue);
  const [settled, setSettled] = useState(urlValue);

  useEffect(() => {
    const h = setTimeout(() => setSettled(value.trim()), delay);
    return () => clearTimeout(h);
  }, [value, delay]);

  // synced is the value both sides agree on, so each effect only reacts to
  // a change from the other side
  const synced = useRef(urlValue);
  useEffect(() => {
    if (settled === synced.current) return;
    synced.current = settled;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (settled) next.set(key, settled);
      else next.delete(key);
      return next;
    }, { replace: true });
  }, [settled, key, setParams]);

  // the URL changed from outside (back button, a link to the same page)
  useEffect(() => {
    if (urlValue === synced.current) return;
    synced.current = urlValue;
    setValue(urlValue);
    setSettled(urlValue);
  }, [urlValue]);

  return [value, setValue, settled];
}
