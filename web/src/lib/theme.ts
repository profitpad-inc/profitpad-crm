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
  primary: '#2445b8',
  sidebar_background: '#1b2430',
  sidebar_text: '#e6e9ee',
  sidebar_active: '#2c3746',
  page_background: '#ffffff',
  surface: '#f3f5f8',
  text: '#18202b',
  muted_text: '#5d6878',
  border: '#dce1e8'
};

export function applyTheme(partial: Partial<Theme> | undefined): Theme {
  const theme = { ...DEFAULT_THEME, ...(partial ?? {}) };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme)) root.style.setProperty(`--${k.replace(/_/g, '-')}`, v);
  return theme;
}
