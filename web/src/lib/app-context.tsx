import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
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
        reloadNav, reloadObjects, setTheme, signOut
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
