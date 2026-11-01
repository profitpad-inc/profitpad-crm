import { el, publicApi, PublicApiError, type FormField, type PublicForm } from './public-api';

// Renders a published form into a container and submits it. Shared by the
// hosted page (/p/form/) and embed.js, so it uses plain DOM and styles scoped
// to .pcrm-form (FORM_CSS) that cannot clash with the host website.

export const FORM_CSS = `
.pcrm-form { --pcrm-primary: #1f7a74; --pcrm-text: #1f2328; --pcrm-muted: #6b7280; --pcrm-border: #d5d8dd;
  font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.45;
  color: var(--pcrm-text); max-width: 560px; box-sizing: border-box; }
.pcrm-form *, .pcrm-form *::before, .pcrm-form *::after { box-sizing: border-box; }
.pcrm-form form { display: flex; flex-direction: column; gap: 14px; margin: 0; }
.pcrm-form .pcrm-field { display: flex; flex-direction: column; gap: 5px; }
.pcrm-form label.pcrm-label { font-weight: 600; font-size: 14px; }
.pcrm-form .pcrm-req { color: #b42318; margin-left: 2px; }
.pcrm-form input[type=text], .pcrm-form input[type=email], .pcrm-form input[type=tel], .pcrm-form input[type=number],
.pcrm-form select, .pcrm-form textarea { width: 100%; font: inherit; color: inherit; background: #fff;
  border: 1px solid var(--pcrm-border); border-radius: 8px; padding: 9px 11px; margin: 0; }
.pcrm-form textarea { min-height: 110px; resize: vertical; }
.pcrm-form input:focus, .pcrm-form select:focus, .pcrm-form textarea:focus { outline: 2px solid var(--pcrm-primary); outline-offset: 0; border-color: var(--pcrm-primary); }
.pcrm-form .pcrm-check { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; }
.pcrm-form .pcrm-check input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--pcrm-primary); }
.pcrm-form .pcrm-invalid input, .pcrm-form .pcrm-invalid select, .pcrm-form .pcrm-invalid textarea { border-color: #b42318; }
.pcrm-form .pcrm-error { color: #b42318; font-size: 13px; }
.pcrm-form button { align-self: flex-start; font: inherit; font-weight: 600; color: #fff; background: var(--pcrm-primary);
  border: 0; border-radius: 8px; padding: 10px 20px; cursor: pointer; }
.pcrm-form button:disabled { opacity: .6; cursor: default; }
.pcrm-form .pcrm-hp { position: absolute !important; left: -10000px !important; width: 1px; height: 1px; overflow: hidden; }
.pcrm-form .pcrm-done { padding: 16px; border-radius: 8px; background: #ecfdf3; color: #05603a; }
.pcrm-form .pcrm-muted { color: var(--pcrm-muted); }
`;

export function injectFormCss(doc: Document = document): void {
  if (doc.getElementById('pcrm-form-css')) return;
  doc.head.append(el('style', { id: 'pcrm-form-css' }, FORM_CSS));
}

function input(f: FormField, id: string): HTMLElement {
  const common = { id, name: f.name, required: f.required, placeholder: f.placeholder };
  switch (f.type) {
    case 'textarea':
      return el('textarea', { ...common, maxlength: '5000' });
    case 'select':
      return el('select', common, el('option', { value: '' }, f.required ? 'Choose...' : ''), ...(f.options ?? []).map((o) => el('option', { value: o }, o)));
    case 'checkbox':
      return el('input', { ...common, type: 'checkbox', value: 'true' });
    case 'email':
      return el('input', { ...common, type: 'email', autocomplete: 'email', maxlength: '254' });
    case 'phone':
      return el('input', { ...common, type: 'tel', autocomplete: 'tel', maxlength: '50' });
    case 'number':
      return el('input', { ...common, type: 'number', step: 'any' });
    default:
      return el('input', { ...common, type: 'text', maxlength: '500' });
  }
}

let counter = 0;

export function renderForm(container: HTMLElement, opts: { apiBase: string; key: string; form: PublicForm }): void {
  const { definition } = opts.form;
  const api = publicApi(opts.apiBase);
  const shownAt = Date.now();
  const prefix = `pcrm-${++counter}`;
  container.classList.add('pcrm-form');
  if (opts.form.theme.primary) container.style.setProperty('--pcrm-primary', opts.form.theme.primary);
  container.replaceChildren();

  const errors = new Map<string, HTMLElement>();
  const fields = definition.fields.map((f) => {
    const id = `${prefix}-${f.name}`;
    const control = input(f, id);
    const error = el('div', { class: 'pcrm-error', role: 'alert' });
    errors.set(f.name, error);
    const req = f.required ? el('span', { class: 'pcrm-req', 'aria-hidden': 'true' }, '*') : null;
    if (f.type === 'checkbox') {
      return el('div', { class: 'pcrm-field' }, el('label', { class: 'pcrm-label pcrm-check', for: id }, control, el('span', {}, f.label, req)), error);
    }
    return el('div', { class: 'pcrm-field' }, el('label', { class: 'pcrm-label', for: id }, f.label, req), control, error);
  });
  // honeypot: hidden from people, filled by bots
  const hp = el('input', { type: 'text', name: '_hp', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const formError = el('div', { class: 'pcrm-error', role: 'alert' });
  const button = el('button', { type: 'submit' }, definition.submit_label);
  const form = el('form', { novalidate: true }, ...fields, el('div', { class: 'pcrm-hp' }, hp), formError, button);
  container.append(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.textContent = '';
    for (const node of errors.values()) {
      node.textContent = '';
      node.parentElement?.classList.remove('pcrm-invalid');
    }
    const data = new FormData(form);
    const values: Record<string, unknown> = {};
    let firstBad: string | null = null;
    for (const f of definition.fields) {
      const raw = f.type === 'checkbox' ? data.get(f.name) === 'true' : String(data.get(f.name) ?? '').trim();
      const empty = raw === '' || raw === false;
      if (f.required && empty) {
        errors.get(f.name)!.textContent = `${f.label} is required.`;
        errors.get(f.name)!.parentElement?.classList.add('pcrm-invalid');
        firstBad ??= f.name;
        continue;
      }
      if (!empty) values[f.name] = raw;
    }
    if (firstBad) {
      (form.elements.namedItem(firstBad) as HTMLElement | null)?.focus();
      return;
    }
    button.disabled = true;
    try {
      const res = await api.submit(opts.key, {
        values,
        page_url: window.location.href.split('#')[0],
        _hp: hp.value,
        _elapsed: Date.now() - shownAt
      });
      container.replaceChildren(el('div', { class: 'pcrm-done', role: 'status' }, res.message));
    } catch (err) {
      const e2 = err as PublicApiError;
      if (e2.field && errors.has(e2.field)) {
        errors.get(e2.field)!.textContent = e2.message;
        errors.get(e2.field)!.parentElement?.classList.add('pcrm-invalid');
      } else {
        formError.textContent = e2.status === 403
          ? 'This form cannot be sent from this website.'
          : e2.message;
      }
      button.disabled = false;
    }
  });
}
