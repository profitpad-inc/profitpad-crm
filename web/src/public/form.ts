import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/montserrat/700.css';
import './public.css';
import { applyTheme } from '../lib/theme';
import { el, keyFromHash, publicApi } from './public-api';
import { injectFormCss, renderForm } from './form-renderer';

// Hosted form page: /p/form/#<form key>. Embedded forms use embed.js instead.

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const root = document.getElementById('root')!;
const key = keyFromHash();

function message(text: string): void {
  root.replaceChildren(el('main', { class: 'pp-page' }, el('div', { class: 'pp-card pp-center' }, el('p', {}, text))));
}

async function load(): Promise<void> {
  if (!key) return message('This link is missing its form key.');
  try {
    const form = await publicApi(API_BASE).form(key);
    applyTheme(form.theme);
    document.title = form.name ?? 'Form';
    injectFormCss();
    const holder = el('div', {});
    root.replaceChildren(el('main', { class: 'pp-page' },
      el('div', { class: 'pp-card pp-form-card' },
        el('h1', {}, form.name ?? 'Form'),
        form.description ? el('p', { class: 'pp-muted pp-intro' }, form.description) : null,
        el('div', { class: 'pp-form-body' }, holder))));
    renderForm(holder, { apiBase: API_BASE, key, form });
  } catch (err) {
    const status = (err as { status?: number }).status;
    message(status === 404 ? 'This form is not available.' : (err as Error).message);
  }
}

applyTheme(undefined);
window.addEventListener('hashchange', () => window.location.reload());
void load();
