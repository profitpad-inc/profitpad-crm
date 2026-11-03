import { el } from './public-api';

// The CRM's dropdown (components/Select.tsx) for public pages in plain DOM:
// forms (hosted, embedded and the builder's preview) and the booking page's
// time zone. The native <select> stays in place but hidden, so reading
// answers, prefills, custom HTML and validation work on it as before; a
// field-like face opens a list of its options under it. Picking sets the
// select's value and fires input and change. Code that sets the value itself
// calls refresh(). Lists longer than 10 get a search box, which matches
// anywhere in a choice, across slashes and underscores ("van" finds
// America/Vancouver), with choices that have a word starting with it first.
// A select that is not on the page yet is wrapped all the same: place the
// returned element instead of the select.
//
// Divs, not buttons, so a website's own button styles cannot reach them.
// Styled by DROPDOWN_CSS (part of FORM_CSS); the face is styled by the page
// like its other fields (.pcrm-dd-face).

export interface Dropdown { refresh: () => void; element: HTMLElement }

const SEARCH_FROM = 11;

export const DROPDOWN_CSS = `
.pcrm-dd { position: relative; display: block; min-width: 0; }
.pcrm-dd > select { position: absolute !important; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none; }
.pcrm-dd > .pcrm-dd-face { display: flex; align-items: center; cursor: pointer; text-align: left; white-space: nowrap; user-select: none; -webkit-user-select: none; }
.pcrm-dd-face > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pcrm-dd-face.pcrm-dd-empty { color: var(--pcrm-muted, var(--muted-text, #5f6672)); }
.pcrm-dd-face[aria-disabled=true] { opacity: .6; cursor: default; }
.pcrm-dd-list { position: absolute; z-index: 50; top: calc(100% + 4px); left: 0; min-width: 100%; width: max-content; max-width: min(420px, calc(100vw - 16px));
  display: flex; flex-direction: column; max-height: 300px; padding: 4px; box-sizing: border-box; font-size: 15px; font-weight: 400; line-height: 1.4; text-align: left;
  color: var(--pcrm-text, var(--text, #1f2328)); background: var(--pcrm-field, var(--page-background, #fff));
  border: 1px solid var(--pcrm-border, var(--border, #d0d4da)); border-radius: 8px; box-shadow: 0 6px 20px rgba(24, 32, 43, .12), 0 1px 3px rgba(24, 32, 43, .08); }
.pcrm-dd-list[hidden] { display: none !important; }
.pcrm-dd.pcrm-dd-up .pcrm-dd-list { top: auto; bottom: calc(100% + 4px); }
.pcrm-dd-list input.pcrm-dd-search { flex: none; display: block; width: 100%; min-height: 0; height: auto; margin: 0 0 4px; padding: 7px 10px; font: inherit; color: inherit;
  background: transparent; border: 1px solid var(--pcrm-border, var(--border, #d0d4da)); border-radius: 6px; box-shadow: none; }
.pcrm-dd-list input.pcrm-dd-search:focus { outline: 2px solid transparent; border-color: var(--pcrm-primary, var(--primary, #1f7a74)); box-shadow: none; }
.pcrm-dd-options { overflow-y: auto; min-height: 0; }
.pcrm-dd-opt { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.pcrm-dd-opt.pcrm-dd-active { background: color-mix(in srgb, var(--pcrm-text, var(--text, #1f2328)) 6%, transparent); }
.pcrm-dd-opt[aria-selected=true] { font-weight: 600; }
.pcrm-dd-opt[aria-disabled=true] { opacity: .5; cursor: default; }
.pcrm-dd-opt svg { flex: none; color: var(--pcrm-primary, var(--primary, #1f7a74)); }
.pcrm-dd-none { padding: 8px 10px; color: var(--pcrm-muted, var(--muted-text, #5f6672)); }
`;

const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
let counter = 0;

// lower case, with slashes and underscores read as spaces
const words = (s: string) => s.toLowerCase().replace(/[/_]+/g, ' ').replace(/\s+/g, ' ').trim();

