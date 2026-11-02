import { el, publicApi } from './public-api';
import { injectFormCss, renderForm } from './form-renderer';
import { mountBooking as renderBooking } from './book-app';
import { applyTheme } from '../lib/theme';
import publicCss from './public.css?inline';
import bookCss from './book.css?inline';

// Embed snippet for customer websites, built as one classic script
// (vite.embed.config.ts) served at /p/embed.js:
//
//   <div data-pcrm-form="FORM_KEY"></div>
//   <script src="https://test-crm.profitpad.com/p/embed.js" async></script>
//
// The website's origin must be listed in Settings -> Embed domains, or the API refuses
// the submission. Forms are rendered in the page itself (not an iframe) so the
// API can see which website sent them.
//
// Booking pages work the same way, on the same list of websites:
//
//   <div data-pcrm-booking="intro-call"></div>
//   <script src="https://test-crm.profitpad.com/p/embed.js" async></script>

// Without VITE_API_URL (local builds) the API is assumed to sit behind the
// same origin that served this script.
const script = document.currentScript as HTMLScriptElement | null;
const API_BASE = (import.meta.env.VITE_API_URL || (script?.src ? new URL(script.src).origin : '')).replace(/\/$/, '');
// Booking pages render inside a shadow root, so the website's styles and
// ours cannot affect each other; theme colors are set on the booking's own
// element, never on the website's page.
const BOOKING_CSS = `
:host { display: block; }
.pp-embed { font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.45; color: var(--text); text-align: left; }
.pp-embed .pp-page { max-width: none; padding: 0; }
${publicCss}
${bookCss}`;

function mountBooking(container: HTMLElement): void {
  if (container.dataset.pcrmMounted) return;
  container.dataset.pcrmMounted = 'true';
  const shadow = container.attachShadow({ mode: 'open' });
  const box = document.createElement('div');
  box.className = 'pp-embed';
  const style = document.createElement('style');
  style.textContent = BOOKING_CSS;
  shadow.append(style, box);
  applyTheme(undefined, box);
  renderBooking(box, {
    apiBase: API_BASE,
    key: container.dataset.pcrmBooking ?? '',
    embedded: true,
    styleTarget: shadow,
    onTheme: (theme) => applyTheme(theme, box)
  });
}

async function mount(container: HTMLElement): Promise<void> {
  if (container.dataset.pcrmMounted) return;
  container.dataset.pcrmMounted = 'true';
  const key = container.dataset.pcrmForm ?? '';
  try {
    const form = await publicApi(API_BASE).form(key);
    renderForm(container, { apiBase: API_BASE, key, form });
  } catch {
    container.classList.add('pcrm-form');
    container.replaceChildren(el('p', { class: 'pcrm-muted' }, 'This form is not available right now.'));
  }
}

function mountAll(): void {
  injectFormCss();
  document.querySelectorAll<HTMLElement>('[data-pcrm-form]').forEach((c) => void mount(c));
  document.querySelectorAll<HTMLElement>('[data-pcrm-booking]').forEach(mountBooking);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
else mountAll();
