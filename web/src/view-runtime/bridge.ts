import type { BridgeMethod, FromFrame, Params, ToFrame, ViewInit } from './protocol';

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

export const getInit = () => init;
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
