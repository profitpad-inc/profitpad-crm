import { useEffect, useState } from 'react';
import { LayoutDashboard, type LucideIcon, type LucideProps } from 'lucide-react';
import { api } from './api';

// Any Lucide icon by name (kebab case, like chart-column), for custom views'
// menu icons. The full icon set is a separate chunk, loaded the first time a
// named icon is drawn; until then (and for unknown names) the fallback shows.

type IconSet = Record<string, LucideIcon>;
let iconSet: IconSet | null = null;
let loading: Promise<IconSet> | null = null;

function loadIcons(): Promise<IconSet> {
  // the per-icon index (not the package entry the app imports statically), so
  // the bundler keeps it in its own chunk
  // @ts-ignore no type declarations for this deep path
  loading ??= import('lucide-react/dist/esm/icons/index.mjs').then((m: unknown) => (iconSet = m as IconSet));
  return loading;
}

const toPascal = (name: string) => name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

export const DEFAULT_VIEW_ICON = LayoutDashboard;

function useIconSet(enabled: boolean): IconSet | null {
  const [set, setSet] = useState<IconSet | null>(iconSet);
  useEffect(() => {
    if (enabled && !set) loadIcons().then(setSet).catch(() => undefined);
  }, [enabled, set]);
  return set;
}

export function ViewIcon({ icon, fallback = DEFAULT_VIEW_ICON, ...props }: Omit<LucideProps, 'name'> & { icon: string | null | undefined; fallback?: LucideIcon }) {
  const set = useIconSet(!!icon);
  const Icon = (icon && set?.[toPascal(icon)]) || fallback;
  return <Icon {...props} />;
}

// Valid names come from the API (the same Lucide version), so the picker only
// offers names the API accepts.
let names: Promise<string[]> | null = null;
export function loadIconNames(): Promise<string[]> {
  names ??= api<{ results: string[] }>('GET', '/v1/ui/icons').then((r) => r.results).catch((e) => {
    names = null;
    throw e;
  });
  return names;
}

export function useIcons(): { names: string[]; set: IconSet | null } {
  const [list, setList] = useState<string[]>([]);
  const set = useIconSet(true);
  useEffect(() => {
    loadIconNames().then(setList).catch(() => undefined);
  }, []);
  return { names: list, set };
}

export { toPascal };
