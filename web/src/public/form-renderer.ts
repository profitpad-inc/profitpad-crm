import { el, publicApi, PublicApiError, type FormField, type PhoneResult, type PublicForm } from './public-api';
import { visibleFields } from './conditions';
import { CARET, composePhone, loadPhoneRegions, regionForNumber, regionLabel, regionShort, type PhoneRegion } from './phone-regions';

// Renders a published form into a container and submits it. Shared by the
// hosted page (/p/form/), embed.js and the builder's preview, so it uses plain
// DOM and styles scoped to .pcrm-form (FORM_CSS) that cannot clash with the
// host website. Fields with conditions show and hide as answers change.
//
// - Any field whose key is a query parameter of the page URL starts with that
//   value (?topic=Sales). Fields marked from_url are never shown: their value
//   comes only from the URL (?utm_source=newsletter).
// - When the form has custom HTML, that markup is used instead of generated
//   fields. Controls are found by name (the field key); [data-field=key] is
//   the element shown or hidden by conditions, [data-error=key] (optional)
//   shows that field's error and [data-error=_form] the form's.

export const FORM_CSS = `
.pcrm-form select:not([multiple]) { -webkit-appearance: none; appearance: none; padding-right: 36px;
  background-image: ${CARET}; background-repeat: no-repeat; background-position: right 14px center; background-size: 12px; }
.pcrm-form { --pcrm-primary: #1f7a74; --pcrm-text: #1f2328; --pcrm-muted: #6b7280; --pcrm-border: #d5d8dd;
  font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.45;
  color: var(--pcrm-text); max-width: 560px; box-sizing: border-box; }
.pcrm-form *, .pcrm-form *::before, .pcrm-form *::after { box-sizing: border-box; }
.pcrm-form form { display: flex; flex-direction: column; gap: 14px; margin: 0; }
.pcrm-form .pcrm-field { display: flex; flex-direction: column; gap: 5px; border: 0; padding: 0; margin: 0; min-width: 0; }
.pcrm-form [hidden] { display: none !important; }
.pcrm-form .pcrm-label { font-weight: 600; font-size: 14px; padding: 0; }
.pcrm-form .pcrm-help { color: var(--pcrm-muted); font-size: 13px; }
.pcrm-form .pcrm-req { color: #b42318; margin-left: 2px; }
.pcrm-form input[type=text], .pcrm-form input[type=email], .pcrm-form input[type=tel], .pcrm-form input[type=url], .pcrm-form input[type=number],
.pcrm-form input[type=date], .pcrm-form input[type=datetime-local],
.pcrm-form select, .pcrm-form textarea { width: 100%; font: inherit; color: inherit; background: #fff;
  border: 1px solid var(--pcrm-border); border-radius: 8px; padding: 9px 11px; margin: 0; }
.pcrm-form textarea { min-height: 110px; resize: vertical; }
.pcrm-form .pcrm-phone { display: flex; gap: 6px; }
.pcrm-form .pcrm-phone input { flex: 1; min-width: 0; }
.pcrm-form .pcrm-country { position: relative; flex: none; }
.pcrm-form .pcrm-country-face { display: flex; align-items: center; height: 100%; white-space: nowrap; background: #fff; border: 1px solid var(--pcrm-border);
  border-radius: 8px; padding: 9px 36px 9px 11px; background-image: ${CARET}; background-repeat: no-repeat; background-position: right 14px center; background-size: 12px; }
.pcrm-form .pcrm-country select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.pcrm-form .pcrm-country:focus-within .pcrm-country-face { outline: 2px solid var(--pcrm-primary); border-color: var(--pcrm-primary); }
.pcrm-form input:focus, .pcrm-form select:focus, .pcrm-form textarea:focus { outline: 2px solid var(--pcrm-primary); outline-offset: 0; border-color: var(--pcrm-primary); }
.pcrm-form .pcrm-check { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; font-size: 15px; }
.pcrm-form .pcrm-check input { margin-top: 3px; width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--pcrm-primary); }
.pcrm-form .pcrm-choices { display: flex; flex-direction: column; gap: 6px; }
.pcrm-form .pcrm-invalid input, .pcrm-form .pcrm-invalid select, .pcrm-form .pcrm-invalid textarea,
.pcrm-form input.pcrm-invalid, .pcrm-form select.pcrm-invalid, .pcrm-form textarea.pcrm-invalid { border-color: #b42318; }
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

// Older APIs send options as plain strings and email/phone as field types.
function normalize(fields: FormField[]): FormField[] {
  return fields.map((f) => {
    const out: FormField = { ...f };
    if (f.options) out.options = (f.options as ({ value: string; label: string } | string)[]).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    const t = f.type as string;
    if (t === 'email' || t === 'phone') {
      out.type = 'text';
      out.format ??= t;
    }
    return out;
  });
}

const INPUT_TYPE: Record<string, string> = { email: 'email', phone: 'tel', url: 'url' };

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
    case 'number':
      return el('input', { ...common, type: 'number', step: 'any' });
    case 'date':
      return el('input', { ...common, type: 'date' });
    case 'datetime':
      return el('input', { ...common, type: 'datetime-local' });
    default:
      return el('input', {
        ...common,
        type: INPUT_TYPE[f.format ?? ''] ?? 'text',
        autocomplete: f.format === 'email' ? 'email' : f.format === 'phone' ? 'tel' : undefined,
        maxlength: '500'
      });
  }
}

// Generated markup for the fields the form asks. The builder's "Customize
// HTML" starts from the same structure (see formHtml).
function generatedField(f: FormField, id: string): HTMLElement {
  const input = control(f, id);
  const error = el('div', { class: 'pcrm-error', role: 'alert', 'data-error': f.name });
  const req = f.required ? el('span', { class: 'pcrm-req', 'aria-hidden': 'true' }, '*') : null;
  const help = f.help ? el('div', { class: 'pcrm-help' }, f.help) : null;
  if (f.type === 'checkbox') {
    return el('div', { class: 'pcrm-field', 'data-field': f.name }, el('label', { class: 'pcrm-check', for: id }, input, el('span', {}, f.label, req)), help, error);
  }
  if (f.type === 'multiselect') {
    return el('fieldset', { class: 'pcrm-field', 'data-field': f.name }, el('legend', { class: 'pcrm-label' }, f.label, req), help, input, error);
  }
  return el('div', { class: 'pcrm-field', 'data-field': f.name }, el('label', { class: 'pcrm-label', for: id }, f.label, req), help, input, error);
}

// The same structure as an HTML string, for the builder's "Customize HTML".
export function formHtml(def: PublicForm['definition']): string {
  const box = document.createElement('div');
  const form = el('form', {}, ...normalize(def.fields).filter((f) => !f.from_url).map((f) => generatedField(f, `f-${f.name}`)),
    el('div', { class: 'pcrm-error', 'data-error': '_form' }), el('button', { type: 'submit' }, def.submit_label));
  box.append(form);
  return box.innerHTML.replace(/></g, '>\n<');
}

const controlsNamed = (form: HTMLFormElement, name: string) =>
  [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')].filter((c) => c.name === name);

// The answer to one asked field as the API wants it.
function readValue(form: HTMLFormElement, f: FormField): unknown {
  const controls = controlsNamed(form, f.name);
  const checked = (c: HTMLElement) => (c as HTMLInputElement).checked;
  switch (f.type) {
    case 'checkbox':
      return controls.some((c) => c instanceof HTMLInputElement && checked(c));
    case 'multiselect':
      return controls.flatMap((c) => (c instanceof HTMLSelectElement ? [...c.selectedOptions].map((o) => o.value) : checked(c) ? [c.value] : []));
    case 'select': {
      const radios = controls.filter((c) => c instanceof HTMLInputElement && c.type === 'radio');
      return radios.length ? (radios.find(checked)?.value ?? '') : (controls[0]?.value ?? '');
    }
    case 'datetime': {
      const v = controls[0]?.value ?? '';
      // datetime-local is the visitor's local time; send an exact instant
      return v ? new Date(v).toISOString() : '';
    }
    default:
      return (controls[0]?.value ?? '').trim();
  }
}

const TRUE = ['true', '1', 'yes', 'on'];

// A from_url field's value, or a prefill for an asked field.
function fromParams(params: URLSearchParams, f: FormField): unknown {
  if (!params.has(f.name)) return undefined;
  const all = params.getAll(f.name);
  if (f.type === 'multiselect') return all.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  if (f.type === 'checkbox') return TRUE.includes((all[0] ?? '').toLowerCase());
  return (all[0] ?? '').trim();
}

function prefill(form: HTMLFormElement, f: FormField, value: unknown): void {
  for (const c of controlsNamed(form, f.name)) {
    if (c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio')) {
      c.checked = f.type === 'checkbox' ? value === true : Array.isArray(value) ? value.includes(c.value) : c.value === value;
    } else if (c instanceof HTMLSelectElement && c.multiple) {
      for (const o of c.options) o.selected = Array.isArray(value) && value.includes(o.value);
    } else if (typeof value === 'string') {
      c.value = f.type === 'datetime' ? value.slice(0, 16) : value;
    }
  }
}

const isEmpty = (v: unknown) => v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0);


// Same checks as the API (api/src/forms.ts cleanValue), for quicker feedback.
function formatProblem(f: FormField, v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  if (f.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `${f.label} must be an email address.`;
  if (f.format === 'url' && !/^https?:\/\/\S+$/.test(v)) return `${f.label} must be a web address starting with http:// or https://.`;
  if (f.format === 'regex' && f.pattern) {
    try {
      if (!new RegExp(`^(?:${f.pattern})$`).test(v)) return f.pattern_message ?? `${f.label} is not in the expected format.`;
    } catch {
      return null;
    }
  }
  return null;
}

