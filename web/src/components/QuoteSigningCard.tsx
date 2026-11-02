import { useEffect, useRef, useState } from 'react';
import { PenLine } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { attachSignaturePad, type SignaturePad } from '../public/signature-pad';
import { Modal } from './ui';

// Record page card for quotes: the fields the customer fills in before
// signing (JSON, checked by the API), the signatures once given, and the
// staff countersignature when the quote waits for one.

const EXAMPLE = `[
  { "key": "po_number", "label": "PO number", "type": "text", "required": true }
]`;

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

function pretty(raw: unknown): string {
  const s = str(raw);
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export function QuoteSigningCard({ record, onChanged }: { record: CrmRecord; onChanged: (r: CrmRecord) => void }) {
  const { toast } = useApp();
  const p = record.properties;
  const status = Array.isArray(p.status) ? p.status[0] : p.status;
  const saved = pretty(p.signing_fields);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [countersigning, setCountersigning] = useState(false);
  useEffect(() => setDraft(saved), [saved]);

  let signedFields: Record<string, string> = {};
  try {
    signedFields = str(p.signed_fields) ? JSON.parse(p.signed_fields as string) : {};
  } catch {
    // shown as nothing; the API only stores valid JSON
  }
  let labels: Record<string, string> = {};
  try {
    labels = Object.fromEntries((JSON.parse(str(p.signing_fields) ?? '[]') as { key: string; label: string }[]).map((f) => [f.key, f.label]));
  } catch {
    // keys are shown instead of labels
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const value = draft.trim() ? draft.trim() : null;
      onChanged(await api<CrmRecord>('PATCH', `/v1/objects/quotes/${record.id}`, { properties: { signing_fields: value } }));
      toast('Saved');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card signing-card">
      <div className="card-head">
        <PenLine size={16} strokeWidth={1.75} />
        <h3>Signing</h3>
      </div>

      {status === 'pending_countersign' && (
        <div className="signing-pending">
          <div className="small">The customer signed. This quote is accepted once it is countersigned.</div>
          <button className="btn small primary" onClick={() => setCountersigning(true)}>Countersign</button>
        </div>
      )}

      <Signature title="Customer signature" png={str(p.customer_signature)} who={str(p.responder_name)} at={str(p.customer_signed_at)} />
      {Object.keys(signedFields).length > 0 && (
        <dl className="signing-fields">
          {Object.entries(signedFields).map(([k, v]) => (
            <div key={k}><dt className="muted">{labels[k] ?? k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      )}
      <Signature title="Countersignature" png={str(p.countersigner_signature)} who={str(p.countersigner_name)} at={str(p.countersigned_at)} />

      <label className="small muted" htmlFor={`signing-fields-${record.id}`}>Fields the customer fills in before signing (JSON)</label>
      <textarea
        id={`signing-fields-${record.id}`}
        className="signing-json"
        rows={5}
        spellCheck={false}
        placeholder={EXAMPLE}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="small muted">Each field: key (a-z, 0-9, _), label, type (text, email or date), required (true or false). The link can prefill a field with ?key=value.</div>
      {error && <div className="error">{error}</div>}
      <div className="public-link-actions">
        <button className="btn small" onClick={save} disabled={saving || draft === saved}>Save fields</button>
      </div>

      {countersigning && <CountersignModal quoteId={record.id} onClose={() => setCountersigning(false)} onDone={onChanged} />}
    </div>
  );
}

function Signature({ title, png, who, at }: { title: string; png: string | null; who: string | null; at: string | null }) {
  if (!png) return null;
  return (
    <div className="signing-signature">
      <div className="small muted">{title}</div>
      <img src={png} alt={`${title}${who ? ` of ${who}` : ''}`} />
      <div className="small">{[who, when(at)].filter(Boolean).join(', ')}</div>
    </div>
  );
}

function CountersignModal({ quoteId, onClose, onDone }: { quoteId: string; onClose: () => void; onDone: (r: CrmRecord) => void }) {
  const { me, toast } = useApp();
  const [name, setName] = useState(me.user?.name ?? '');
  const [empty, setEmpty] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    const pad = attachSignaturePad(canvasRef.current!, setEmpty);
    padRef.current = pad;
    return () => pad.destroy();
  }, []);

  async function submit() {
    setError(null);
    if (!name.trim()) return setError('Enter your name.');
    if (!padRef.current || padRef.current.isEmpty()) return setError('Draw your signature.');
    setSaving(true);
    try {
      await api('POST', `/v1/objects/quotes/${quoteId}/countersign`, { name: name.trim(), signature_png: padRef.current.toDataURL() });
      onDone(await api<CrmRecord>('GET', `/v1/objects/quotes/${quoteId}`));
      toast('Countersigned');
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Countersign quote"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={saving}>Sign and accept</button>
        </>
      }
    >
      <div className="countersign">
        <label>
          <span className="small muted">Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </label>
        <div>
          <span className="small muted">Signature</span>
          <canvas ref={canvasRef} className="signature-canvas" aria-label="Signature: draw with your mouse or finger" />
          <div className="countersign-row">
            <span className="small muted">Draw your signature above.</span>
            <button className="btn small" onClick={() => padRef.current?.clear()} disabled={empty}>Clear</button>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}
