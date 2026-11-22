import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, Ellipsis, Eye, Folder, PanelLeftClose, PanelLeftOpen, Pencil, Search } from 'lucide-react';
import { useApp } from '../lib/app-context';
import type { NavItem } from '../lib/api';
import { initials, moreGroups, objectIcon } from '../lib/display';
import { isNavActive, navLink } from '../lib/nav';
import { ViewIcon } from '../lib/lucide-icons';
import { onFrameFocus } from '../lib/frame-focus';
import { SearchPalette } from './SearchPalette';
import { BrandMark } from './Logo';
import { MentionsButton } from './MentionsMenu';

const EXPANDED_KEY = 'pcrm.sidebarExpanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

// 'rail' is the desktop sidebar; 'drawer' is the same menu, always expanded,
// inside the phone hamburger drawer (More and sections open inline there).
// On the rail, More and each section open a flyout beside the sidebar, one at a time.
type Flyout = { key: string; top: number };
export function Sidebar({ variant = 'rail' }: { variant?: 'rail' | 'drawer' }) {
  const { me, nav, navCanEdit, navPreview, objectByName, objects, customViews, logo, moreHidden } = useApp();
  const moreObjects = objects.map((o) => o.api_name).filter((o) => !moreHidden.includes(o));
  const drawer = variant === 'drawer';
  const [expandedPref, setExpanded] = useState(readExpanded);
  const expanded = drawer || expandedPref;
  const [searchOpen, setSearchOpen] = useState(false);
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const moreOpen = flyout?.key === 'more';
  // On the rail, hovering a section or More opens its flyout (switching from
  // another one), like hovering the groups inside More; a click opens it too
  // (touch, keyboard) and never closes it, since hover already opened it. In
  // the phone drawer a tap toggles the inline list.
  const openFlyout = (key: string, el: HTMLElement) =>
    setFlyout((f) => (f?.key === key ? f : { key, top: el.getBoundingClientRect().top }));
  const toggleFlyout = (key: string, el: HTMLElement) => {
    if (!drawer) openFlyout(key, el);
    else setFlyout((f) => (f?.key === key ? null : { key, top: 0 }));
  };
  const hoverFlyout = (key: string) => (drawer ? undefined : (e: React.MouseEvent<HTMLElement>) => openFlyout(key, e.currentTarget));
  const closeFlyout = () => setFlyout(null);
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, expandedPref ? '1' : '0');
    } catch {
      // per-viewer convenience only
    }
  }, [expandedPref]);

  // Cmd/Ctrl+K opens search
  useEffect(() => {
    if (drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const userName = me.user?.name || [me.user?.first_name, me.user?.last_name].filter(Boolean).join(' ') || me.key_name;
  function renderItem(item: NavItem, key: string) {
    if (item.type === 'divider') return <div key={key} className="nav-divider" />;
    if (item.type === 'section') {
      const open = flyout?.key === key;
      const holdsActive = item.items.some((child) => child.type !== 'divider' && child.type !== 'section' && isNavActive(child, location));
      return (
        <div key={key} className="nav-section">
          <button
            className={`nav-item${open || holdsActive ? ' active' : ''}`}
            onClick={(e) => toggleFlyout(key, e.currentTarget)}
            onMouseEnter={hoverFlyout(key)}
            aria-label={expanded ? undefined : item.label}
            aria-expanded={open}
            data-flyout-toggle
          >
            <ViewIcon icon={item.icon} fallback={Folder} size={20} strokeWidth={1.75} />
            {expanded && (
              <>
                <span>{item.label}</span>
                {drawer && open ? <ChevronDown size={16} className="push-right" /> : <ChevronRight size={16} className="push-right" />}
              </>
            )}
          </button>
          {drawer && open && <div className="nav-section-inline">{item.items.map((child, i) => renderItem(child, `${key}.${i}`))}</div>}
        </div>
      );
    }
    const link = navLink(item, objectByName, customViews);
    if (!link) return null;
    const { to, label, Icon, iconName } = link;
    return (
      <Link key={key} to={to} className={`nav-item${isNavActive(item, location) ? ' active' : ''}`} title={expanded ? undefined : label}>
        <ViewIcon icon={iconName} fallback={Icon} size={20} strokeWidth={1.75} />
        {expanded && <span>{label}</span>}
      </Link>
    );
  }

  return (
    <>
      <nav className={`sidebar${expanded ? ' expanded' : ''}${drawer ? ' drawer-menu' : ''}`}>
        <div className="sidebar-top">
          <Link to="/" className="logo" title="ProfitPad CRM" aria-label="ProfitPad CRM"><BrandMark src={logo} size={28} /></Link>
          <button className="nav-item" onClick={() => setSearchOpen(true)} title={expanded ? undefined : 'Search (⌘K)'}>
            <Search size={20} strokeWidth={1.75} />
            {expanded && <span>Search</span>}
          </button>
        </div>
        {navPreview && (
          <div className="nav-preview-note" title={`Previewing ${navPreview.label}. Your own menu comes back when you leave this page.`}>
            <Eye size={16} strokeWidth={1.75} />
            {expanded && <span>Previewing {navPreview.label}</span>}
          </div>
        )}
        <div className="sidebar-items">
          {nav.map((item, i) => renderItem(item, String(i)))}
          <button className={`nav-item${moreOpen ? ' active' : ''}`} onClick={(e) => toggleFlyout('more', e.currentTarget)} onMouseEnter={hoverFlyout('more')} aria-label={expanded ? undefined : 'More'} aria-expanded={moreOpen} data-flyout-toggle>
            <Ellipsis size={20} strokeWidth={1.75} />
            {expanded && (
              <>
                <span>More</span>
                {drawer && moreOpen ? <ChevronDown size={16} className="push-right" /> : <ChevronRight size={16} className="push-right" />}
              </>
            )}
          </button>
          {drawer && moreOpen && <InlineMore objects={moreObjects} />}
        </div>
        <div className="sidebar-bottom">
          {me.user && <MentionsButton expanded={expanded} />}
          {(me.is_admin || navCanEdit) && (
            <Link to="/settings/navigation" className="nav-item" title={expanded ? undefined : 'Edit menu'}>
              <Pencil size={18} strokeWidth={1.75} />
              {expanded && <span>Edit menu</span>}
            </Link>
          )}
          {!drawer && (
            <button className="nav-item" onClick={() => setExpanded((v) => !v)} title={expanded ? 'Collapse' : 'Expand'}>
              {expanded ? <PanelLeftClose size={18} strokeWidth={1.75} /> : <PanelLeftOpen size={18} strokeWidth={1.75} />}
              {expanded && <span>Collapse</span>}
            </button>
          )}
          <Link to="/settings" className="avatar-btn" title={`${userName} · Settings`}>
            <span className="avatar">{initials(userName)}</span>
            {expanded && <span className="avatar-name">{userName}</span>}
          </Link>
        </div>
      </nav>
      {!drawer && flyout && (flyout.key === 'more'
        ? <MoreMenu objects={moreObjects} anchorTop={flyout.top} onClose={closeFlyout} />
        : <SectionMenu section={nav[Number(flyout.key)]} anchorTop={flyout.top} onClose={closeFlyout} />)}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
    </>
  );
}

// Fixed size, top aligned with the More button (kept on screen), so it
// doesn't jump when hovering between groups of different lengths.
const MORE_MENU_HEIGHT = 580;

// Drawer version of More: every group listed in place, no flyout.
function InlineMore({ objects }: { objects: string[] }) {
  const { objectByName } = useApp();
  return (
    <div className="nav-section">
      {moreGroups(objects).map((g) => (
        <div key={g.label} className="nav-section">
          <div className="nav-section-head">{g.label}</div>
          {g.objects.map((o) => {
            const Icon = objectIcon(o);
            return (
              <Link key={o} to={`/objects/${o}`} className="nav-item">
                <Icon size={20} strokeWidth={1.75} />
                <span>{objectByName.get(o)?.label_plural ?? o}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Closes a flyout on a click outside it (anywhere in the sidebar too, except the
// More and section buttons, which open it themselves), Escape, or focus moving into a view's frame.
function useFlyoutClose(ref: RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-flyout-toggle]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    const offFrame = onFrameFocus(onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      offFrame();
    };
  }, [ref, onClose]);
}

function MoreMenu({ objects, anchorTop, onClose }: { objects: string[]; anchorTop: number; onClose: () => void }) {
  const { objectByName } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const groups = moreGroups(objects);
  const [group, setGroup] = useState(groups[0]?.label);
  useFlyoutClose(ref, onClose);

  const current = groups.find((g) => g.label === group) ?? groups[0];
  return (
    <div
      className="more-menu"
      ref={ref}
      style={{
        height: Math.min(MORE_MENU_HEIGHT, window.innerHeight - 16),
        top: Math.max(8, Math.min(anchorTop - 16, window.innerHeight - MORE_MENU_HEIGHT - 8))
      }}
    >
      <div className="more-groups">
        <h3>More</h3>
        {groups.length === 0 && <div className="section-menu-empty">Everything here is hidden</div>}
        {groups.map((g) => (
          <button key={g.label} className={`more-group${g.label === current?.label ? ' active' : ''}`} onMouseEnter={() => setGroup(g.label)} onClick={() => setGroup(g.label)}>
            <span>{g.label}</span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      <div className="more-objects">
        {current?.objects.map((o) => {
          const Icon = objectIcon(o);
          return (
            <Link key={o} to={`/objects/${o}`} className="more-object" onClick={onClose}>
              <Icon size={16} strokeWidth={1.75} />
              <span>{objectByName.get(o)?.label_plural ?? o}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// A section's flyout: its links in one column, top aligned with the section's
// button and moved up when it would run off the bottom of the window.
function SectionMenu({ section, anchorTop, onClose }: { section: NavItem | undefined; anchorTop: number; onClose: () => void }) {
  const { objectByName, customViews } = useApp();
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(Math.max(8, anchorTop - 16));
  useFlyoutClose(ref, onClose);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchorTop - 16, window.innerHeight - h - 8)));
  }, [anchorTop, section]);

  if (section?.type !== 'section') return null;
  return (
    <div className="more-menu section-menu" ref={ref} style={{ top, maxHeight: window.innerHeight - 16 }}>
      <h3>{section.label}</h3>
      {section.items.map((item, i) => {
        if (item.type === 'divider') return <div key={i} className="section-menu-divider" />;
        const link = navLink(item, objectByName, customViews);
        if (!link) return null;
        const { to, label, Icon, iconName } = link;
        return (
          <Link key={i} to={to} className={`more-object${isNavActive(item, location) ? ' active' : ''}`} onClick={onClose}>
            <ViewIcon icon={iconName} fallback={Icon} size={16} strokeWidth={1.75} />
            <span>{label}</span>
          </Link>
        );
      })}
      {section.items.length === 0 && <div className="section-menu-empty">Nothing in this section yet</div>}
    </div>
  );
}