let counter = 0;

// preview: the builder's preview; checks answers but sends nothing.
// params: query parameters to use instead of the page's (the preview).
// checkPhone: how phone answers are checked (default: the form's public
// endpoint; the builder's preview uses the signed-in API).
export function renderForm(container: HTMLElement, opts: {
  apiBase: string; key: string; form: PublicForm; preview?: boolean; params?: URLSearchParams;
  checkPhone?: (number: string) => Promise<PhoneResult>;
}): void {
  const definition = { ...opts.form.definition, fields: normalize(opts.form.definition.fields) };
  const asked = definition.fields.filter((f) => !f.from_url);
  const fromUrl = definition.fields.filter((f) => f.from_url);
  const params = opts.params ?? new URLSearchParams(window.location.search);
  const api = publicApi(opts.apiBase);
  const shownAt = Date.now();
  const prefix = `pcrm-${++counter}`;
  container.classList.add('pcrm-form');
  if (opts.form.theme.primary) container.style.setProperty('--pcrm-primary', opts.form.theme.primary);
  container.replaceChildren();

  let form: HTMLFormElement;
  if (opts.form.html) {
    container.innerHTML = opts.form.html; // cleaned by the API (no scripts or handlers)
    const found = container.querySelector('form');
    if (!found) {
      container.replaceChildren(el('p', { class: 'pcrm-muted' }, 'This form is not set up correctly.'));
      return;
    }
    form = found;
  } else {
    form = el('form', {}, ...asked.map((f) => generatedField(f, `${prefix}-${f.name}`)),
      el('div', { class: 'pcrm-error', role: 'alert', 'data-error': '_form' }),
      el('button', { type: 'submit' }, definition.submit_label));
    container.append(form);
  }
  form.noValidate = true;
  form.removeAttribute('action');

  // where each field shows, hides and reports errors
  const wrappers = new Map<string, HTMLElement[]>();
  const errors = new Map<string, HTMLElement>();
  for (const f of asked) {
    const controls = controlsNamed(form, f.name);
    const wrapper = form.querySelector<HTMLElement>(`[data-field="${f.name}"]`) ?? controls[0]?.closest<HTMLElement>('.pcrm-field');
    const parts = wrapper ? [wrapper] : [...controls, ...controls.flatMap((c) => (c.id ? [...form.querySelectorAll<HTMLElement>(`label[for="${c.id}"]`)] : []))];
    wrappers.set(f.name, parts);
    let error = form.querySelector<HTMLElement>(`[data-error="${f.name}"]`);
    if (!error) {
      error = el('div', { class: 'pcrm-error', role: 'alert' });
      if (wrapper) wrapper.append(error);
      else controls[controls.length - 1]?.after(error);
    }
    errors.set(f.name, error);
  }
  let formError = form.querySelector<HTMLElement>('[data-error="_form"]');
  if (!formError) {
    formError = el('div', { class: 'pcrm-error', role: 'alert' });
    const submit = form.querySelector('button[type=submit], button:not([type]), input[type=submit]');
    if (submit) submit.before(formError);
    else form.append(formError);
  }
  // honeypot: hidden from people, filled by bots
  const hp = el('input', { type: 'text', name: '_hp', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  form.append(el('div', { class: 'pcrm-hp' }, hp));

  for (const f of asked) {
    const v = fromParams(params, f);
    if (v !== undefined) prefill(form, f, v);
  }
  const urlValues = Object.fromEntries(fromUrl.map((f) => [f.name, fromParams(params, f)]).filter(([, v]) => !isEmpty(v)));

  // Country pickers in front of phone inputs (added once the region list
  // arrives; until then numbers without + are read as the API's default).
  const phoneFields = asked.filter((f) => f.format === 'phone');
  const pickers = new Map<string, HTMLSelectElement>();
  // the closed picker shows the flag; the open list has the names
  const faces = new Map<string, HTMLElement>();
  const setRegion = (name: string, region: string) => {
    const select = pickers.get(name);
    if (!select) return;
    select.value = region;
    faces.get(name)!.textContent = regionShort(regionList.find((r) => r.region === region));
  };
  let regionList: PhoneRegion[] = [];
  const regionOf = (name: string) => regionList.find((r) => r.region === pickers.get(name)?.value);
  if (phoneFields.length) {
    loadPhoneRegions(opts.apiBase).then(({ regions, default: fallback }) => {
      regionList = regions;
      for (const f of phoneFields) {
        const input = controlsNamed(form, f.name).find((c): c is HTMLInputElement => c instanceof HTMLInputElement);
        if (!input || pickers.has(f.name)) continue;
        const select = el('select', { class: 'pcrm-phone-country', 'aria-label': `${f.label} country` },
          ...regions.map((r) => el('option', { value: r.region }, regionLabel(r))));
        const face = el('span', { class: 'pcrm-country-face', 'aria-hidden': 'true' });
        const box = el('div', { class: 'pcrm-phone' });
        input.before(box);
        box.append(el('div', { class: 'pcrm-country' }, face, select), input);
        pickers.set(f.name, select);
        faces.set(f.name, face);
        setRegion(f.name, regionForNumber(input.value, regions, fallback) ?? fallback);
        select.addEventListener('change', () => {
          setRegion(f.name, select.value);
          errors.get(f.name)!.textContent = '';
          setInvalid(f.name, false);
          void checkPhoneField(f, input);
        });
      }
    }).catch(() => undefined);
  }
  const answerOf = (f: FormField) => {
    const v = readValue(form, f);
    return f.format === 'phone' && typeof v === 'string' ? composePhone(v, regionOf(f.name)) : v;
  };
  const answers = (): Record<string, unknown> => ({ ...urlValues, ...Object.fromEntries(asked.map((f) => [f.name, answerOf(f)])) });
  const setInvalid = (name: string, on: boolean) => {
    for (const w of wrappers.get(name) ?? []) w.classList.toggle('pcrm-invalid', on);
  };
  const update = () => {
    const shown = visibleFields(definition.fields, answers());
    for (const [name, parts] of wrappers) for (const p of parts) p.hidden = !shown.has(name);
    return shown;
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();

  // Formats are checked when the visitor leaves a field; while an error
  // shows, it clears as soon as the answer becomes valid. Phone answers are
  // checked by the API and, when valid, rewritten as +1 613-222-0328 ext4.
  const fieldOf = (target: EventTarget | null) => {
    const name = (target as HTMLInputElement | null)?.name;
    return name ? asked.find((f) => f.name === name && f.format) : undefined;
  };
  const checkPhone = opts.checkPhone ?? ((number: string) => api.phone(opts.key, number));
  // last answer per phone field: the text it was given for, and the result
  const phones = new Map<string, { input: string; result: PhoneResult }>();
  const phoneError = (f: FormField, r: PhoneResult) => `${f.label} must be a valid phone number${r.reason ? ` (${r.reason})` : ''}.`;
  // The number stays as typed when it is not valid; it is just not sent.
  async function checkPhoneField(f: FormField, c: HTMLInputElement) {
    const typed = c.value.trim();
    const input = composePhone(typed, regionOf(f.name));
    if (!input) return;
    let result: PhoneResult;
    try {
      result = await checkPhone(input);
    } catch {
      return; // offline or refused: the API checks again on submit
    }
    if (c.value.trim() !== typed) return; // changed while we asked
    if (result.valid && result.display) {
      c.value = result.display;
      const picker = pickers.get(f.name);
      if (picker && result.region && regionList.some((r) => r.region === result.region)) setRegion(f.name, result.region);
      phones.set(f.name, { input: result.display, result });
    } else {
      phones.set(f.name, { input, result });
      errors.get(f.name)!.textContent = phoneError(f, result);
      setInvalid(f.name, true);
    }
  }
  const checkFormat = (f: FormField, addErrors: boolean) => {
    const v = readValue(form, f);
    const problem = formatProblem(f, v);
    const error = errors.get(f.name)!;
    if (problem && addErrors) {
      error.textContent = problem;
      setInvalid(f.name, true);
    } else if (!problem && error.textContent) {
      error.textContent = '';
      setInvalid(f.name, false);
    }
    return problem;
  };
  form.addEventListener('focusout', (e) => {
    const f = fieldOf(e.target);
    if (!f) return;
    if (f.format === 'phone') void checkPhoneField(f, e.target as HTMLInputElement);
    else checkFormat(f, true);
  });
  form.addEventListener('input', (e) => {
    const f = fieldOf(e.target);
    if (!f) return;
    if (f.format === 'phone') {
      // being corrected: the error goes, the API checks again on leaving
      errors.get(f.name)!.textContent = '';
      setInvalid(f.name, false);
    } else checkFormat(f, false);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError!.textContent = '';
    for (const [name, node] of errors) {
      node.textContent = '';
      setInvalid(name, false);
    }
    const all = answers();
    const shown = update();
    const values: Record<string, unknown> = { ...urlValues };
    let firstBad: string | null = null;
    const bad = (f: FormField, message: string) => {
      errors.get(f.name)!.textContent = message;
      setInvalid(f.name, true);
      firstBad ??= f.name;
    };
    for (const f of asked) {
      if (!shown.has(f.name)) continue;
      const v = all[f.name];
      if (isEmpty(v)) {
        if (f.required) bad(f, `${f.label} is required.`);
        continue;
      }
      const known = f.format === 'phone' ? phones.get(f.name) : undefined;
      const problem = known && known.input === v && !known.result.valid ? phoneError(f, known.result) : formatProblem(f, v);
      if (problem) bad(f, problem);
      else values[f.name] = v;
    }
    if (firstBad) {
      controlsNamed(form, firstBad)[0]?.focus();
      return;
    }
    if (opts.preview) {
      container.replaceChildren(el('div', { class: 'pcrm-done', role: 'status' }, definition.success_message));
      return;
    }
    const submit = form.querySelector<HTMLButtonElement | HTMLInputElement>('button[type=submit], button:not([type]), input[type=submit]');
    if (submit) submit.disabled = true;
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
        setInvalid(e2.field, true);
      } else {
        formError!.textContent = e2.status === 403 ? 'This form cannot be sent from this website.' : e2.message;
      }
      if (submit) submit.disabled = false;
    }
  });
}
