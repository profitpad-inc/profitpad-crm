import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, API_BASE, ApiError } from '../lib/api';
import { useApp } from '../lib/app-context';
import { useIsMobile } from '../lib/use-mobile';
import { MobileHeader } from '../components/MobileNav';
import { Modal } from '../components/ui';
import { useAddToMenu } from '../lib/use-add-to-menu';
import type { RecordBack } from './RecordPage';
import { fileInfo, fileLink, formatBytes, openFile, uploadFile } from '../lib/files';
import type { BridgeMethod, FromFrame, Params, RuntimeError, ToFrame, ViewFile, ViewInit } from '../view-runtime/protocol';
import { checkExternalUrl } from '../view-runtime/external-url';
import { confirmDialog } from '../components/confirm';

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
  // someone allowed the view's record changes, so nobody is asked (0062)
  writes_allowed?: boolean;
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

type Ask = { title: string; lines: string[] };

// What a view asks to change, in words for the confirmation (values cut short)
function describeChange(label: (o: string) => string, method: 'createRecord' | 'updateRecord' | 'linkRecords' | 'uploadFile', args: unknown[]): Ask {
  const short = (v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
  };
  const props = (v: unknown) => {
    const entries = Object.entries((v ?? {}) as Record<string, unknown>);
    return [...entries.slice(0, 12).map(([k, x]) => `${k}: ${x === null ? '(cleared)' : short(x)}`), ...(entries.length > 12 ? [`and ${entries.length - 12} more`] : [])];
  };
  if (method === 'uploadFile') {
    const blob = args[0] as Blob;
    return { title: 'Upload a file', lines: [`${String(args[1] ?? '') || (blob as File).name || 'file'} (${formatBytes(blob.size)})`] };
  }
  const obj = String(args[0] ?? '');
  if (method === 'createRecord') return { title: `Create a record in ${label(obj)}`, lines: props(args[1]) };
  if (method === 'updateRecord') return { title: `Change ${label(obj)} record ${String(args[1] ?? '')}`, lines: props(args[2]) };
  return { title: 'Link two records', lines: [`${label(obj)} ${String(args[1] ?? '')}`, `to ${label(String(args[2] ?? ''))} ${String(args[3] ?? '')}`] };
}

// Links a view opens (openUrl). The viewer is asked "You're leaving the CRM
// for <domain>" each time, unless they ticked "Don't ask again" for that exact
// domain, which this browser remembers for them (not a shared allowlist: a
// link carries no CRM data on its own, so trusting a site is each viewer's
// call). A link the viewer did not just tap or click always asks, so a view
// cannot open tabs by itself, and the dialog's Open button is a real link the
// viewer taps, which phones accept as the user's own gesture.
const trustedKey = (userId: string | null | undefined) => `pcrm.trustedLinkDomains.${userId ?? 'anon'}`;
function trustedDomains(userId: string | null | undefined): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(trustedKey(userId)) ?? '[]');
    return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}
function trustDomain(userId: string | null | undefined, host: string) {
  try {
    const list = [host, ...trustedDomains(userId).filter((d) => d !== host)].slice(0, 200);
    localStorage.setItem(trustedKey(userId), JSON.stringify(list));
  } catch {
    // private window or blocked storage: it asks again next time
  }
}
// The viewer tapped or clicked within the last few seconds. A tap inside the
// view's frame counts for this page too (browsers pass it up to the frame's
// parents), and the bridge message arrives well within that time.
function hasUserGesture(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return ua?.isActive === true;
}
function openTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

