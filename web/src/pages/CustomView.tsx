import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useIsMobile } from '../lib/use-mobile';
import { MobileHeader } from '../components/MobileNav';
import type { BridgeMethod, FromFrame, Params, ToFrame, ViewInit } from '../view-runtime/protocol';

// A custom view (/view/#<slug>?param=value). The view's code runs in a
// sandboxed iframe (public/view-frame, opaque origin, no network); this page
// answers its bridge calls with the viewer's own session, so queries pass
// through the views API (row-level security) and record actions through the
// normal record API. Admins open the draft with /view/?draft=1#<slug>.

interface ViewPayload {
  id: string;
  name: string | null;
  slug: string;
  status: 'draft' | 'published';
  draft: boolean;
  module: string;
  queries: ViewInit['queries'];
  can_edit: boolean;
  // admins only: the draft differs from the published version
  unpublished_changes?: boolean;
}

const FRAME_URL = `${import.meta.env.BASE_URL}view-frame/index.html`;
const THEME_VARS = ['--primary', '--page-background', '--surface', '--text', '--muted-text', '--border', '--money', '--danger'];

function parseHash(hash: string): { slug: string; params: Params } {
  const raw = hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  const slug = decodeURIComponent(q < 0 ? raw : raw.slice(0, q)).trim().toLowerCase();
  const params: Params = {};
  if (q >= 0) new URLSearchParams(raw.slice(q + 1)).forEach((v, k) => (params[k] = v));
  return { slug, params };
}

function buildHash(slug: string, params: Params): string {
  const qs = new URLSearchParams(params).toString();
  return `#${slug}${qs ? `?${qs}` : ''}`;
}

