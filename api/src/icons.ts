import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Lucide icon names (kebab case, like chart-column) that custom views may use
// as their menu icon. Read from the lucide package, one file per icon, at the
// same version as lucide-react in web/ so the UI can draw every name accepted
// here. Aliases (old names) are not included.
const dir = join(dirname(createRequire(import.meta.url).resolve('lucide/package.json')), 'dist', 'esm', 'icons');
export const ICON_NAMES: ReadonlySet<string> = new Set(readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)));

export function findIcons(query: string, limit = 40): string[] {
  const words = query.toLowerCase().split(/[\s-]+/).filter(Boolean);
  return [...ICON_NAMES].filter((n) => words.every((w) => n.includes(w))).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
}
