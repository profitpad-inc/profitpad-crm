import { useState } from 'react';

// Rule for the whole CRM: a Save button stays disabled until the form differs
// from what it opened with. useDirty snapshots the form's starting values and
// reports whether the current ones differ; changing a field back makes it
// clean again.
//
//   const { dirty, markSaved } = useDirty({ name, url }, editing?.id);
//   <button disabled={!dirty || busy} onClick={async () => { await save(); markSaved(); }}>Save</button>
//
// resetKey: when it changes (another record opened, a modal opened again),
// the current values become the new starting point. markSaved() does the same
// after a save that keeps the form open (pass the saved values if they differ
// from what is on screen).
export function useDirty<T>(value: T, resetKey?: unknown): { dirty: boolean; markSaved: (saved?: T) => void } {
  const now = norm(value);
  const [snap, setSnap] = useState(() => ({ key: resetKey, base: now }));
  let base = snap.base;
  if (!Object.is(snap.key, resetKey)) {
    base = now;
    setSnap({ key: resetKey, base: now });
  }
  return {
    dirty: now !== base,
    markSaved: (saved?: T) => setSnap((s) => ({ ...s, base: saved === undefined ? now : norm(saved) })),
  };
}

// Stable text form of a value for comparing: object keys sorted, strings
// trimmed, and null, undefined and '' all count as empty, so a field typed
// into and cleared again is not a change.
export function norm(value: unknown): string {
  return JSON.stringify(clean(value)) ?? 'null';
}

function clean(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t; }
  if (Array.isArray(v)) return v.map(clean);
  if (v instanceof Set) return [...v].map(clean).sort();
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = clean((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
