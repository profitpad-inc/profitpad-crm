import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, API_BASE, ApiError } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useIsMobile } from '../lib/use-mobile';
import { MobileHeader } from '../components/MobileNav';
import { Modal } from '../components/ui';
import { useAddToMenu } from '../lib/use-add-to-menu';
import type { BridgeMethod, FromFrame, Params, RuntimeError, ToFrame, ViewInit } from '../view-runtime/protocol';

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

// interactive: the key of an integration called while the viewer types, allowed once per page visit
type Ask = { title: string; lines: string[]; send?: boolean; interactive?: string };

// What a view asks to change or send, in words for the confirmation (values cut short)
function describeChange(label: (o: string) => string, method: 'createRecord' | 'updateRecord' | 'linkRecords' | 'callIntegration', args: unknown[]): Ask {
  const short = (v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
  };
  const props = (v: unknown) => {
    const entries = Object.entries((v ?? {}) as Record<string, unknown>);
    return [...entries.slice(0, 12).map(([k, x]) => `${k}: ${x === null ? '(cleared)' : short(x)}`), ...(entries.length > 12 ? [`and ${entries.length - 12} more`] : [])];
  };
  const obj = String(args[0] ?? '');
  if (method === 'callIntegration') {
    const data = args[1];
    const lines = data === null || data === undefined ? ['(no data)'] : typeof data === 'object' && !Array.isArray(data) ? props(data) : [short(data)];
    return { title: `Send to ${label(obj)}`, lines, send: true };
  }
  if (method === 'createRecord') return { title: `Create a record in ${label(obj)}`, lines: props(args[1]) };
  if (method === 'updateRecord') return { title: `Change ${label(obj)} record ${String(args[1] ?? '')}`, lines: props(args[2]) };
  return { title: 'Link two records', lines: [`${label(obj)} ${String(args[1] ?? '')}`, `to ${label(String(args[2] ?? ''))} ${String(args[3] ?? '')}`] };
}

function buildHash(slug: string, params: Params): string {
  const qs = new URLSearchParams(params).toString();
  return `#${slug}${qs ? `?${qs}` : ''}`;
}

