import { useState } from 'react';
import { Banknote } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';

// Record page card for a payment a customer reported as an Interac e-Transfer.
// Staff mark it received once the money is in the bank (the invoice becomes
// paid, a quote paid instead of signed is accepted) or not received (the
// customer can pay again).
export function PaymentConfirmCard({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = record.properties;
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  if (first(p.method) !== 'etransfer' || first(p.status) !== 'pending') return null;

  async function act(action: 'confirm' | 'reject') {
    if (action === 'reject' && !confirm('Mark this e-Transfer as not received? The customer can then pay again.')) return;
    setError(null);
    setBusy(true);
    try {
      await api('POST', `/v1/objects/payments/${record.id}/${action}`);
      onChanged(await api<CrmRecord>('GET', `/v1/objects/payments/${record.id}`));
      toast(action === 'confirm' ? 'Marked as received' : 'Marked as not received');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <Banknote size={16} strokeWidth={1.75} />
        <h3>e-Transfer to confirm</h3>
      </div>
      <div className="small muted">
        {typeof p.payer_name === 'string' && p.payer_name ? `${p.payer_name} says they sent it` : 'The customer says they sent it'}
        {typeof p.reference === 'string' && p.reference ? ` with the message "${p.reference}"` : ''}. Check your bank, then:
      </div>
      {error && <div className="error">{error}</div>}
      <div className="public-link-actions">
        <button className="btn small primary" disabled={busy} onClick={() => act('confirm')}>Mark received</button>
        <button className="btn small" disabled={busy} onClick={() => act('reject')}>Not received</button>
      </div>
    </div>
  );
}
