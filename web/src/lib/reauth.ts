// "Confirm it's you": admin changes need a sign-in within the last 4 hours
// (the API answers 403 reauth_required). api() waits on requestReauth(),
// the app shows the sign-in over the page (main.tsx, Login reauth), and the
// sign-in runs in a popup so the page keeps everything typed into it. When
// the popup reports back (public/signed-in.html), the request is sent again.

type AuthMessage = { type: 'signed-in' | 'failed'; error?: string | null; detail?: string | null };

let pending: Promise<boolean> | null = null;
let settle: ((ok: boolean) => void) | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const reauthPending = () => pending !== null;

export function onReauthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Resolves true once signed in again, false if the person cancels. Requests
// that hit the check at the same time share one sign-in.
export function requestReauth(): Promise<boolean> {
  if (!pending) {
    pending = new Promise((resolve) => (settle = resolve));
    notify();
  }
  return pending;
}

export function finishReauth(ok: boolean) {
  settle?.(ok);
  pending = null;
  settle = null;
  notify();
}

// Messages from the sign-in popup. BroadcastChannel, with the storage event
// as a fallback; the same message can arrive both ways.
export function watchSignIn(onMessage: (m: AuthMessage) => void): () => void {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('pcrm-auth');
  if (channel) channel.onmessage = (e) => onMessage(e.data as AuthMessage);
  const storage = (e: StorageEvent) => {
    if (e.key !== 'pcrm-auth' || !e.newValue) return;
    try {
      onMessage(JSON.parse(e.newValue) as AuthMessage);
    } catch {
      // not ours
    }
  };
  window.addEventListener('storage', storage);
  return () => {
    channel?.close();
    window.removeEventListener('storage', storage);
  };
}

// Opens the sign-in in a popup; false when the browser blocked it.
export function openSignInPopup(href: string): boolean {
  const w = 500;
  const h = 650;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  return window.open(href, 'pcrm-signin', `popup,width=${w},height=${h},left=${left},top=${top}`) !== null;
}
