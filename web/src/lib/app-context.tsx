import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { api, type CustomViewSummary, type Me, type NavItem, type ObjectSummary } from './api';
import { applyTheme, type Theme } from './theme';

interface AppState {
  me: Me;
  objects: ObjectSummary[];
  objectByName: Map<string, ObjectSummary>;
  nav: NavItem[];
  navSource: 'default' | 'user';
  // mobile bottom bar: the left button, then the links (Search is always added after them)
  bottomLeft: 'menu' | 'home';
  bottomNav: NavItem[];
  // custom views this user can open (menu items for others are hidden)
  customViews: CustomViewSummary[];
  reloadCustomViews: () => Promise<void>;
  theme: Theme;
  reloadNav: () => Promise<void>;
  reloadObjects: () => Promise<void>;
  setTheme: (t: Partial<Theme>) => void;
  signOut: () => void;
  toast: (message?: string) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function AppProvider({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const [nav, setNav] = useState<NavItem[]>([]);
  const [navSource, setNavSource] = useState<'default' | 'user'>('default');
  const [bottomLeft, setBottomLeft] = useState<'menu' | 'home'>('menu');
  const [bottomNav, setBottomNav] = useState<NavItem[]>([]);
  const [customViews, setCustomViews] = useState<CustomViewSummary[]>([]);
  const [theme, setThemeState] = useState<Theme>(() => applyTheme(undefined));
  const [ready, setReady] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const toast = useCallback((msg = 'Saved') => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setToastMessage(msg);
    timerRef.current = window.setTimeout(() => {
      setToastMessage(null);
    }, 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const reloadObjects = useCallback(async () => {
    const res = await api<{ results: ObjectSummary[] }>('GET', '/v1/schema');
    setObjects(res.results.filter((o) => me.readable_objects.includes(o.api_name)));
  }, [me]);

  const reloadNav = useCallback(async () => {
    const res = await api<{ source: 'default' | 'user'; items: NavItem[]; bottom_left: 'menu' | 'home'; bottom: NavItem[] }>('GET', '/v1/ui/nav');
    setNav(res.items);
    setNavSource(res.source);
    setBottomLeft(res.bottom_left ?? 'menu');
    setBottomNav(res.bottom ?? []);
  }, []);

  const reloadCustomViews = useCallback(async () => {
    const res = await api<{ results: CustomViewSummary[] }>('GET', '/v1/views');
    setCustomViews(res.results);
  }, []);

  useEffect(() => {
    Promise.all([
      reloadObjects(),
      reloadNav(),
      reloadCustomViews().catch(() => undefined),
      api<{ theme?: Partial<Theme> }>('GET', '/v1/ui/settings').then((s) => setThemeState(applyTheme(s.theme)))
    ]).finally(() => setReady(true));
  }, [reloadObjects, reloadNav, reloadCustomViews]);

  const setTheme = useCallback((t: Partial<Theme>) => setThemeState(applyTheme(t)), []);
  const signOut = useCallback(() => {
    api('POST', '/v1/auth/logout').catch(() => undefined).finally(onSignOut);
  }, [onSignOut]);

  if (!ready) return <div className="splash">Loading…</div>;
  return (
    <Ctx.Provider
      value={{
        me, objects, objectByName: new Map(objects.map((o) => [o.api_name, o])), nav, navSource, bottomLeft, bottomNav, customViews, theme,
        reloadNav, reloadObjects, reloadCustomViews, setTheme, signOut, toast
      }}
    >
      {children}
      {toastMessage &&
        createPortal(
          <div className="toast" role="status" aria-live="polite" onClick={() => setToastMessage(null)}>
            <Check size={16} className="toast-icon" />
            <span>{toastMessage}</span>
          </div>,
          document.body
        )}
    </Ctx.Provider>
  );
}
