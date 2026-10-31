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
  primary: '#1f7a74',
  sidebar_background: '#2f3133',
  sidebar_text: '#eceef0',
  sidebar_active: '#4a4d50',
  page_background: '#ffffff',
  surface: '#f5f6f7',
  text: '#1f2328',
  muted_text: '#6b7280',
  border: '#e2e4e8'
};

export function applyTheme(partial: Partial<Theme> | undefined): Theme {
  const theme = { ...DEFAULT_THEME, ...(partial ?? {}) };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme)) root.style.setProperty(`--${k.replace(/_/g, '-')}`, v);
  return theme;
}
