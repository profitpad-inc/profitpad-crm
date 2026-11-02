import { el, type PublicPayment } from './public-api';
import { day, money } from './document';

// The "Pay" part of the quote and invoice pages: pay online on Stripe
// Checkout, or send an Interac e-Transfer and say so. Shows "processing" while
// a bank payment or e-Transfer is waiting and "paid" once it has cleared.

const METHOD: Record<string, string> = {
  ach: 'bank payment', pad: 'pre-authorized debit', etransfer: 'Interac e-Transfer'
};

export interface PaymentActions {
  pay: () => Promise<{ url: string }>;
  etransferSent: (body: { name: string; email: string }) => Promise<unknown>;
  reload: () => Promise<void>;
  // prefill for the e-Transfer form
  contact: { name: string | null; email: string | null } | null;
}

export function paymentBox(p: PublicPayment | null, actions: PaymentActions): HTMLElement | null {
  if (!p) return null;
  const amount = money(p.amount_due, p.currency);
  const what = p.kind === 'deposit' ? 'Deposit' : 'Payment';

  if (p.status === 'paid') {
    return el('div', { class: 'pp-note pp-paid', role: 'status' },
      `${what} received${p.paid_at ? ` on ${day(p.paid_at)}` : ''}. Thank you.`);
  }
  if (p.status === 'pending') {
    const how = p.pending_method ? METHOD[p.pending_method] : null;
    return el('div', { class: 'pp-note', role: 'status' },
      p.pending_method === 'etransfer'
        ? `Thanks, we'll confirm your ${how} of ${amount} when it arrives.`
        : `Your ${how ?? 'payment'} of ${amount} is processing. Bank payments can take a few business days to clear.`);
  }
  if (!p.can_pay) return null;

  const box = el('div', { class: 'pp-pay' },
    el('h2', {}, p.kind === 'deposit' ? `Pay the deposit: ${amount}` : `Pay ${amount}`));
  const error = el('div', { class: 'pp-error', role: 'alert' });
  const buttons = el('div', { class: 'pp-actions', style: 'margin-top:0' });
  const detail = el('div', {});

  if (p.online) {
    const online = el('button', { class: 'pp-btn primary', type: 'button' }, 'Pay online');
    online.addEventListener('click', async () => {
      online.disabled = true;
      error.textContent = '';
      try {
        const { url } = await actions.pay();
        window.location.assign(url);
      } catch (err) {
        error.textContent = (err as Error).message;
        online.disabled = false;
      }
    });
    buttons.append(online);
  }
  if (p.etransfer) {
    const et = p.etransfer;
    const show = el('button', { class: p.online ? 'pp-btn' : 'pp-btn primary', type: 'button' }, 'Pay by Interac e-Transfer');
    show.addEventListener('click', () => {
      show.disabled = true;
      detail.replaceChildren(etransferForm(et, amount, actions, error));
    });
    buttons.append(show);
  }
  box.append(buttons, detail, error);
  return box;
}

function etransferForm(et: NonNullable<PublicPayment['etransfer']>, amount: string, actions: PaymentActions, error: HTMLElement): HTMLElement {
  const name = el('input', { type: 'text', name: 'name', autocomplete: 'name', required: true, maxlength: '200' });
  const email = el('input', { type: 'email', name: 'email', autocomplete: 'email', required: true, maxlength: '254' });
  name.value = actions.contact?.name ?? '';
  email.value = actions.contact?.email ?? '';
  const submit = el('button', { class: 'pp-btn primary', type: 'submit' }, "I've sent it");
  const form = el('form', { class: 'pp-respond', novalidate: true },
    el('dl', { class: 'pp-meta' },
      el('dt', {}, 'Amount'), el('dd', {}, amount),
      el('dt', {}, 'Send to'), el('dd', {}, et.email),
      el('dt', {}, 'Message'), el('dd', {}, et.reference)),
    et.instructions ? el('p', { class: 'pp-muted pp-instructions' }, et.instructions) : null,
    el('p', { class: 'pp-muted' }, 'Once you have sent it, let us know:'),
    el('label', {}, 'Your name', name),
    el('label', {}, 'Your email', email),
    el('div', { class: 'pp-actions', style: 'margin-top:0' }, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!name.value.trim() || !email.value.trim()) {
      error.textContent = 'Enter your name and email.';
      return;
    }
    submit.disabled = true;
    try {
      await actions.etransferSent({ name: name.value.trim(), email: email.value.trim() });
      await actions.reload();
    } catch (err) {
      error.textContent = (err as Error).message;
      submit.disabled = false;
    }
  });
  return form;
}

// Back from Stripe Checkout (?paid=1): the webhook usually lands within
// seconds; check a few times so the page shows the result. After the first
// try the API also asks Stripe directly, in case the webhook is missing.
export async function afterCheckout(reload: () => Promise<PublicPayment | null>, check: () => Promise<unknown>): Promise<void> {
  const url = new URL(window.location.href);
  if (url.searchParams.get('paid') !== '1') return;
  url.searchParams.delete('paid');
  window.history.replaceState(null, '', url.toString());
  for (let i = 0; i < 8; i++) {
    if (i > 0) await check().catch(() => undefined);
    const p = await reload();
    if (!p || p.status !== 'unpaid') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
