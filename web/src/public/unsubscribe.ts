import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './public.css';
import { applyTheme } from '../lib/theme';
import { el, keyFromHash } from './public-api';

// The page behind the unsubscribe link in marketing email:
// /p/unsubscribe/#<token> (api/src/email/links.ts). Opening the page changes
// nothing (mail scanners open links); the button does. Mail apps' own
// unsubscribe button posts to the same address directly.

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const root = document.getElementById('root')!;
const token = keyFromHash();

interface State { email: string | null; opted_out: boolean; sender?: string | null; theme?: Record<string, string> }

async function call(method: 'GET' | 'POST'): Promise<State> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/public/unsubscribe/${encodeURIComponent(token)}`, {
      method,
      credentials: 'omit',
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `Something went wrong (${res.status}).`);
  return data as State;
}

function card(...children: (Node | string)[]): void {
  root.replaceChildren(el('main', { class: 'pp-page' }, el('div', { class: 'pp-card pp-center' }, ...children)));
}

function done(s: State): void {
  document.title = 'Unsubscribed';
  card(
    el('h1', {}, 'You are unsubscribed'),
    el('p', {}, `${s.email ?? 'This address'} will not get marketing email from ${s.sender ?? 'us'} any more. Email about things you ask for, like receipts, still comes.`)
  );
}

function ask(s: State): void {
  const button = el('button', { class: 'pp-btn primary', type: 'button' }, 'Unsubscribe');
  const note = el('p', { class: 'pp-muted' });
  button.addEventListener('click', async () => {
    button.setAttribute('disabled', '');
    note.textContent = '';
    try {
      done(await call('POST'));
    } catch (err) {
      button.removeAttribute('disabled');
      note.textContent = (err as Error).message;
    }
  });
  card(
    el('h1', {}, 'Unsubscribe'),
    el('p', {}, `Stop marketing email from ${s.sender ?? 'us'} to ${s.email ?? 'this address'}?`),
    el('div', { class: 'pp-actions', style: 'justify-content:center' }, button),
    note
  );
}

async function load(): Promise<void> {
  if (!token) return card(el('p', {}, 'This link is missing its code. Use the unsubscribe link in the email you got.'));
  try {
    const s = await call('GET');
    applyTheme(s.theme);
    if (s.opted_out) done(s);
    else ask(s);
  } catch (err) {
    card(el('p', {}, (err as Error).message));
  }
}

applyTheme(undefined);
void load();
