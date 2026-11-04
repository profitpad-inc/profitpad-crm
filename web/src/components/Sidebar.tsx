import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, Ellipsis, Eye, PanelLeftClose, PanelLeftOpen, Pencil, Search } from 'lucide-react';
import { useApp } from '../lib/app-context';
import type { NavItem } from '../lib/api';
import { MORE_GROUPS, initials, objectIcon } from '../lib/display';
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
// inside the phone hamburger drawer (More opens inline there).
export function Sidebar({ variant = 'rail' }: { variant?: 'rail' | 'drawer' }) {
  const { me, nav, navCanEdit, navPreview, objectByName, objects, customViews, logo } = useApp();
  const drawer = variant === 'drawer';
  const [expandedPref, setExpanded] = useState(readExpanded);
  const expanded = drawer || expandedPref;
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreTop, setMoreTop] = useState<number | null>(null);
  const moreOpen = moreTop !== null;
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
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
      const closed = collapsedSections.has(key);
      return (
        <div key={key} className="nav-section">
          {expanded ? (
            <button
              className="nav-section-head"
              onClick={() => setCollapsedSections((s) => {
                const next = new Set(s);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })}
            >
              {closed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              <span>{item.label}</span>
            </button>
          ) : (
            <div className="nav-divider" />
          )}
          {(!closed || !expanded) && item.items.map((child, i) => renderItem(child, `${key}.${i}`))}
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
          <button className={`nav-item${moreOpen ? ' active' : ''}`} onClick={(e) => {
            const top = e.currentTarget.getBoundingClientRect().top;
            setMoreTop((v) => (v === null ? top : null));
          }} title={expanded ? undefined : 'More'}>
            <Ellipsis size={20} strokeWidth={1.75} />
            {expanded && (
              <>
                <span>More</span>
                {drawer && moreOpen ? <ChevronDown size={16} className="push-right" /> : <ChevronRight size={16} className="push-right" />}
              </>
            )}
          </button>
          {drawer && moreOpen && <InlineMore objects={objects.map((o) => o.api_name)} />}
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
      {!drawer && moreTop !== null && <MoreMenu objects={objects.map((o) => o.api_name)} anchorTop={moreTop} onClose={() => setMoreTop(null)} />}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
    </>
  );
}

// Fixed size, top aligned with the More button (kept on screen), so it
// doesn't jump when hovering between groups of different lengths.
const MORE_MENU_HEIGHT = 580;

function moreGroups(objects: string[]) {
  const grouped = new Set(MORE_GROUPS.flatMap((g) => g.objects));
  return [
    ...MORE_GROUPS.map((g) => ({ ...g, objects: g.objects.filter((o) => objects.includes(o)) })),
    { label: 'Custom objects', objects: objects.filter((o) => !grouped.has(o)) }
  ].filter((g) => g.objects.length > 0);
}

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

function MoreMenu({ objects, anchorTop, onClose }: { objects: string[]; anchorTop: number; onClose: () => void }) {
  const { objectByName } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const groups = moreGroups(objects);
  const [group, setGroup] = useState(groups[0]?.label);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.sidebar')) onClose();
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
  }, [onClose]);

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
