import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { api, type CustomViewSummary, type Me, type NavItem, type ObjectSummary } from './api';
import { applyTheme, defaultDropdownColors, type Theme } from './theme';

interface AppState {
  me: Me;
  objects: ObjectSummary[];
  objectByName: Map<string, ObjectSummary>;
  nav: NavItem[];
  // which menu the sidebar shows: the user's own, their menu group's, or the default
  navSource: 'default' | 'group' | 'user';
  // whether this user may change their own menu (Super Admins always; others when their group, or the everyone setting, allows it)
  navCanEdit: boolean;
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
  // the 16 colours offered for dropdown choices (Settings, Theme)
  dropdownColors: string[];
  setDropdownColors: (colors: string[]) => void;
  // the portal's logo as a data URL (Settings, Theme), null for the CRM mark
  logo: string | null;
  setLogo: (logo: string | null) => void;
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
  const [navSource, setNavSource] = useState<'default' | 'group' | 'user'>('default');
  const [navCanEdit, setNavCanEdit] = useState(false);
  const [bottomLeft, setBottomLeft] = useState<'menu' | 'home'>('menu');
  const [bottomNav, setBottomNav] = useState<NavItem[]>([]);
  const [customViews, setCustomViews] = useState<CustomViewSummary[]>([]);
  const [theme, setThemeState] = useState<Theme>(() => applyTheme(undefined));
  const [dropdownColors, setDropdownColors] = useState<string[]>(defaultDropdownColors);
  const [logo, setLogo] = useState<string | null>(null);
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
    // admins read every object, including ones created after sign-in (readable_objects is from then)
    setObjects(res.results.filter((o) => me.is_admin || me.readable_objects.includes(o.api_name)));
  }, [me]);

  const reloadNav = useCallback(async () => {
    const res = await api<{ source: 'default' | 'group' | 'user'; items: NavItem[]; bottom_left: 'menu' | 'home'; bottom: NavItem[]; can_edit?: boolean }>('GET', '/v1/ui/nav');
    setNav(res.items);
    setNavSource(res.source);
    setNavCanEdit(res.can_edit === true);
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
      api<{ theme?: Partial<Theme>; dropdown_colors?: { colors?: string[] }; logo?: { image?: string | null } }>('GET', '/v1/ui/settings').then((s) => {
        setThemeState(applyTheme(s.theme));
        setLogo(s.logo?.image ?? null);
        if (s.dropdown_colors?.colors?.length === 16) setDropdownColors(s.dropdown_colors.colors);
      })
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
        me, objects, objectByName: new Map(objects.map((o) => [o.api_name, o])), nav, navSource, navCanEdit, bottomLeft, bottomNav, customViews, theme,
        reloadNav, reloadObjects, reloadCustomViews, setTheme, dropdownColors, setDropdownColors, logo, setLogo, signOut, toast
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