type LinkAsk = { url: string; host: string; resolve: (opened: boolean) => void };

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
  // A view's record changes are asked about once per view: the first yes
  // allows them for everyone, from then on (0062). Calls made while the
  // question is open wait for the same answer. Integrations are never asked:
  // an admin turning one on is the approval.
  const [asking, setAsking] = useState<(Ask & { resolve: (ok: boolean) => void }) | null>(null);
  // a file the view asked to open when the browser blocked the new tab: the
  // viewer opens it with a click of their own
  const [blockedOpen, setBlockedOpen] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<LinkAsk | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const leavingRef = useRef<LinkAsk | null>(null);
  leavingRef.current = leaving;
  const allowWrites = useRef(false);
  const pendingAsk = useRef<Promise<boolean> | null>(null);
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
        allowWrites.current = v.writes_allowed === true;
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
    pendingAsk.current = null;
    leavingRef.current?.resolve(false);
    leavingRef.current = null;
    setLeaving(null);
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
    if (allowWrites.current) return Promise.resolve(true);
    if (pendingAsk.current) return pendingAsk.current;
    const asked = new Promise<boolean>((resolve) => setAsking({ ...change, resolve }));
    pendingAsk.current = asked;
    asked.then(() => (pendingAsk.current = null));
    return asked;
  }, []);

  function answer(ok: boolean) {
    if (ok) {
      allowWrites.current = true;
      const { slug: s, draft: d } = latest.current;
      // remembered for everyone; if it fails, only this visit is allowed
      if (s) api('POST', `/v1/views/${encodeURIComponent(s)}/allow-writes${d ? '?draft=1' : ''}`).catch(() => undefined);
    }
    asking?.resolve(ok);
    setAsking(null);
  }

  const finishLink = (opened: boolean) => {
    const ask = leavingRef.current;
    if (!ask) return;
    if (opened && dontAskAgain) trustDomain(me.user?.id, ask.host);
    ask.resolve(opened);
    setLeaving(null);
  };

  // the draft bar's Publish and Revert to published (admins)
  async function draftAction(action: 'publish' | 'revert') {
    const v = latest.current.view;
    if (!v) return;
    const ok = action === 'publish'
      ? await confirmDialog('Everyone who can open this view will see it.', { title: 'Publish the draft?', confirmLabel: 'Publish' })
      : await confirmDialog('The draft\'s changes are thrown away and the view goes back to the published version. This cannot be undone.', { title: 'Revert to published?', confirmLabel: 'Revert', danger: true });
    if (!ok) return;
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

  // a record opened from the view: its back link returns here, to the same
  // address (params keep an open panel or filters), not to the object's table
  const backHere = (): RecordBack => ({
    back: { to: `${location.pathname}${location.search}${location.hash}`, label: latest.current.view?.name ?? latest.current.slug ?? 'View' }
  });

  // callId: the frame's id for this call, for upload progress messages
  const runCall = useCallback(async (method: BridgeMethod, args: unknown[], callId: number): Promise<unknown> => {
    const { slug: s, params: current, draft: d } = latest.current;
    const str = (v: unknown, what: string) => {
      if (typeof v !== 'string' || v === '') throw new Error(`${what} must be a string`);
      return encodeURIComponent(v);
    };
    const fileId = (v: unknown) => {
      if (typeof v !== 'string' || !/^[0-9a-f]{10}$/.test(v)) throw new Error('a file id is 10 characters, 0-9 and a-f');
      return v;
    };
    const asViewFile = (f: { id: string; name: string | null; mime_type: string | null; size_bytes: number | null }): ViewFile =>
      ({ id: f.id, name: f.name, mime_type: f.mime_type, size_bytes: f.size_bytes });
    switch (method) {
      case 'openFile': {
        // the tab opens before any await, while the viewer's click still counts
        const id = fileId(args[0]);
        if (args[1] === true) {
          await openFile(id, true);
          return null;
        }
        const tab = window.open('', '_blank');
        if (!tab) {
          setBlockedOpen(id);
          return null;
        }
        try {
          const url = await fileLink(id);
          tab.opener = null;
          tab.location.href = url;
        } catch (err) {
          tab.close();
          throw err;
        }
        return null;
      }
      case 'getFiles': {
        const ids = args[0];
        if (!Array.isArray(ids) || ids.length > 100) throw new Error('getFiles takes a list of up to 100 file ids');
        const wanted = [...new Set(ids.map(fileId))];
        return (await fileInfo(wanted)).map(asViewFile);
      }
      case 'fileBlob': {
        // the frame cannot load links, so the page reads the bytes and hands them over
        const res = await fetch(`${API_BASE}/v1/files/${fileId(args[0])}/content`, { credentials: 'include' });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new ApiError(res.status, data?.message ?? `Could not read the file (HTTP ${res.status})`, data?.error);
        }
        return res.blob();
      }
      case 'query':
        return api('POST', `/v1/views/${str(s, 'slug')}/queries/${str(args[0], 'query name')}${d ? '?draft=1' : ''}`, { params: args[1] ?? {} });
      case 'openRecord':
        navigate(`/objects/${str(args[0], 'object')}/${str(args[1], 'id')}`, { state: backHere() });
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
        navigate(path, { state: backHere() });
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
      // an upload is a change like the others (it creates a file record)
      case 'uploadFile':
      case 'createRecord':
      case 'updateRecord':
      case 'linkRecords': {
        if (method === 'uploadFile') {
          if (!(args[0] instanceof Blob)) throw new Error('uploadFile takes a File or Blob');
          if (args[1] !== null && args[1] !== undefined && typeof args[1] !== 'string') throw new Error('the file name must be a string');
        }
        const label = (o: string) => objectByName.get(o)?.label_plural ?? o;
        if (!(await confirmWrite(describeChange(label, method, args)))) throw new Error('The viewer did not allow this change');
        break;
      }
      case 'openUrl': {
        const link = checkExternalUrl(args[0]);
        if (!link.ok) throw new Error(link.error);
        if (hasUserGesture() && trustedDomains(me.user?.id).includes(link.host)) {
          openTab(link.url);
          return { opened: true };
        }
        if (leavingRef.current) throw new Error('Another link is already waiting for the viewer');
        const opened = await new Promise<boolean>((resolve) => {
          const ask = { url: link.url, host: link.host, resolve };
          leavingRef.current = ask;
          setDontAskAgain(false);
          setLeaving(ask);
        });
        return { opened };
      }
      case 'callIntegration':
        // not asked: an admin enabled the integration and chose who may use it
        return api('POST', `/v1/views/${str(s, 'slug')}/integrations/${str(args[0], 'integration key')}${d ? '?draft=1' : ''}`, { data: args[1] ?? null });
    }
    switch (method) {
      case 'createRecord':
        return api('POST', `/v1/objects/${str(args[0], 'object')}`, { properties: args[1] ?? {}, associations: args[2] ?? [] });
      case 'updateRecord':
        return api('PATCH', `/v1/objects/${str(args[0], 'object')}/${str(args[1], 'id')}`, { properties: args[2] ?? {} });
      case 'uploadFile': {
        const blob = args[0] as Blob;
        const name = (typeof args[1] === 'string' && args[1].trim()) || (blob instanceof File && blob.name) || 'file';
        const file = blob instanceof File && blob.name === name ? blob : new File([blob], name, { type: blob.type });
        const t = args[2] as { object?: unknown; id?: unknown; property?: unknown } | null;
        const target = t && typeof t === 'object'
          ? { object: String(t.object ?? ''), record_id: String(t.id ?? ''), property: String(t.property ?? '') }
          : null;
        if (target && (!target.object || !target.record_id || !target.property)) throw new Error('uploadFile: object, id and property go together');
        const id = await uploadFile(file, target, (fraction) => send({ type: 'pcrm:progress', id: callId, fraction }));
        const [info] = await fileInfo([id]);
        return info ? asViewFile(info) : { id, name, mime_type: file.type || null, size_bytes: file.size };
      }
      case 'linkRecords':
        return api('PUT', `/v1/objects/${str(args[0], 'object')}/${str(args[1], 'id')}/associations/${str(args[2], 'object')}/${str(args[3], 'id')}`, {});
    }
    throw new Error(`unknown call ${method}`);
  }, [navigate, location.pathname, location.search, location.hash, objectByName, confirmWrite, send, me.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
        runCall(msg.method, Array.isArray(msg.args) ? msg.args : [], msg.id)
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
      {blockedOpen && (
        <Modal
          title="Open the file?"
          onClose={() => setBlockedOpen(null)}
          footer={
            <>
              <button className="btn" onClick={() => setBlockedOpen(null)}>Cancel</button>
              <button
                className="btn primary"
                onClick={() => {
                  const id = blockedOpen;
                  setBlockedOpen(null);
                  openFile(id).catch((e: Error) => setError(e.message));
                }}
              >
                Open
              </button>
            </>
          }
        >
          <p className="muted small" style={{ margin: 0 }}>The browser stopped the view from opening a new tab. Open the file here instead.</p>
        </Modal>
      )}
      {leaving && (
        <Modal
          title="You're leaving the CRM"
          onClose={() => finishLink(false)}
          footer={
            <>
              <button className="btn" onClick={() => finishLink(false)}>Cancel</button>
              {/* a real link, so the tap itself opens the tab (phones block tabs opened later) */}
              <a className="btn primary" href={leaving.url} target="_blank" rel="noopener noreferrer" onClick={() => finishLink(true)}>
                Open {leaving.host}
              </a>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>The view "{view?.name ?? slug}" wants to open a page on <strong>{leaving.host}</strong> in a new tab.</p>
          <p className="muted small" style={{ wordBreak: 'break-all' }}>{leaving.url.length > 300 ? leaving.url.slice(0, 299) + '…' : leaving.url}</p>
          <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0 }}>
            <input type="checkbox" checked={dontAskAgain} onChange={(e) => setDontAskAgain(e.target.checked)} />
            Don't ask again for {leaving.host}
          </label>
        </Modal>
      )}
      {asking && (
        <Modal
          title="Allow this view to make changes?"
          onClose={() => answer(false)}
          footer={
            <>
              <button className="btn" onClick={() => answer(false)}>Don't allow</button>
              <button className="btn primary" onClick={() => answer(true)}>Allow</button>
            </>
          }
        >
          <p className="muted small" style={{ marginTop: 0 }}>The view "{view?.name ?? slug}" wants to make this change as you:</p>
          <p style={{ fontWeight: 500 }}>{asking.title}</p>
          {asking.lines.length > 0 && <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{asking.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          <p className="muted small" style={{ marginBottom: 0 }}>Allowing it lets this view make changes for everyone who uses it, from now on, without asking again. Each person's changes still follow their own permissions.</p>
        </Modal>
      )}
    </>
  );
}