export function CustomView() {
  const { me, toast, reloadCustomViews } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const { slug, params } = parseHash(location.hash);
  const draft = new URLSearchParams(location.search).get('draft') === '1';
  const [view, setView] = useState<ViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(400);
  const [frameKey, setFrameKey] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // the latest values for the message handler, which is set up once per frame
  const latest = useRef({ slug, params, draft, view });
  latest.current = { slug, params, draft, view };

  useEffect(() => {
    setView(null);
    setError(null);
    if (!slug) return;
    let live = true;
    api<ViewPayload>('GET', `/v1/views/${encodeURIComponent(slug)}${draft ? '?draft=1' : ''}`)
      .then((v) => {
        if (!live) return;
        setView(v);
        setFrameKey((k) => k + 1);
        document.title = `${v.name ?? v.slug} · ProfitPad CRM`;
      })
      .catch((e: Error) => live && setError(e instanceof ApiError && e.status === 404 ? 'This view does not exist or has not been published.' : e.message));
    return () => {
      live = false;
    };
  }, [slug, draft, reloads]);

  // the draft bar's Publish and Revert to published (admins)
  async function draftAction(action: 'publish' | 'revert') {
    const v = latest.current.view;
    if (!v) return;
    const ask = action === 'publish'
      ? 'Publish the draft? Everyone who can open this view will see it.'
      : 'Throw away the draft\'s changes and go back to the published version? This cannot be undone.';
    if (!confirm(ask)) return;
    setBusy(true);
    try {
      await api('POST', `/v1/views/${encodeURIComponent(v.slug)}/${action}`);
      toast(action === 'publish' ? 'Published' : 'Draft reverted');
      reloadCustomViews().catch(() => undefined);
      setReloads((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const send = useCallback((msg: ToFrame) => frameRef.current?.contentWindow?.postMessage(msg, '*'), []);

  // address params changed (back/forward, or the view's own setParams)
  const paramKey = JSON.stringify(params);
  useEffect(() => {
    if (view) send({ type: 'pcrm:params', params });
  }, [paramKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const runCall = useCallback(async (method: BridgeMethod, args: unknown[]): Promise<unknown> => {
    const { slug: s, params: current, draft: d } = latest.current;
    const str = (v: unknown, what: string) => {
      if (typeof v !== 'string' || v === '') throw new Error(`${what} must be a string`);
      return encodeURIComponent(v);
    };
    switch (method) {
      case 'query':
        return api('POST', `/v1/views/${str(s, 'slug')}/queries/${str(args[0], 'query name')}${d ? '?draft=1' : ''}`, { params: args[1] ?? {} });
      case 'openRecord':
        navigate(`/objects/${str(args[0], 'object')}/${str(args[1], 'id')}`);
        return null;
      case 'navigate': {
        const path = args[0];
        // only places inside the CRM
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('navigate takes a path inside the CRM, like /objects/deals');
        navigate(path);
        return null;
      }
      case 'setParams': {
        const next: Params = { ...current };
        for (const [k, v] of Object.entries((args[0] ?? {}) as Record<string, unknown>)) {
          if (v === undefined || v === null || v === '') delete next[k];
          else next[k] = String(v);
        }
        navigate({ pathname: location.pathname, search: location.search, hash: buildHash(s, next) }, { replace: true });
        return null;
      }
      case 'createRecord':
        return api('POST', `/v1/objects/${str(args[0], 'object')}`, { properties: args[1] ?? {}, associations: args[2] ?? [] });
      case 'updateRecord':
        return api('PATCH', `/v1/objects/${str(args[0], 'object')}/${str(args[1], 'id')}`, { properties: args[2] ?? {} });
      case 'linkRecords':
        return api('PUT', `/v1/objects/${str(args[0], 'object')}/${str(args[1], 'id')}/associations/${str(args[2], 'object')}/${str(args[3], 'id')}`, {});
    }
    throw new Error(`unknown call ${method}`);
  }, [navigate, location.pathname, location.search]);

  useEffect(() => {
    const onMessage = (e: MessageEvent<FromFrame>) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow || !e.data || typeof e.data !== 'object') return;
      const msg = e.data;
      const v = latest.current.view;
      if (msg.type === 'pcrm:ready' && v) {
        const style = getComputedStyle(document.documentElement);
        const theme = Object.fromEntries(THEME_VARS.map((k) => [k, style.getPropertyValue(k).trim()]).filter(([, val]) => val));
        send({
          type: 'pcrm:init',
          module: v.module,
          queries: v.queries,
          theme,
          me: { id: me.user?.id ?? null, name: me.user?.name ?? null, is_admin: me.is_admin },
          params: latest.current.params,
          view: { id: v.id, name: v.name, slug: v.slug, draft: v.draft }
        });
      } else if (msg.type === 'pcrm:height') {
        setHeight(Math.max(200, Math.min(Number(msg.height) || 0, 100_000)));
      } else if (msg.type === 'pcrm:error') {
        setError(`This view could not start: ${msg.message}`);
      } else if (msg.type === 'pcrm:call') {
        runCall(msg.method, Array.isArray(msg.args) ? msg.args : [])
          .then((value) => {
            send({ type: 'pcrm:reply', id: msg.id, ok: true, value });
            if (msg.method === 'createRecord' || msg.method === 'updateRecord' || msg.method === 'linkRecords') toast();
          })
          .catch((err: Error) => send({ type: 'pcrm:reply', id: msg.id, ok: false, error: { message: err.message, status: err instanceof ApiError ? err.status : undefined } }));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [me, runCall, send, toast]);

  return (
    <>
      {mobile && <MobileHeader />}
      <div className="custom-view">
        {view?.can_edit && (
          <div className="custom-view-bar">
            <span className="muted">{view.name}</span>
            {view.draft && <span className="pill">Draft</span>}
            <span className="spacer" />
            {view.draft && view.unpublished_changes && (
              <>
                {view.status === 'published' && (
                  <button className="btn small" disabled={busy} onClick={() => draftAction('revert')}>Revert to published</button>
                )}
                <button className="btn small primary" disabled={busy} onClick={() => draftAction('publish')}>Publish</button>
              </>
            )}
            {view.status === 'published' && (
              <Link to={{ pathname: '/view/', search: draft ? '' : '?draft=1', hash: location.hash }}>{draft ? 'See published' : 'See draft'}</Link>
            )}
            <Link to={`/objects/views/${view.id}`}>Code</Link>
          </div>
        )}
        {!slug && <div className="page"><p className="muted">No view picked. Admins can see every view under <Link to="/objects/views">Views</Link>.</p></div>}
        {error && <div className="page"><div className="error">{error}</div></div>}
        {view && !error && (
          <iframe
            key={frameKey}
            ref={frameRef}
            className="custom-view-frame"
            title={view.name ?? view.slug}
            src={FRAME_URL}
            sandbox="allow-scripts"
            style={{ height }}
          />
        )}
      </div>
    </>
  );
}
