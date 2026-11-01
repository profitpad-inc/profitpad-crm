import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { api, setApiKey, type Me, type NavItem, type ObjectSummary } from './api';
import { applyTheme, type Theme } from './theme';

interface AppState {
  me: Me;
  objects: ObjectSummary[];
  objectByName: Map<string, ObjectSummary>;
  nav: NavItem[];
  navSource: 'default' | 'user';
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
    const res = await api<{ source: 'default' | 'user'; items: NavItem[] }>('GET', '/v1/ui/nav');
    setNav(res.items);
    setNavSource(res.source);
  }, []);

  useEffect(() => {
    Promise.all([
      reloadObjects(),
      reloadNav(),
      api<{ theme?: Partial<Theme> }>('GET', '/v1/ui/settings').then((s) => setThemeState(applyTheme(s.theme)))
    ]).finally(() => setReady(true));
  }, [reloadObjects, reloadNav]);

  const setTheme = useCallback((t: Partial<Theme>) => setThemeState(applyTheme(t)), []);
  const signOut = useCallback(() => {
    setApiKey(null);
    api('POST', '/v1/auth/logout').catch(() => undefined).finally(onSignOut);
  }, [onSignOut]);

  if (!ready) return <div className="splash">Loading…</div>;
  return (
    <Ctx.Provider
      value={{
        me, objects, objectByName: new Map(objects.map((o) => [o.api_name, o])), nav, navSource, theme,
        reloadNav, reloadObjects, setTheme, signOut, toast
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
