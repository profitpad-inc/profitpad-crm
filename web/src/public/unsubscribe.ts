import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './public.css';
import { applyTheme } from '../lib/theme';
import { el, keyFromHash } from './public-api';

// The page behind the unsubscribe link in marketing email:
// /p/unsubscribe/#<token> (api/src/email/links.ts). Opening the page changes
// nothing (mail scanners open links); the buttons do. Mail apps' own
// unsubscribe button posts to the same address directly.
//
// Without email subscription types (api/src/email/topics.ts) it is one
// Unsubscribe button. With them it is a preference page: a switch per type
// (on = they get it), Save, a quick button to leave the type of the email
// they came from, and Unsubscribe from all. Someone who unsubscribed from
// all can come back here; bounces and spam complaints cannot.

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const root = document.getElementById('root')!;
const token = keyFromHash();

interface Topic { value: string; label: string; description: string | null; subscribed: boolean }
interface State {
  email: string | null;
  opted_out: boolean;
  can_resubscribe: boolean;
  sender?: string | null;
  campaign_topic: string | null;
  topics: Topic[];
  theme?: Record<string, string>;
}
type Body = { action: 'unsubscribe_all' } | { action: 'save'; unsubscribed: string[]; resubscribe?: boolean };

async function call(method: 'GET' | 'POST', body?: Body): Promise<State> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/public/unsubscribe/${encodeURIComponent(token)}`, {
      method,
      credentials: 'omit',
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `Something went wrong (${res.status}).`);
  return data as State;
}

const sender = (s: State) => s.sender ?? 'us';
const who = (s: State) => s.email ?? 'this address';

function card(...children: (Node | string | null | false)[]): void {
  root.replaceChildren(el('main', { class: 'pp-page' }, el('div', { class: 'pp-card pp-center' }, ...children)));
}

// A button that posts, shows errors in `note`, and redraws with the answer.
function action(label: string, cls: string, body: () => Body, note: HTMLElement, after?: (s: State) => void): HTMLButtonElement {
  const button = el('button', { class: `pp-btn ${cls}`, type: 'button' }, label);
  button.addEventListener('click', async () => {
    root.querySelectorAll('button, input').forEach((b) => b.setAttribute('disabled', ''));
    note.textContent = '';
    try {
      const s = await call('POST', body());
      draw(s);
      after?.(s);
    } catch (err) {
      root.querySelectorAll('button, input').forEach((b) => b.removeAttribute('disabled'));
      note.textContent = (err as Error).message;
    }
  });
  return button;
}

// ---- no subscription types: one button ----

function simple(s: State): void {
  const note = el('p', { class: 'pp-error' });
  if (s.opted_out) {
    document.title = 'Unsubscribed';
    card(
      el('h1', {}, 'You are unsubscribed'),
      el('p', {}, `${who(s)} will not get marketing email from ${sender(s)} any more. Email about things you ask for, like receipts, still comes.`),
      s.can_resubscribe && el('div', { class: 'pp-actions', style: 'justify-content:center' },
        action('Subscribe again', 'quiet', () => ({ action: 'save', unsubscribed: [], resubscribe: true }), note)),
      note
    );
    return;
  }
  document.title = 'Unsubscribe';
  card(
    el('h1', {}, 'Unsubscribe'),
    el('p', {}, `Stop marketing email from ${sender(s)} to ${who(s)}?`),
    el('div', { class: 'pp-actions', style: 'justify-content:center' }, action('Unsubscribe', 'primary', () => ({ action: 'unsubscribe_all' }), note)),
    note
  );
}

// ---- subscription types: the preference page ----

function preferences(s: State, saved?: string): void {
  document.title = 'Email preferences';
  const locked = s.opted_out && !s.can_resubscribe;
  const note = el('p', { class: 'pp-error' });
  const switches = new Map<string, HTMLInputElement>();

  const items = s.topics.map((t) => {
    const input = el('input', { type: 'checkbox', role: 'switch', 'aria-describedby': t.description ? `d-${t.value}` : undefined }) as HTMLInputElement;
    // while unsubscribed from all, nothing is on until they choose to come back
    input.checked = t.subscribed && !s.opted_out;
    input.disabled = locked;
    switches.set(t.value, input);
    return el('li', {},
      el('label', { class: `pp-topic${t.value === s.campaign_topic ? ' current' : ''}` },
        input,
        el('span', {}, el('strong', {}, t.label), t.description ? el('span', { class: 'pp-muted', id: `d-${t.value}` }, t.description) : null)));
  });

  const startOn = new Map(s.topics.map((t) => [t.value, t.subscribed && !s.opted_out]));
  const unsubscribed = () => [...switches].filter(([, i]) => !i.checked).map(([v]) => v);
  const anyOn = () => [...switches.values()].some((i) => i.checked);
  const changed = () => [...switches].some(([v, i]) => i.checked !== startOn.get(v));

  const saveLabel = () => (s.opted_out && anyOn() ? 'Save and subscribe again' : 'Save preferences');
  const save = action(saveLabel(), 'primary', () => ({ action: 'save', unsubscribed: unsubscribed(), resubscribe: s.opted_out && anyOn() }), note,
    () => preferences(current!, 'Your preferences are saved.'));
  save.disabled = true;
  const refresh = () => {
    save.disabled = locked || !changed();
    save.textContent = saveLabel();
  };
  switches.forEach((i) => i.addEventListener('change', refresh));

  const campaign = s.topics.find((t) => t.value === s.campaign_topic && t.subscribed);
  const quick = !s.opted_out && campaign
    ? el('div', { class: 'pp-actions', style: 'margin-top:20px' },
      action(`Unsubscribe from ${campaign.label}`, 'primary', () => ({ action: 'save', unsubscribed: [...new Set([...s.topics.filter((t) => !t.subscribed).map((t) => t.value), campaign.value])] }), note,
        () => preferences(current!, `You will not get ${campaign.label} email any more.`)))
    : null;

  const status = saved
    ? el('div', { class: 'pp-note good', role: 'status' }, saved)
    : s.opted_out
      ? el('div', { class: 'pp-note wait' },
        locked
          ? `${who(s)} does not get marketing email from ${sender(s)}. To get it again, contact ${sender(s)}.`
          : `You are unsubscribed from all marketing email. Turn on what you want to get and save to subscribe again.`)
      : null;

  root.replaceChildren(el('main', { class: 'pp-page pp-prefs' }, el('div', { class: 'pp-card' },
    el('h1', {}, 'Email preferences'),
    el('p', { class: 'pp-muted' }, `Choose the email ${sender(s)} sends to ${who(s)}. Email about things you ask for, like receipts, always comes.`),
    status,
    quick,
    el('ul', { class: 'pp-topics' }, ...items),
    el('div', { class: 'pp-actions' },
      save,
      !s.opted_out && action('Unsubscribe from all', 'quiet', () => ({ action: 'unsubscribe_all' }), note,
        () => preferences(current!, 'You are unsubscribed from all marketing email.'))),
    note
  )));
}

let current: State | null = null;

function draw(s: State): void {
  current = s;
  if (s.topics.length) preferences(s);
  else simple(s);
}

async function load(): Promise<void> {
  if (!token) return card(el('p', {}, 'This link is missing its code. Use the unsubscribe link in the email you got.'));
  try {
    const s = await call('GET');
    applyTheme(s.theme);
    draw(s);
  } catch (err) {
    card(el('p', {}, (err as Error).message));
  }
}

applyTheme(undefined);
void load();