// face: what the closed dropdown shows instead of the picked option's text
export function enhanceSelect(select: HTMLSelectElement, opts: { face?: (select: HTMLSelectElement) => string } = {}): Dropdown {
  const listId = `pcrm-dd-${++counter}`;
  const label = select.getAttribute('aria-label') ?? select.labels?.[0]?.textContent?.replace(/\*$/, '').trim() ?? '';
  const text = el('span');
  const face = el('div', { class: 'pcrm-dd-face', role: 'combobox', tabindex: '0', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-label': label || undefined }, text);
  const options = el('div', { class: 'pcrm-dd-options', role: 'listbox', id: listId, 'aria-label': label || undefined });
  const none = el('div', { class: 'pcrm-dd-none' }, 'No matches');
  const search = el('input', { class: 'pcrm-dd-search', placeholder: 'Search', 'aria-label': 'Search', autocomplete: 'off' });
  const list = el('div', { class: 'pcrm-dd-list', hidden: true });
  const box = el('div', { class: 'pcrm-dd' });
  select.before(box);
  box.append(select, face, list);
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  // a label's click and focusing the first wrong answer land on the select
  select.addEventListener('focus', () => face.focus());

  let shown: HTMLOptionElement[] = [];
  let active = 0;
  const isOpen = () => !list.hidden;
  // composedPath sees through the booking embed's shadow root
  const onOutside = (e: MouseEvent) => {
    if (!e.composedPath().includes(box)) close();
  };
  const searchable = () => select.options.length >= SEARCH_FROM;

  const refresh = () => {
    const picked = select.selectedOptions[0];
    text.textContent = opts.face?.(select) ?? picked?.textContent ?? '';
    face.classList.toggle('pcrm-dd-empty', select.value === '');
    face.setAttribute('aria-disabled', String(select.disabled));
    face.tabIndex = select.disabled ? -1 : 0;
  };

  const draw = () => {
    const q = words(search.value);
    const all = [...select.options];
    if (q) {
      const hits = all.map((o) => ({ o, w: ` ${words(`${o.textContent ?? ''} ${o.value}`)}` })).filter((h) => h.w.includes(q));
      shown = [...hits.filter((h) => h.w.includes(` ${q}`)), ...hits.filter((h) => !h.w.includes(` ${q}`))].map((h) => h.o);
    } else shown = all;
    options.replaceChildren(...shown.map((o, i) => {
      const row = el('div', { class: `pcrm-dd-opt${i === active ? ' pcrm-dd-active' : ''}`, role: 'option', 'aria-selected': String(o.selected), 'aria-disabled': o.disabled ? 'true' : undefined },
        el('span', {}, o.textContent || ' '));
      if (o.selected) row.insertAdjacentHTML('beforeend', CHECK);
      row.addEventListener('mouseenter', () => setActive(i));
      row.addEventListener('click', () => pick(o));
      return row;
    }));
    if (!shown.length) options.append(none);
  };
  const setActive = (i: number) => {
    options.children[active]?.classList.remove('pcrm-dd-active');
    active = i;
    const row = options.children[active];
    row?.classList.add('pcrm-dd-active');
    row?.scrollIntoView({ block: 'nearest' });
  };
  const move = (from: number, step: number) => {
    for (let i = from + step; i >= 0 && i < shown.length; i += step) if (!shown[i].disabled) return setActive(i);
  };

  const open = () => {
    if (select.disabled || isOpen()) return;
    search.value = '';
    if (searchable()) list.prepend(search);
    else search.remove();
    list.append(options);
    active = Math.max(0, select.selectedIndex);
    draw();
    const r = face.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    box.classList.toggle('pcrm-dd-up', below < 240 && r.top > below);
    list.hidden = false;
    face.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside);
    options.children[active]?.scrollIntoView({ block: 'nearest' });
    if (searchable()) search.focus();
  };
  const close = (refocus = false) => {
    if (!isOpen()) return;
    list.hidden = true;
    face.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside);
    if (refocus) face.focus();
  };
  const pick = (o: HTMLOptionElement | undefined) => {
    if (!o || o.disabled) return;
    close(true);
    if (o.value === select.value && o.selected) return;
    o.selected = true;
    refresh();
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const onKey = (e: KeyboardEvent) => {
    if (!isOpen()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(active, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(active, -1); }
    else if (e.key === 'Home') { e.preventDefault(); move(-1, 1); }
    else if (e.key === 'End') { e.preventDefault(); move(shown.length, -1); }
    // Enter in the search box would otherwise send the form
    else if (e.key === 'Enter' || (e.key === ' ' && e.target === face)) { e.preventDefault(); pick(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close();
    else if (e.target === face && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      for (let s = 1; s <= shown.length; s++) {
        const i = (active + s) % shown.length;
        if (!shown[i].disabled && (shown[i].textContent ?? '').toLowerCase().startsWith(k)) return setActive(i);
      }
    }
  };
  face.addEventListener('keydown', onKey);
  search.addEventListener('keydown', onKey);
  // the search box's typing is not an answer to the form
  search.addEventListener('input', (e) => {
    e.stopPropagation();
    active = 0;
    draw();
  });
  face.addEventListener('click', () => (isOpen() ? close() : open()));
  // clicks in the list keep focus on the face or the search box
  list.addEventListener('mousedown', (e) => e.target !== search && e.preventDefault());
  box.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (!to || !box.contains(to)) close();
  });
  select.addEventListener('change', refresh);

  refresh();
  return { refresh, element: box };
}
