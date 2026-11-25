import { useEffect, useState } from 'react';
import { api, type NavItem } from './api';
import { useApp } from './app-context';

function inMenu(items: NavItem[], slug: string): boolean {
  return items.some((it) => (it.type === 'custom_view' && it.slug.toLowerCase() === slug) || (it.type === 'section' && inMenu(it.items, slug)));
}

// Admins: whether a custom view is in the default menu. Adding it happens on
// Settings, Navigation menus, which the "Add to menu" links open. null for
// everyone else and until the menu has loaded.
export function useAddToMenu(slug: string | null | undefined) {
  const { me } = useApp();
  const [items, setItems] = useState<NavItem[] | null>(null);

  useEffect(() => {
    if (!me.is_admin) return;
    let live = true;
    api<{ results: { scope: string; items: NavItem[] }[] }>('GET', '/v1/ui/nav/menus')
      .then((r) => live && setItems(r.results.find((m) => m.scope === 'default')?.items ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [me.is_admin]);

  if (!me.is_admin || !items || !slug) return null;
  return { inMenu: inMenu(items, slug.toLowerCase()) };
}
