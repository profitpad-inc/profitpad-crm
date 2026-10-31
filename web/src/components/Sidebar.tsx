import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Ellipsis, PanelLeftClose, PanelLeftOpen, Pencil, Search } from 'lucide-react';
import { useApp } from '../lib/app-context';
import type { NavItem } from '../lib/api';
import { HomeIcon, MORE_GROUPS, ReportingIcon, initials, objectIcon } from '../lib/display';
import { SearchPalette } from './SearchPalette';

const EXPANDED_KEY = 'pcrm.sidebarExpanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function Sidebar() {
  const { me, nav, objectByName, objects } = useApp();
  const [expanded, setExpanded] = useState(readExpanded);
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreTop, setMoreTop] = useState<number | null>(null);
  const moreOpen = moreTop !== null;
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0');
    } catch {
      // per-viewer convenience only
    }
  }, [expanded]);

  // Cmd/Ctrl+K opens search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const userName = me.user?.name || [me.user?.first_name, me.user?.last_name].filter(Boolean).join(' ') || me.key_name;
  const params = new URLSearchParams(location.search);

  function isActive(item: NavItem): boolean {
    if (item.type === 'home') return location.pathname === '/';
    if (item.type === 'reporting') return location.pathname.startsWith('/reporting');
    if (item.type === 'object') return location.pathname.startsWith(`/objects/${item.object}`) && !params.get('view');
    if (item.type === 'view') return location.pathname.startsWith(`/objects/${item.object}`) && params.get('view') === String(item.view_id);
    return false;
  }

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
    let to = '/';
    let label = 'Home';
    let Icon = HomeIcon;
    if (item.type === 'reporting') {
      to = '/reporting';
      label = 'Reporting';
      Icon = ReportingIcon;
    } else if (item.type === 'object' || item.type === 'view') {
      const obj = objectByName.get(item.object);
      if (!obj) return null; // not readable for this user, or archived
      to = item.type === 'view' ? `/objects/${item.object}?view=${item.view_id}` : `/objects/${item.object}`;
      label = item.label ?? obj.label_plural;
      Icon = objectIcon(item.object);
    }
    return (
      <Link key={key} to={to} className={`nav-item${isActive(item) ? ' active' : ''}`} title={expanded ? undefined : label}>
        <Icon size={20} strokeWidth={1.75} />
        {expanded && <span>{label}</span>}
      </Link>
    );
  }

  return (
    <>
      <nav className={`sidebar${expanded ? ' expanded' : ''}`}>
        <div className="sidebar-top">
          <Link to="/" className="logo" title="ProfitPad CRM">P</Link>
          <button className="nav-item" onClick={() => setSearchOpen(true)} title={expanded ? undefined : 'Search (⌘K)'}>
            <Search size={20} strokeWidth={1.75} />
            {expanded && <span>Search</span>}
          </button>
        </div>
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
                <ChevronRight size={16} className="push-right" />
              </>
            )}
          </button>
        </div>
        <div className="sidebar-bottom">
          {me.is_admin && (
            <Link to="/settings/navigation" className="nav-item" title={expanded ? undefined : 'Edit menu'}>
              <Pencil size={18} strokeWidth={1.75} />
              {expanded && <span>Edit menu</span>}
            </Link>
          )}
          <button className="nav-item" onClick={() => setExpanded((v) => !v)} title={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? <PanelLeftClose size={18} strokeWidth={1.75} /> : <PanelLeftOpen size={18} strokeWidth={1.75} />}
            {expanded && <span>Collapse</span>}
          </button>
          <button className="avatar-btn" onClick={() => navigate('/settings')} title={`${userName} · Settings`}>
            <span className="avatar">{initials(userName)}</span>
            {expanded && <span className="avatar-name">{userName}</span>}
          </button>
        </div>
      </nav>
      {moreTop !== null && <MoreMenu objects={objects.map((o) => o.api_name)} anchorTop={moreTop} onClose={() => setMoreTop(null)} />}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
    </>
  );
}

// Fixed size, top aligned with the More button (kept on screen), so it
// doesn't jump when hovering between groups of different lengths.
const MORE_MENU_HEIGHT = 580;

function MoreMenu({ objects, anchorTop, onClose }: { objects: string[]; anchorTop: number; onClose: () => void }) {
  const { objectByName } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const grouped = new Set(MORE_GROUPS.flatMap((g) => g.objects));
  const groups = [
    ...MORE_GROUPS.map((g) => ({ ...g, objects: g.objects.filter((o) => objects.includes(o)) })),
    { label: 'Custom objects', objects: objects.filter((o) => !grouped.has(o)) }
  ].filter((g) => g.objects.length > 0);
  const [group, setGroup] = useState(groups[0]?.label);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.sidebar')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
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
