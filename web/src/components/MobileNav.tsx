import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Folder, Menu as MenuIcon, Search } from 'lucide-react';
import { useApp } from '../lib/app-context';
import type { NavItem } from '../lib/api';
import { isNavActive, navLink } from '../lib/nav';
import { ViewIcon } from '../lib/lucide-icons';
import { SearchPalette } from './SearchPalette';
import { Sidebar } from './Sidebar';

export function userDisplayName(me: ReturnType<typeof useApp>['me']): string {
  return me.user?.name || [me.user?.first_name, me.user?.last_name].filter(Boolean).join(' ') || me.key_name;
}

// The mobile hotbar: the menu's items in order (links this user cannot open are skipped), then Search,
// which is always last. The first item is Menu or Home: Menu opens the full menu as a drawer, and Home turns
// into Menu while the home page is open, so Settings and Mentions are always one or two taps away.
// A section opens a sheet of its links above the bar.
export function BottomBar() {
  const { bottomNav, objectByName, customViews } = useApp();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState<number | null>(null);
  const openSection = sectionOpen === null ? undefined : bottomNav[sectionOpen];

  return (
    <>
      <nav className="bottom-bar">
        {bottomNav.map((item, i) => {
          if (item.type === 'menu' || (item.type === 'home' && location.pathname === '/')) {
            return (
              <button key={i} className={`bottom-item${drawerOpen ? ' active' : ''}`} onClick={() => setDrawerOpen(true)}>
                <MenuIcon size={22} strokeWidth={1.75} />
                <span>Menu</span>
              </button>
            );
          }
          if (item.type === 'section') {
            const holdsActive = item.items.some((child) => isNavActive(child, location));
            return (
              <button
                key={i}
                className={`bottom-item${sectionOpen === i || holdsActive ? ' active' : ''}`}
                onClick={() => setSectionOpen((s) => (s === i ? null : i))}
                aria-expanded={sectionOpen === i}
              >
                <ViewIcon icon={item.icon} fallback={Folder} size={22} strokeWidth={1.75} />
                <span>{item.label}</span>
              </button>
            );
          }
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
      {openSection?.type === 'section' && <SectionSheet section={openSection} onClose={() => setSectionOpen(null)} />}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
      {drawerOpen && <Drawer onClose={() => setDrawerOpen(false)} />}
    </>
  );
}

// A hotbar section's links in a sheet that rises from above the bar. A tap outside, Escape or
// following a link closes it; the bar stays usable underneath.
function SectionSheet({ section, onClose }: { section: Extract<NavItem, { type: 'section' }>; onClose: () => void }) {
  const { objectByName, customViews } = useApp();
  const location = useLocation();
  const [opened] = useState(location.key);
  useEffect(() => {
    if (location.key !== opened) onClose();
  }, [location.key, opened, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const links = section.items.map((item, i) => {
    if (item.type === 'divider') return <div key={i} className="hotbar-sheet-divider" />;
    const link = navLink(item, objectByName, customViews);
    if (!link) return null;
    const { to, label, Icon, iconName } = link;
    return (
      <Link key={i} to={to} className={`hotbar-sheet-item${isNavActive(item, location) ? ' active' : ''}`}>
        <ViewIcon icon={iconName} fallback={Icon} size={20} strokeWidth={1.75} />
        <span>{label}</span>
      </Link>
    );
  });
  return (
    <div className="hotbar-sheet-backdrop" onClick={onClose}>
      <div className="hotbar-sheet" role="dialog" aria-label={section.label} onClick={(e) => e.stopPropagation()}>
        <h3>{section.label}</h3>
        {links.some(Boolean) ? links : <div className="hotbar-sheet-empty">Nothing in this section yet</div>}
      </div>
    </div>
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
