import { el, publicApi } from './public-api';
import { injectFormCss, renderForm } from './form-renderer';

// Embed snippet for customer websites, built as one classic script
// (vite.embed.config.ts) served at /p/embed.js:
//
//   <div data-pcrm-form="FORM_KEY"></div>
//   <script src="https://test-crm.profitpad.com/p/embed.js" async></script>
//
// The website's origin must be listed in Settings -> Forms, or the API refuses
// the submission. Forms are rendered in the page itself (not an iframe) so the
// API can see which website sent them.

// Without VITE_API_URL (local builds) the API is assumed to sit behind the
// same origin that served this script.
const script = document.currentScript as HTMLScriptElement | null;
const API_BASE = (import.meta.env.VITE_API_URL || (script?.src ? new URL(script.src).origin : '')).replace(/\/$/, '');

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
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
else mountAll();
