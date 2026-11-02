import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu as MenuIcon, Search } from 'lucide-react';
import { useApp } from '../lib/app-context';
import { HomeIcon, initials } from '../lib/display';
import { isNavActive, navLink } from '../lib/nav';
import { ViewIcon } from '../lib/lucide-icons';
import { SearchPalette } from './SearchPalette';
import { LogoMark } from './Logo';
import { Sidebar } from './Sidebar';

export function userDisplayName(me: ReturnType<typeof useApp>['me']): string {
  return me.user?.name || [me.user?.first_name, me.user?.last_name].filter(Boolean).join(' ') || me.key_name;
}

export function BottomBar() {
  const { bottomLeft, bottomNav, objectByName, customViews } = useApp();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // left: the full menu or Home; links this user cannot open are skipped; Search is always last
  return (
    <>
      <nav className="bottom-bar">
        {bottomLeft === 'menu' ? (
          <button className={`bottom-item${drawerOpen ? ' active' : ''}`} onClick={() => setDrawerOpen(true)}>
            <MenuIcon size={22} strokeWidth={1.75} />
            <span>Menu</span>
          </button>
        ) : (
          <Link to="/" className={`bottom-item${location.pathname === '/' ? ' active' : ''}`}>
            <HomeIcon size={22} strokeWidth={1.75} />
            <span>Home</span>
          </Link>
        )}
        {bottomNav.map((item, i) => {
          const link = navLink(item, objectByName, customViews);
          if (!link) return null;
          const { to, label, Icon, iconName } = link;
          return (
            <Link key={i} to={to} className={`bottom-item${isNavActive(item, location) ? ' active' : ''}`}>
              <ViewIcon icon={iconName} fallback={Icon} size={22} strokeWidth={1.75} />
              <span>{label}</span>
            </Link>
          );
        })}
        <button className={`bottom-item${searchOpen ? ' active' : ''}`} onClick={() => setSearchOpen(true)}>
          <Search size={22} strokeWidth={1.75} />
          <span>Search</span>
        </button>
      </nav>
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
      {drawerOpen && <Drawer onClose={() => setDrawerOpen(false)} />}
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
        <Link to="/" className="logo small" aria-label="ProfitPad CRM"><LogoMark size={24} /></Link>
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