export function CustomView() {
  const { me, toast, reloadCustomViews, objectByName } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const { slug, params } = parseHash(location.hash);
  const draft = new URLSearchParams(location.search).get('draft') === '1';
  const [view, setView] = useState<ViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(400);
  // fill views (export const frame = 'fill') get the visible height and scroll themselves
  const [fill, setFill] = useState(false);
  const [fillHeight, setFillHeight] = useState(400);
  const [frameKey, setFrameKey] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  // a view's record changes wait for the viewer's yes (or "don't ask again"
  // for this view while the page is open)
  const [asking, setAsking] = useState<(Ask & { resolve: (ok: boolean) => void }) | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const allowWrites = useRef(false);
  // the same for sending to integrations, asked separately
  const allowSends = useRef(false);
  // integration labels for the confirmation, loaded on a view's first call
  const integrationLabels = useRef<Map<string, { label: string; interactive: boolean }> | null>(null);
  // interactive integrations the viewer allowed on this page, and the asks
  // still open (calls made while typing wait for the same answer)
  const allowedInteractive = useRef(new Set<string>());
  const pendingInteractive = useRef(new Map<string, Promise<boolean>>());
  // the frame loads once; a second load means the view navigated it away
  const frameLoads = useRef(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // the latest values for the message handler, which is set up once per frame
  const latest = useRef({ slug, params, draft, view });
  latest.current = { slug, params, draft, view };
  const menu = useAddToMenu(view?.status === 'published' ? view.slug : null);

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

  useEffect(() => {
    allowWrites.current = false;
    allowSends.current = false;
    integrationLabels.current = null;
    allowedInteractive.current = new Set();
    pendingInteractive.current = new Map();
  }, [slug]);
  useEffect(() => {
    frameLoads.current = 0;
    setFill(false);
  }, [frameKey]);

  // The view cannot see the CRM page scroll, so tell it where it is: how much
  // of the frame is scrolled out of sight above, and how tall the visible area
  // is (useViewport in the kit). Fill views get a fixed height instead.
  useEffect(() => {
    const frame = frameRef.current;
    if (!view || !frame) return;
    const scroller = frame.closest('.main') ?? document.documentElement;
    let raf = 0;
    const update = () => {
      raf = 0;
      const area = scroller.getBoundingClientRect();
      const top = Math.max(area.top, 0);
      const bottom = Math.min(area.bottom, window.innerHeight);
      if (fill) {
        // from the frame's top (when scrolled to the top) to the bottom of the visible area
        setFillHeight(Math.max(300, Math.floor(bottom - (frame.getBoundingClientRect().top + scroller.scrollTop))));
        return;
      }
      const rect = frame.getBoundingClientRect();
      send({ type: 'pcrm:viewport', viewport: { scrollTop: Math.max(0, Math.round(top - rect.top)), viewportHeight: Math.max(0, Math.round(bottom - top)) } });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    schedule();
    return () => {
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [view, frameKey, fill, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // what went wrong in the frame goes to the API, where the view's builder
  // (an admin's AI) reads it with get_view_runtime_errors
  const reportErrors = useCallback((errors: RuntimeError[]) => {
    const { slug: s, draft: d } = latest.current;
    if (!s || !errors.length) return;
    api('POST', `/v1/views/${encodeURIComponent(s)}/errors${d ? '?draft=1' : ''}`, { errors: errors.slice(0, 20) }).catch(() => undefined);
  }, []);

  const confirmWrite = useCallback((change: Ask) => {
    const key = change.interactive;
    if (key) {
      if (allowedInteractive.current.has(key)) return Promise.resolve(true);
      const pending = pendingInteractive.current.get(key);
      if (pending) return pending;
    } else if ((change.send ? allowSends : allowWrites).current) return Promise.resolve(true);
    setDontAsk(false);
    const asked = new Promise<boolean>((resolve) => setAsking({ ...change, resolve }));
    if (key) {
      pendingInteractive.current.set(key, asked);
      asked.then(() => pendingInteractive.current.delete(key));
    }
    return asked;
  }, []);

  function answer(ok: boolean) {
    if (ok && asking?.interactive) allowedInteractive.current.add(asking.interactive);
    else if (ok && dontAsk && asking) (asking.send ? allowSends : allowWrites).current = true;
    asking?.resolve(ok);
    setAsking(null);
  }

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
      case 'phoneRegions': {
        // a public route: without cookies, or the browser refuses the answer (no allow-credentials)
        const res = await fetch(`${API_BASE}/v1/public/phone/regions`, { credentials: 'omit' });
        if (!res.ok) throw new Error(`Could not load the phone countries (HTTP ${res.status})`);
        return res.json();
      }
      case 'checkPhone':
        if (typeof args[0] !== 'string') throw new Error('checkPhone takes the number as a string');
        return api('POST', '/v1/phone/validate', { number: args[0] });
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
      case 'updateRecord':
      case 'linkRecords': {
        const label = (o: string) => objectByName.get(o)?.label_plural ?? o;
        if (!(await confirmWrite(describeChange(label, method, args)))) throw new Error('The viewer did not allow this change');
        break;
      }
      case 'callIntegration': {
        const key = str(args[0], 'integration key');
        if (!integrationLabels.current) {
          const list = await api<{ results: { key: string; label: string; interactive?: boolean }[] }>('GET', '/v1/view-integrations').catch(() => ({ results: [] }));
          integrationLabels.current = new Map(list.results.map((i) => [i.key, { label: i.label, interactive: !!i.interactive }]));
        }
        const labels = integrationLabels.current;
        const ask = describeChange((k) => labels.get(k)?.label ?? k, method, args);
        if (labels.get(key)?.interactive) ask.interactive = key;
        if (!(await confirmWrite(ask))) throw new Error('The viewer did not allow sending this');
        return api('POST', `/v1/views/${str(s, 'slug')}/integrations/${key}${d ? '?draft=1' : ''}`, { data: args[1] ?? null });
      }
    }
    switch (method) {
      case 'createRecord':
        return api('POST', `/v1/objects/${str(args[0], 'object')}`, { properties: args[1] ?? {}, associations: args[2] ?? [] });
      case 'updateRecord':
        return api('PATCH', `/v1/objects/${str(args[0], 'object')}/${str(args[1], 'id')}`, { properties: args[2] ?? {} });
      case 'linkRecords':
        return api('PUT', `/v1/objects/${str(args[0], 'object')}/${str(args[1], 'id')}/associations/${str(args[2], 'object')}/${str(args[3], 'id')}`, {});
    }
    throw new Error(`unknown call ${method}`);
  }, [navigate, location.pathname, location.search, objectByName, confirmWrite]);

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
      } else if (msg.type === 'pcrm:mode') {
        setFill(msg.fill === true);
      } else if (msg.type === 'pcrm:report') {
        if (Array.isArray(msg.errors)) reportErrors(msg.errors);
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
          .catch((err: Error) => {
            send({ type: 'pcrm:reply', id: msg.id, ok: false, error: { message: err.message, status: err instanceof ApiError ? err.status : undefined } });
            if (msg.method === 'query') reportErrors([{ kind: 'query', message: err.message, detail: `query ${String(msg.args?.[0] ?? '')} with params ${JSON.stringify(msg.args?.[1] ?? {}).slice(0, 1000)}` }]);
          });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [me, runCall, send, toast, reportErrors]);

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
            {menu && (
              menu.inMenu
                ? <Link to="/settings/navigation">In menu</Link>
                : <button className="link-btn" disabled={menu.busy} onClick={menu.add}>Add to menu</button>
            )}
            <Link to={`/objects/views/${view.id}`}>Code</Link>
          </div>
        )}
        {!slug && <div className="page"><p className="muted">No view picked. Admins can see every view under <Link to="/objects/views">Views</Link>.</p></div>}
        {(error ?? menu?.error) && <div className="page"><div className="error">{error ?? menu?.error}</div></div>}
        {view && !error && (
          <iframe
            key={frameKey}
            ref={frameRef}
            className="custom-view-frame"
            title={view.name ?? view.slug}
            src={FRAME_URL}
            sandbox="allow-scripts"
            style={{ height: fill ? fillHeight : height }}
            onLoad={() => {
              frameLoads.current += 1;
              if (frameLoads.current > 1) setError('This view tried to open another page, so it was stopped.');
            }}
          />
        )}
      </div>
      {asking && (
        <Modal
          title={asking.send ? 'Allow sending this?' : 'Allow this change?'}
          onClose={() => answer(false)}
          footer={
            <>
              {asking.interactive ? <span style={{ marginRight: 'auto' }} /> : (
                <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 'auto' }}>
                  <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> Don't ask again on this page
                </label>
              )}
              <button className="btn" onClick={() => answer(false)}>Don't allow</button>
              <button className="btn primary" onClick={() => answer(true)}>Allow</button>
            </>
          }
        >
          <p className="muted small" style={{ marginTop: 0 }}>The view "{view?.name ?? slug}" wants to {asking.send ? 'send this as you' : 'make this change as you'}:</p>
          <p style={{ fontWeight: 500 }}>{asking.title}</p>
          {asking.lines.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{asking.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          {asking.interactive && <p className="muted small" style={{ marginBottom: 0 }}>This view sends to it while you type. Allowing it once covers the rest of this visit to the page.</p>}
        </Modal>
      )}
    </>
  );
}
