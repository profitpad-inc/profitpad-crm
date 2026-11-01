import { el, publicApi, PublicApiError, type FormField, type PublicForm } from './public-api';
import { visibleFields } from './conditions';

// Renders a published form into a container and submits it. Shared by the
// hosted page (/p/form/), embed.js and the builder's preview, so it uses plain
// DOM and styles scoped to .pcrm-form (FORM_CSS) that cannot clash with the
// host website. Fields with conditions show and hide as answers change.

export const FORM_CSS = `
.pcrm-form { --pcrm-primary: #1f7a74; --pcrm-text: #1f2328; --pcrm-muted: #6b7280; --pcrm-border: #d5d8dd;
  font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.45;
  color: var(--pcrm-text); max-width: 560px; box-sizing: border-box; }
.pcrm-form *, .pcrm-form *::before, .pcrm-form *::after { box-sizing: border-box; }
.pcrm-form form { display: flex; flex-direction: column; gap: 14px; margin: 0; }
.pcrm-form .pcrm-field { display: flex; flex-direction: column; gap: 5px; border: 0; padding: 0; margin: 0; min-width: 0; }
.pcrm-form .pcrm-field[hidden] { display: none; }
.pcrm-form .pcrm-label { font-weight: 600; font-size: 14px; padding: 0; }
.pcrm-form .pcrm-help { color: var(--pcrm-muted); font-size: 13px; }
.pcrm-form .pcrm-req { color: #b42318; margin-left: 2px; }
.pcrm-form input[type=text], .pcrm-form input[type=email], .pcrm-form input[type=tel], .pcrm-form input[type=number],
.pcrm-form input[type=date], .pcrm-form input[type=datetime-local],
.pcrm-form select, .pcrm-form textarea { width: 100%; font: inherit; color: inherit; background: #fff;
  border: 1px solid var(--pcrm-border); border-radius: 8px; padding: 9px 11px; margin: 0; }
.pcrm-form textarea { min-height: 110px; resize: vertical; }
.pcrm-form input:focus, .pcrm-form select:focus, .pcrm-form textarea:focus { outline: 2px solid var(--pcrm-primary); outline-offset: 0; border-color: var(--pcrm-primary); }
.pcrm-form .pcrm-check { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; font-size: 15px; }
.pcrm-form .pcrm-check input { margin-top: 3px; width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--pcrm-primary); }
.pcrm-form .pcrm-choices { display: flex; flex-direction: column; gap: 6px; }
.pcrm-form .pcrm-invalid input, .pcrm-form .pcrm-invalid select, .pcrm-form .pcrm-invalid textarea { border-color: #b42318; }
.pcrm-form .pcrm-error { color: #b42318; font-size: 13px; }
.pcrm-form .pcrm-error:empty { display: none; }
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

function control(f: FormField, id: string): HTMLElement {
  const common = { id, name: f.name, required: f.required, placeholder: f.placeholder };
  switch (f.type) {
    case 'textarea':
      return el('textarea', { ...common, maxlength: '5000' });
    case 'select':
      return el('select', common, el('option', { value: '' }, f.required ? 'Choose...' : ''), ...(f.options ?? []).map((o) => el('option', { value: o.value }, o.label)));
    case 'multiselect':
      return el('div', { class: 'pcrm-choices' }, ...(f.options ?? []).map((o, i) =>
        el('label', { class: 'pcrm-check', for: `${id}-${i}` }, el('input', { type: 'checkbox', id: `${id}-${i}`, name: f.name, value: o.value }), el('span', {}, o.label))));
    case 'checkbox':
      return el('input', { ...common, type: 'checkbox', value: 'true' });
    case 'email':
      return el('input', { ...common, type: 'email', autocomplete: 'email', maxlength: '254' });
    case 'phone':
      return el('input', { ...common, type: 'tel', autocomplete: 'tel', maxlength: '50' });
    case 'number':
      return el('input', { ...common, type: 'number', step: 'any' });
    case 'date':
      return el('input', { ...common, type: 'date' });
    case 'datetime':
      return el('input', { ...common, type: 'datetime-local' });
    default:
      return el('input', { ...common, type: 'text', maxlength: '500' });
  }
}

// The answer to one field as the API wants it.
function readValue(form: HTMLFormElement, f: FormField): unknown {
  const data = new FormData(form);
  switch (f.type) {
    case 'checkbox': return data.get(f.name) === 'true';
    case 'multiselect': return data.getAll(f.name).map(String);
    case 'datetime': {
      const v = String(data.get(f.name) ?? '');
      // datetime-local is the visitor's local time; send an exact instant
      return v ? new Date(v).toISOString() : '';
    }
    default: return String(data.get(f.name) ?? '').trim();
  }
}

const isEmpty = (v: unknown) => v === '' || v === false || v === undefined || (Array.isArray(v) && v.length === 0);

let counter = 0;

// preview: the builder's preview; checks answers but sends nothing.
export function renderForm(container: HTMLElement, opts: { apiBase: string; key: string; form: PublicForm; preview?: boolean }): void {
  // options may arrive as plain strings from an API older than the form builder
  const definition = {
    ...opts.form.definition,
    fields: opts.form.definition.fields.map((f) => (f.options
      ? { ...f, options: (f.options as ({ value: string; label: string } | string)[]).map((o) => (typeof o === 'string' ? { value: o, label: o } : o)) }
      : f))
  };
  const api = publicApi(opts.apiBase);
  const shownAt = Date.now();
  const prefix = `pcrm-${++counter}`;
  container.classList.add('pcrm-form');
  if (opts.form.theme.primary) container.style.setProperty('--pcrm-primary', opts.form.theme.primary);
  container.replaceChildren();

  const wrappers = new Map<string, HTMLElement>();
  const errors = new Map<string, HTMLElement>();
  const nodes = definition.fields.map((f) => {
    const id = `${prefix}-${f.name}`;
    const input = control(f, id);
    const error = el('div', { class: 'pcrm-error', role: 'alert' });
    errors.set(f.name, error);
    const req = f.required ? el('span', { class: 'pcrm-req', 'aria-hidden': 'true' }, '*') : null;
    const help = f.help ? el('div', { class: 'pcrm-help' }, f.help) : null;
    let wrapper: HTMLElement;
    if (f.type === 'checkbox') {
      wrapper = el('div', { class: 'pcrm-field' }, el('label', { class: 'pcrm-check', for: id }, input, el('span', {}, f.label, req)), help, error);
    } else if (f.type === 'multiselect') {
      wrapper = el('fieldset', { class: 'pcrm-field' }, el('legend', { class: 'pcrm-label' }, f.label, req), help, input, error);
    } else {
      wrapper = el('div', { class: 'pcrm-field' }, el('label', { class: 'pcrm-label', for: id }, f.label, req), help, input, error);
    }
    wrappers.set(f.name, wrapper);
    return wrapper;
  });
  // honeypot: hidden from people, filled by bots
  const hp = el('input', { type: 'text', name: '_hp', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const formError = el('div', { class: 'pcrm-error', role: 'alert' });
  const button = el('button', { type: 'submit' }, definition.submit_label);
  const form = el('form', { novalidate: true }, ...nodes, el('div', { class: 'pcrm-hp' }, hp), formError, button);
  container.append(form);

  const answers = () => Object.fromEntries(definition.fields.map((f) => [f.name, readValue(form, f)]));
  const update = () => {
    const shown = visibleFields(definition.fields, answers());
    for (const [name, w] of wrappers) w.hidden = !shown.has(name);
    return shown;
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.textContent = '';
    for (const node of errors.values()) {
      node.textContent = '';
      node.parentElement?.classList.remove('pcrm-invalid');
    }
    const all = answers();
    const shown = update();
    const values: Record<string, unknown> = {};
    let firstBad: string | null = null;
    for (const f of definition.fields) {
      if (!shown.has(f.name)) continue;
      const v = all[f.name];
      if (isEmpty(v)) {
        if (f.required) {
          errors.get(f.name)!.textContent = `${f.label} is required.`;
          wrappers.get(f.name)!.classList.add('pcrm-invalid');
          firstBad ??= f.name;
        }
        continue;
      }
      values[f.name] = v;
    }
    if (firstBad) {
      wrappers.get(firstBad)!.querySelector<HTMLElement>('input, select, textarea')?.focus();
      return;
    }
    if (opts.preview) {
      container.replaceChildren(el('div', { class: 'pcrm-done', role: 'status' }, definition.success_message));
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
        wrappers.get(e2.field)!.classList.add('pcrm-invalid');
      } else {
        formError.textContent = e2.status === 403 ? 'This form cannot be sent from this website.' : e2.message;
      }
      button.disabled = false;
    }
  });
}
