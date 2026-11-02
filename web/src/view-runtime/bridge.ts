import type { BridgeMethod, FromFrame, Params, RuntimeError, ToFrame, Viewport, ViewInit } from './protocol';

// The frame's side of the bridge: calls go to the CRM page, which runs them
// with the viewer's session (queries through the views API, record actions
// through the normal record API).

let parentOrigin = '*';
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export class BridgeError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export function post(msg: FromFrame): void {
  window.parent.postMessage(msg, parentOrigin);
}

export function call<T = unknown>(method: BridgeMethod, args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: 'pcrm:call', id, method, args });
  });
}

// ---- shared state (params and the init payload) --------------------------------

let init: ViewInit | null = null;
let params: Params = {};
const listeners = new Set<() => void>();

let viewport: Viewport = { scrollTop: 0, viewportHeight: window.innerHeight };
const viewportListeners = new Set<() => void>();

export const getInit = () => init;
export const getViewport = () => viewport;
export function subscribeViewport(fn: () => void): () => void {
  viewportListeners.add(fn);
  return () => viewportListeners.delete(fn);
}

// Errors go to the page in small batches (at most 30 different ones per
// load), which logs them for the AI that built the view.
const reported = new Set<string>();
let batch: RuntimeError[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
export function report(kind: RuntimeError['kind'], message: string, detail?: string): void {
  const key = `${kind}:${message}`;
  if (!message || reported.has(key) || reported.size >= 30) return;
  reported.add(key);
  batch.push({ kind, message: message.slice(0, 2000), detail: detail?.slice(0, 4000), width: window.innerWidth });
  flushTimer ??= setTimeout(() => {
    post({ type: 'pcrm:report', errors: batch });
    batch = [];
    flushTimer = null;
  }, 500);
}
export const getParams = () => params;
export function subscribeParams(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listen(onInit: (msg: ViewInit) => void): void {
  window.addEventListener('message', (e: MessageEvent<ToFrame>) => {
    if (e.source !== window.parent || !e.data || typeof e.data !== 'object') return;
    const msg = e.data;
    if (msg.type === 'pcrm:init') {
      if (init) return;
      parentOrigin = e.origin && e.origin !== 'null' ? e.origin : '*';
      init = msg;
      params = msg.params ?? {};
      onInit(msg);
    } else if (msg.type === 'pcrm:viewport') {
      const v = msg.viewport;
      if (!v || (v.scrollTop === viewport.scrollTop && v.viewportHeight === viewport.viewportHeight)) return;
      viewport = { scrollTop: Number(v.scrollTop) || 0, viewportHeight: Number(v.viewportHeight) || window.innerHeight };
      viewportListeners.forEach((fn) => fn());
    } else if (msg.type === 'pcrm:params') {
      params = msg.params ?? {};
      listeners.forEach((fn) => fn());
    } else if (msg.type === 'pcrm:reply') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new BridgeError(msg.error.message, msg.error.status));
    }
  });
}
