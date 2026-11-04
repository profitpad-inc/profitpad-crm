import { createContext, useContext, useEffect, useRef } from 'react';
import { API_BASE } from './api';

// Live updates on record pages (api/src/live.ts, migration 0086).
//
// The API streams which watched records changed (never their values); the
// page reads them again through the normal API. Changes arriving within
// 300 ms come together, so a save touching five properties is one reload.
// 'all' means "read everything again": after the stream was cut (the tab was
// hidden, the network dropped, the server ended it) or after a big import.

export interface LiveChange {
  object: string;
  id: string;
  by: { actor: string; name: string | null } | null;
  // made by the signed-in user (this tab or another)
  self: boolean;
}

export type LiveEvents = LiveChange[] | 'all';

const BATCH_MS = 300;
// the watch list settles (associations load) before the stream opens
const OPEN_DELAY_MS = 400;

export function useLiveRecords(watch: string[], onEvents: (events: LiveEvents) => void): void {
  const key = watch.join(',');
  const handler = useRef(onEvents);
  handler.current = onEvents;

  useEffect(() => {
    if (!key || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let pending: LiveChange[] = [];
    let all = false;
    let batch: number | null = null;
    let opening: number | null = null;
    // the stream was cut since it last opened: catch up once it is back
    let missed = false;

    const flush = () => {
      batch = null;
      const events: LiveEvents = all ? 'all' : pending;
      pending = [];
      all = false;
      if (events === 'all' || events.length) handler.current(events);
    };
    const queue = (c: LiveChange | 'all') => {
      if (c === 'all') all = true;
      else pending.push(c);
      if (batch === null) batch = window.setTimeout(flush, BATCH_MS);
    };

    const open = () => {
      opening = null;
      if (es || document.visibilityState === 'hidden') return;
      const source = new EventSource(`${API_BASE}/v1/live/records?watch=${encodeURIComponent(key)}`, { withCredentials: true });
      es = source;
      source.addEventListener('ready', () => {
        if (missed) queue('all');
        missed = false;
      });
      source.addEventListener('change', (e) => {
        try {
          queue(JSON.parse((e as MessageEvent<string>).data) as LiveChange);
        } catch {
          queue('all');
        }
      });
      source.addEventListener('bulk', () => queue('all'));
      // the browser reconnects by itself (unless the API refused the stream)
      source.onerror = () => {
        missed = true;
      };
    };
    const close = () => {
      if (opening !== null) window.clearTimeout(opening);
      opening = null;
      es?.close();
      es = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (es) missed = true;
        close();
      } else if (!es && opening === null) {
        open();
      }
    };

    opening = window.setTimeout(open, OPEN_DELAY_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
      if (batch !== null) window.clearTimeout(batch);
    };
  }, [key]);
}

// How many times each watched record has changed while the page was open, so
// parts that load their own data (comments, an opened activity, history) can
// load again: add useLiveVersion(object, id) to the effect's dependencies.
export interface LiveState {
  versions: ReadonlyMap<string, number>;
  // bumped on every change the page hears about
  stamp: number;
}

export const LiveContext = createContext<LiveState>({ versions: new Map(), stamp: 0 });

export function useLiveVersion(object: string, id: string): number {
  return useContext(LiveContext).versions.get(`${object}:${id}`) ?? 0;
}

export function useLiveStamp(): number {
  return useContext(LiveContext).stamp;
}

// The versions after a batch of events ('all' bumps every watched record).
export function bumpVersions(prev: ReadonlyMap<string, number>, events: LiveEvents, watch: string[]): Map<string, number> {
  const next = new Map(prev);
  const keys = events === 'all' ? watch : events.map((e) => `${e.object}:${e.id}`);
  for (const k of new Set(keys)) next.set(k, (next.get(k) ?? 0) + 1);
  return next;
}
