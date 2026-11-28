import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { api, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { primaryValue } from '../lib/multi-values';
import { Loading } from './Loading';
import { Modal } from './ui';

// "Send a test" on a campaign: pick CRM users (you, to start with) and the
// email as drawn for the previewed contact goes to each of them, marked [Test]
// (POST /v1/email/campaigns/:id/test with user_ids). Never to the contact.

interface CrmUser { id: string; name: string; email: string }

export function CampaignSendTest({ campaignId, contactId, step_id, variant_id, onClose }: {
  campaignId: string; contactId: string | null; onClose: () => void;
  // which of the campaign's emails and variants (default email 1, A)
  step_id?: string; variant_id?: string;
}) {
  const { me, toast } = useApp();
  const [users, setUsers] = useState<CrmUser[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(me.user ? [me.user.id] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SearchResult>('QUERY', '/v1/objects/users/search', {
      limit: 200, properties: ['name', 'email', 'status'], sorts: [{ property: 'name', direction: 'asc' }]
    })
      .then((r) => setUsers(r.results.flatMap((u) => {
        const email = primaryValue(u.properties.email);
        const raw = u.properties.status;
        const status = Array.isArray(raw) ? raw[0] : raw;
        return email && (!status || status === 'active') ? [{ id: u.id, name: String(u.properties.name ?? '') || email, email }] : [];
      })))
      .catch((e) => { setUsers([]); setError((e as Error).message); });
  }, []);

  const toggle = (id: string) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  // only users still in the list (the signed-in one may have no email)
  const chosen = (users ?? []).filter((u) => picked.has(u.id));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ sent: string[] }>('POST', `/v1/email/campaigns/${campaignId}/test`, {
        ...(contactId ? { contact_id: contactId } : {}),
        ...(step_id ? { step_id, variant_id } : {}),
        user_ids: chosen.map((u) => u.id)
      });
      toast(r.sent.length === 1 ? `Test sent to ${r.sent[0]}.` : `Test sent to ${r.sent.length} users.`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Send a test" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" disabled={busy || chosen.length === 0} onClick={send}>
          <Send size={14} /> {busy ? 'Sending…' : chosen.length > 1 ? `Send to ${chosen.length}` : 'Send'}
        </button>
      </>
    }>
      <p className="muted">The email as drawn in the preview goes to the users picked, with [Test] before the subject. It never goes to the contact.</p>
      {error && <div className="error">{error}</div>}
      {users === null ? <Loading /> : users.length === 0 ? <p className="muted">No active users with an email address.</p> : (
        <ul className="campaign-test-users">
          {users.map((u) => (
            <li key={u.id}>
              <label>
                <input type="checkbox" checked={picked.has(u.id)} disabled={busy} onChange={() => toggle(u.id)} />
                <span>{u.name}<span className="small muted"> {u.email}</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
