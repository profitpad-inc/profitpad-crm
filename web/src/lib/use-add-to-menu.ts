import { useCallback, useEffect, useState } from 'react';
import { api, type NavItem } from './api';
import { useApp } from './app-context';

function inMenu(items: NavItem[], slug: string): boolean {
  return items.some((it) => (it.type === 'custom_view' && it.slug.toLowerCase() === slug) || (it.type === 'section' && inMenu(it.items, slug)));
}

// Admins: whether a custom view is in the default menu, and adding it to the
// end of that menu (Settings, Navigation menus moves it). null for everyone else
// and until the menu has loaded.
export function useAddToMenu(slug: string | null | undefined) {
  const { me, reloadNav, toast } = useApp();
  const [items, setItems] = useState<NavItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const add = useCallback(async () => {
    if (!items || !slug) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ items: NavItem[] }>('PUT', '/v1/ui/nav/default', { items: [...items, { type: 'custom_view', slug }] });
      setItems(res.items);
      await reloadNav();
      toast('Added to the menu');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [items, slug, reloadNav, toast]);

  if (!me.is_admin || !items || !slug) return null;
  return { inMenu: inMenu(items, slug.toLowerCase()), busy, error, add };
}
