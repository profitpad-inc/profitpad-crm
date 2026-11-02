// Messages between the CRM page (pages/CustomView.tsx) and the sandboxed
// view frame (view-runtime/main.tsx). The frame has an opaque origin, so the
// page checks event.source instead of the origin; the frame answers only the
// window that sent it the init message.

export type Params = Record<string, string>;

export interface ViewInit {
  type: 'pcrm:init';
  module: string;
  queries: Record<string, { params: Record<string, string> }>;
  theme: Record<string, string>;
  me: { id: string | null; name: string | null; is_admin: boolean };
  params: Params;
  view: { id: string; name: string | null; slug: string; draft: boolean };
}

export type BridgeMethod = 'query' | 'openRecord' | 'navigate' | 'setParams' | 'createRecord' | 'updateRecord' | 'linkRecords';

export type ToFrame =
  | ViewInit
  | { type: 'pcrm:params'; params: Params }
  | { type: 'pcrm:reply'; id: number; ok: true; value: unknown }
  | { type: 'pcrm:reply'; id: number; ok: false; error: { message: string; status?: number } };

export type FromFrame =
  | { type: 'pcrm:ready' }
  | { type: 'pcrm:call'; id: number; method: BridgeMethod; args: unknown[] }
  | { type: 'pcrm:height'; height: number }
  | { type: 'pcrm:error'; message: string };
