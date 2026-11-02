import type { Location } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import type { CustomViewSummary, NavItem, ObjectSummary } from './api';
import { HomeIcon, objectIcon } from './display';
import { DEFAULT_VIEW_ICON } from './lucide-icons';

export interface NavLinkTarget {
  to: string;
  label: string;
  Icon: LucideIcon;
  // a custom view's Lucide icon name; draw it with ViewIcon (Icon is the fallback)
  iconName?: string | null;
}

// Where a menu link goes, or null when this user cannot open it (and for dividers and sections).
export function navLink(item: NavItem, objectByName: Map<string, ObjectSummary>, customViews: CustomViewSummary[]): NavLinkTarget | null {
  if (item.type === 'home') return { to: '/', label: 'Home', Icon: HomeIcon };
  if (item.type === 'custom_view') {
    const view = customViews.find((v) => v.slug === item.slug);
    if (!view) return null; // not published, or not for this user
    return { to: `/view/#${item.slug}`, label: item.label ?? view.name ?? item.slug, Icon: DEFAULT_VIEW_ICON, iconName: view.icon };
  }
  if (item.type === 'object' || item.type === 'view') {
    const obj = objectByName.get(item.object);
    if (!obj) return null; // not readable for this user, or archived
    return {
      to: item.type === 'view' ? `/objects/${item.object}?view=${item.view_id}` : `/objects/${item.object}`,
      label: item.label ?? obj.label_plural,
      Icon: objectIcon(item.object)
    };
  }
  return null;
}

export function isNavActive(item: NavItem, location: Location): boolean {
  const params = new URLSearchParams(location.search);
  if (item.type === 'home') return location.pathname === '/';
  if (item.type === 'custom_view') return location.pathname.startsWith('/view') && location.hash.replace(/^#/, '').split('?')[0].toLowerCase() === item.slug;
  if (item.type === 'object') return location.pathname.startsWith(`/objects/${item.object}`) && !params.get('view');
  if (item.type === 'view') return location.pathname.startsWith(`/objects/${item.object}`) && params.get('view') === String(item.view_id);
  return false;
}
