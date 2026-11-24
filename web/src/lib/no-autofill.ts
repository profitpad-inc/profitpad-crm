// Keeps password managers (1Password, LastPass, Bitwarden, Dashlane) and the
// browser's own autofill out of the CRM. Almost every box here holds someone
// else's data (a contact's name, a deal amount), so suggestions from the
// signed-in user's vault are never wanted. Instead of tagging every input by
// hand, this watches the page and tags each text box as it appears.
// Public pages (forms, booking, quotes) don't install it: visitors there
// fill in their own details.

const SKIP_TYPES = new Set(['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

const IGNORE_ATTRS: [string, string][] = [
  ['data-1p-ignore', ''], // 1Password
  ['data-lpignore', 'true'], // LastPass
  ['data-bwignore', ''], // Bitwarden
  ['data-form-type', 'other'] // Dashlane
];

function tag(el: Element): void {
  if (el instanceof HTMLInputElement) {
    if (SKIP_TYPES.has(el.type)) return;
  } else if (!(el instanceof HTMLTextAreaElement)) {
    return;
  }
  if (el.hasAttribute('data-1p-ignore')) return;
  for (const [name, value] of IGNORE_ATTRS) {
    if (!el.hasAttribute(name)) el.setAttribute(name, value);
  }
  // a box that already says what it wants (new-password on webhook secrets) keeps it
  if (!el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
}

function tagTree(root: Element): void {
  tag(root);
  root.querySelectorAll('input, textarea').forEach(tag);
}

export function installNoAutofill(): void {
  if (typeof document === 'undefined' || (window as { __noAutofill?: boolean }).__noAutofill) return;
  (window as { __noAutofill?: boolean }).__noAutofill = true;

  // The observer below runs a beat after a box is inserted, but React's autoFocus
  // (click-to-edit cells) focuses it synchronously on mount, and password
  // managers decide what to offer on that first focus. So tag a box right before
  // it can take focus: when code calls .focus(), and when focus lands on it.
  for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    const focus = proto.focus;
    proto.focus = function (this: HTMLElement, options?: FocusOptions) {
      tag(this);
      return focus.call(this, options);
    };
  }
  window.addEventListener('focusin', (e) => {
    if (e.target instanceof Element) tag(e.target);
  }, true);

  const start = () => {
    tagTree(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          tag(r.target as Element); // an input whose type changed (e.g. text to password)
          continue;
        }
        r.addedNodes.forEach((n) => {
          if (n instanceof Element) tagTree(n);
        });
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
