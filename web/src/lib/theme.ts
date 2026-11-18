// Theme colors are portal settings (ui.settings 'theme'), applied as CSS
// variables so every component picks them up.

export const THEME_FIELDS = [
  { key: 'primary', label: 'Primary (buttons, links)' },
  { key: 'sidebar_background', label: 'Sidebar background' },
  { key: 'sidebar_text', label: 'Sidebar text' },
  { key: 'sidebar_active', label: 'Sidebar selected item' },
  { key: 'page_background', label: 'Page background' },
  { key: 'surface', label: 'Panels and table headers' },
  { key: 'text', label: 'Text' },
  { key: 'muted_text', label: 'Secondary text' },
  { key: 'border', label: 'Borders' }
] as const;

export type ThemeKey = (typeof THEME_FIELDS)[number]['key'];
export type Theme = Record<ThemeKey, string>;

export const DEFAULT_THEME: Theme = {
  primary: '#1d4ed8',
  sidebar_background: '#0f172a',
  sidebar_text: '#f1f5f9',
  sidebar_active: '#26344d',
  page_background: '#ffffff',
  surface: '#eef1f5',
  text: '#0b1220',
  muted_text: '#475467',
  border: '#cfd6df'
};

// The dark palette (ui.settings 'theme_dark'), editable in Settings, Theme like the light one.
export const DEFAULT_DARK_THEME: Theme = {
  primary: '#3b76ef',
  sidebar_background: '#0a0f1a',
  sidebar_text: '#e2e8f0',
  sidebar_active: '#1e2a40',
  page_background: '#161b26',
  surface: '#0f131c',
  text: '#e6eaf0',
  muted_text: '#9aa4b4',
  border: '#2e3646'
};

// Light or dark: each person's own choice, kept in this browser. 'system' follows the device.
export type ColorMode = 'light' | 'dark' | 'system';
export type Mode = 'light' | 'dark';
const MODE_KEY = 'pc.color_mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function getColorMode(): ColorMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* storage blocked */ }
  return 'light';
}

export function saveColorMode(mode: ColorMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage blocked */ }
}

export const systemPrefersDark = () => window.matchMedia(DARK_QUERY).matches;

export function onSystemModeChange(fn: (dark: boolean) => void): () => void {
  const mq = window.matchMedia(DARK_QUERY);
  const handler = (e: MediaQueryListEvent) => fn(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

export const resolveMode = (mode: ColorMode, systemDark = systemPrefersDark()): Mode =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

// data-mode on <html> picks the dark fallbacks and fixed colours in styles.css;
// color-scheme makes scrollbars and native controls match
export function applyMode(mode: Mode): void {
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
}

// target: where the CSS variables go (default the whole page; an embedded
// booking page sets them on its own element so the website is not touched)
export function applyTheme(partial: Partial<Theme> | undefined, target: HTMLElement = document.documentElement, defaults: Theme = DEFAULT_THEME): Theme {
  const theme = { ...defaults, ...(partial ?? {}) };
  const root = target;
  for (const [k, v] of Object.entries(theme)) root.style.setProperty(`--${k.replace(/_/g, '-')}`, v);
  return theme;
}

// The 16 colours offered for dropdown choices until an admin changes them in
// Settings, Theme (ui.settings 'dropdown_colors'). Names are shown while a
// colour is still its default.
export const DEFAULT_DROPDOWN_COLORS: { value: string; name: string }[] = [
  { value: '#ef4444', name: 'Red' },
  { value: '#f97316', name: 'Orange' },
  { value: '#f59e0b', name: 'Amber' },
  { value: '#eab308', name: 'Yellow' },
  { value: '#84cc16', name: 'Lime' },
  { value: '#22c55e', name: 'Green' },
  { value: '#10b981', name: 'Emerald' },
  { value: '#14b8a6', name: 'Teal' },
  { value: '#06b6d4', name: 'Cyan' },
  { value: '#0ea5e9', name: 'Sky' },
  { value: '#3b82f6', name: 'Blue' },
  { value: '#6366f1', name: 'Indigo' },
  { value: '#8b5cf6', name: 'Violet' },
  { value: '#d946ef', name: 'Fuchsia' },
  { value: '#ec4899', name: 'Pink' },
  { value: '#6b7280', name: 'Gray' }
];

export const defaultDropdownColors = () => DEFAULT_DROPDOWN_COLORS.map((c) => c.value);

// a colour's name when it is the default in that slot, else its hex
export const dropdownColorName = (value: string, i: number) =>
  DEFAULT_DROPDOWN_COLORS[i]?.value === value ? DEFAULT_DROPDOWN_COLORS[i].name : value;
