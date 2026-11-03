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

// target: where the CSS variables go (default the whole page; an embedded
// booking page sets them on its own element so the website is not touched)
export function applyTheme(partial: Partial<Theme> | undefined, target: HTMLElement = document.documentElement): Theme {
  const theme = { ...DEFAULT_THEME, ...(partial ?? {}) };
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
