import { confirmDialog } from './confirm';
import { displayPhone } from '../lib/phone-display';
import { entriesOf, type MultiType } from '../lib/multi-values';

// Before saving an email or phone list: when the primary (first entry)
// becomes a different value, asks first, since the CRM sends to the primary.
// true when there is nothing to ask or the user agreed.
export async function confirmPrimaryChange(type: MultiType, before: unknown, after: unknown): Promise<boolean> {
  const was = entriesOf(before)[0]?.value;
  const next = entriesOf(after)[0]?.value;
  if (!was || !next || was === next) return true;
  const noun = type === 'email' ? 'email' : 'phone number';
  return confirmDialog(
    type === 'email'
      ? `${next} will become the primary email instead of ${was}. Emails and campaigns from the CRM go to the primary address.`
      : `${displayPhone(next)} will become the primary phone number instead of ${displayPhone(was)}.`,
    { title: `Change the primary ${noun}?`, confirmLabel: 'Make primary' }
  );
}
