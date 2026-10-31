import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu as MenuIcon, Search } from 'lucide-react';
import { useApp } from '../lib/app-context';
import { HomeIcon, initials, objectIcon } from '../lib/display';
import { SearchPalette } from './SearchPalette';
import { Sidebar } from './Sidebar';

// Objects pinned to the phone bottom bar, in order. Missing ones are skipped.
const BOTTOM_OBJECTS = ['contacts', 'deals', 'tasks'];

export function userDisplayName(me: ReturnType<typeof useApp>['me']): string {
  return me.user?.name || [me.user?.first_name, me.user?.last_name].filter(Boolean).join(' ') || me.key_name;
}

export function BottomBar() {
  const { objectByName } = useApp();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <>
      <nav className="bottom-bar">
        <Link to="/" className={`bottom-item${location.pathname === '/' ? ' active' : ''}`}>
          <HomeIcon size={22} strokeWidth={1.75} />
          <span>Home</span>
        </Link>
        {BOTTOM_OBJECTS.filter((o) => objectByName.has(o)).map((o) => {
          const Icon = objectIcon(o);
          return (
            <Link key={o} to={`/objects/${o}`} className={`bottom-item${location.pathname.startsWith(`/objects/${o}`) ? ' active' : ''}`}>
              <Icon size={22} strokeWidth={1.75} />
              <span>{objectByName.get(o)?.label_plural}</span>
            </Link>
          );
        })}
        <button className={`bottom-item${searchOpen ? ' active' : ''}`} onClick={() => setSearchOpen(true)}>
          <Search size={22} strokeWidth={1.75} />
          <span>Search</span>
        </button>
      </nav>
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
    </>
  );
}

// Top bar for the phone home page: hamburger opens the full menu as a drawer.
export function MobileHeader() {
  const { me } = useApp();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const userName = userDisplayName(me);

  return (
    <>
      <header className="mobile-header">
        <button className="icon-btn" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
          <MenuIcon size={24} />
        </button>
        <Link to="/" className="logo small">P</Link>
        <span className="mobile-header-title">ProfitPad</span>
        <Link to="/settings" className="push-right" aria-label="Settings">
          <span className="avatar">{initials(userName)}</span>
        </Link>
      </header>
      {drawerOpen && <Drawer onClose={() => setDrawerOpen(false)} />}
    </>
  );
}

function Drawer({ onClose }: { onClose: () => void }) {
  const location = useLocation();
  const [opened] = useState(location.key);

  // Any navigation from inside the drawer closes it.
  useEffect(() => {
    if (location.key !== opened) onClose();
  }, [location.key, opened, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <Sidebar variant="drawer" />
      </div>
    </div>
  );
}
