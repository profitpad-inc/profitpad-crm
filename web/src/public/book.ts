import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/montserrat/700.css';
import './public.css';
import './book.css';
import { applyTheme } from '../lib/theme';
import { keyFromHash } from './public-api';
import { mountBooking } from './book-app';

// Hosted booking page: /p/book/#<booking page key or address>. The flow itself
// is in book-app.ts (shared with embed.js).

applyTheme(undefined);
window.addEventListener('hashchange', () => window.location.reload());
mountBooking(document.getElementById('root')!, {
  apiBase: (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, ''),
  key: keyFromHash(),
  embedded: false,
  styleTarget: document,
  onTheme: (theme) => applyTheme(theme)
});
