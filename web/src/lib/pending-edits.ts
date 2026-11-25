import { useEffect, useRef } from 'react';

// Unsaved edits one part of a record page holds, for another part to save with
// its own write. The booking page editor registers its changes here, so the
// sidebar's Publish sends them along: publishing checks what will be saved, not
// what was saved before the switches were changed.
type Getter = () => Record<string, unknown> | null;
const getters = new Map<string, Getter>();

const keyOf = (object: string, id: string) => `${object}:${id}`;

// changes: the unsaved properties, or null when there are none (or they cannot be saved yet)
export function usePendingEdits(object: string, id: string, changes: Getter): void {
  const latest = useRef(changes);
  latest.current = changes;
  useEffect(() => {
    const key = keyOf(object, id);
    const getter: Getter = () => latest.current();
    getters.set(key, getter);
    return () => {
      if (getters.get(key) === getter) getters.delete(key);
    };
  }, [object, id]);
}

export function pendingEdits(object: string, id: string): Record<string, unknown> | null {
  const changes = getters.get(keyOf(object, id))?.();
  return changes && Object.keys(changes).length ? changes : null;
}
