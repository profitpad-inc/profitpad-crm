import { useEffect, useState } from 'react';
import { Plus, Search, Send, X } from 'lucide-react';
import { api, type CrmRecord, type SearchResult } from '../lib/api';
import { useApp } from '../lib/app-context';
import { primaryValue } from '../lib/multi-values';
import { Loading } from './Loading';
import { Modal } from './ui';
import { confirmDialog } from './confirm';
import '../lists.css';

// "Send to more" on a campaign that went out: find contacts, pick them, and
// the campaign goes to them straight away (POST /v1/email/campaigns/:id/send-more,
// api/src/email/campaigns.ts sendToMore). The campaign's lists stay as they are.

interface Picked { id: string; name: string; email: string | null }
interface Result { status: string; queued: number; skipped: { contact_id: string; email: string | null; why: string }[] }

const emailOf = (r: CrmRecord): string | null => primaryValue(r.properties.email);

export function CampaignSendMore({ campaignId, campaignName, onClose, onSent }: {
  campaignId: string; campaignName: string; onClose: () => void; onSent: () => Promise<void>;
}) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<CrmRecord[] | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<SearchResult>('QUERY', '/v1/objects/contacts/search', { query: q.trim() || undefined, limit: 10, properties: ['name', 'email'] })
        .then((r) => setFound(r.results))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (r: CrmRecord) => setPicked((cur) => (cur.some((x) => x.id === r.id) ? cur
    : [...cur, { id: r.id, name: String(r.properties.name ?? '') || r.id, email: emailOf(r) }]));
  const unpick = (id: string) => setPicked((cur) => cur.filter((x) => x.id !== id));

  async function send() {
    const n = picked.length;
    const ok = await confirmDialog(
      `Send "${campaignName}" to ${n} more contact${n === 1 ? '' : 's'} now? Anyone who already got it, opted out or left its subscription type is left out. This can't be undone.`,
      { title: 'Send to more', confirmLabel: `Send to ${n}` }
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Result>('POST', `/v1/email/campaigns/${campaignId}/send-more`, { contact_ids: picked.map((x) => x.id) });
      setResult(r);
      if (r.queued) toast(`Sending to ${r.queued} more contact${r.queued === 1 ? '' : 's'}.`);
      await onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: string) => picked.find((x) => x.id === id)?.name ?? id;

  if (result) {
    return (
      <Modal title="Send to more" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p>{result.queued ? `Sending to ${result.queued} contact${result.queued === 1 ? '' : 's'} now.` : 'No one was sent it.'}</p>
        {result.skipped.length > 0 && (
          <>
            <p className="muted">Left out:</p>
            <ul className="list-add-results">
              {result.skipped.map((s) => (
                <li key={s.contact_id}><span>{nameOf(s.contact_id)}{s.email ? ` (${s.email})` : ''}</span><span className="small muted">{s.why}</span></li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    );
  }

  return (
    <Modal title="Send to more" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" disabled={busy || picked.length === 0} onClick={send}>
          <Send size={14} /> {busy ? 'Sending…' : picked.length ? `Send to ${picked.length}` : 'Send'}
        </button>
      </>
    }>
      <p className="muted">Pick contacts to send this campaign to now. They are not added to its lists.</p>
      {picked.length > 0 && (
        <ul className="campaign-picked">
          {picked.map((x) => (
            <li key={x.id}>
              <span>{x.name}{x.email ? <span className="small muted"> {x.email}</span> : <span className="small muted"> no email</span>}</span>
              <button className="icon-btn" aria-label={`Remove ${x.name}`} onClick={() => unpick(x.id)}><X size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="list-add">
        <div className="list-add-search">
          <Search size={15} aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find contacts" aria-label="Find contacts" />
        </div>
        {found === null ? <Loading inline /> : found.length === 0 ? <p className="muted small">Nothing found.</p> : (
          <ul className="list-add-results">
            {found.map((r) => {
              const on = picked.some((x) => x.id === r.id);
              return (
                <li key={r.id}>
                  <span>{String(r.properties.name ?? '') || r.id}<span className="small muted"> {emailOf(r) ?? 'no email'}</span></span>
                  <button className="btn small" disabled={on} onClick={() => pick(r)}><Plus size={14} aria-hidden /> {on ? 'Picked' : 'Pick'}</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
