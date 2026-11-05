import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Clock, FileText, Paperclip, Send, X } from 'lucide-react';
import { api, type CrmRecord } from '../lib/api';
import { useApp } from '../lib/app-context';
import { formatBytes, uploadFile } from '../lib/files';
import { loadSenders, type SendResult, type Sender } from '../lib/mailbox';
import { RichTextEditor, type RichTextHandle } from './RichTextEditor';
import { DatePicker } from './DatePicker';
import { Select } from './Select';
import { confirmDialog } from './confirm';
import './email-composer.css';

// Writing and sending an email from a record page, from the user's own
// mailbox or a shared one (Settings → Mailboxes). The email is saved on this
// record and on the contacts it goes to; replies are not brought back.

export interface Recipient { email: string; name: string | null }
export interface Attachable { id: string; name: string | null; size_bytes: number | null }

interface Attached { id: string; name: string; size: number | null }

const MAX_BYTES = 25 * 1024 ** 2;
const EMAIL_RE = /^[^@\s<>(),;:"[\]\\]+@[^@\s<>(),;:"[\]\\]+\.[^@\s<>(),;:"[\]\\]+$/;

// "Ana <ana@x.com>", "ana@x.com, bob@y.com" → addresses
function parseAddresses(text: string): string[] {
  return text.split(/[,;\n]+/).map((s) => {
    const m = /<([^>]+)>/.exec(s);
    return (m ? m[1] : s).trim().toLowerCase();
  }).filter(Boolean);
}

function AddressInput({ label, value, onChange, suggestions, autoFocus, single, taken = [] }: {
  label: string; value: string[]; onChange: (v: string[]) => void; suggestions: Recipient[]; autoFocus?: boolean; single?: boolean;
  // addresses already in another field, not suggested again
  taken?: string[];
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const q = text.trim().toLowerCase();
  const shown = focused && !(single && value.length)
    ? suggestions.filter((s) => !value.includes(s.email) && !taken.includes(s.email) && (!q || s.email.includes(q) || (s.name ?? '').toLowerCase().includes(q))).slice(0, 6)
    : [];

  const add = (raw: string) => {
    const next = [...value];
    for (const a of parseAddresses(raw)) if (!next.includes(a)) next.push(a);
    onChange(single ? next.slice(-1) : next);
    setText('');
    setActive(0);
  };

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && shown.length) {
      e.preventDefault();
      e.stopPropagation();
      setFocused(false);
      return;
    }
    if (shown.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
      return;
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && text.trim())) {
      if (!text.trim() && e.key === 'Enter' && shown[active]) {
        e.preventDefault();
        add(shown[active].email);
        return;
      }
      if (text.trim()) {
        e.preventDefault();
        add(shown.length && !text.includes('@') ? shown[active].email : text);
      }
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
  }

  return (
    <div className="ec-row" onClick={() => input.current?.focus()}>
      <span className="ec-label">{label}</span>
      <div className="ec-chips">
        {value.map((a) => (
          <span key={a} className={`ec-chip${EMAIL_RE.test(a) ? '' : ' bad'}`} title={EMAIL_RE.test(a) ? a : `${a} is not an email address`}>
            {suggestions.find((s) => s.email === a)?.name ?? a}
            <button type="button" aria-label={`Remove ${a}`} onClick={(e) => { e.stopPropagation(); onChange(value.filter((x) => x !== a)); }}><X size={12} /></button>
          </span>
        ))}
        {!(single && value.length) && (
          <input ref={input} autoFocus={autoFocus} value={text} aria-label={label} type="text" autoComplete="off"
            onChange={(e) => { setText(e.target.value); setActive(0); setFocused(true); }}
            onKeyDown={onKey}
            onFocus={() => setFocused(true)}
            // leaving the box keeps a typed address; a half-typed name stays as text
            onBlur={() => { setFocused(false); if (text.includes('@')) add(text); }}
            onPaste={(e) => {
              const t = e.clipboardData.getData('text');
              if (/[,;\n]/.test(t)) { e.preventDefault(); add(t); }
            }} />
        )}
      </div>
      {shown.length > 0 && (
        <div className="ec-suggest" role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {shown.map((s, i) => (
            <div key={s.email} role="option" aria-selected={i === active} className={`ec-suggest-item${i === active ? ' active' : ''}`} onClick={() => add(s.email)}>
              {s.name && <span className="ec-suggest-name">{s.name}</span>}
              <span className="ec-suggest-email">{s.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmailComposer({ page, pageLabel, recipients, prefill, attachable, focusKey, hidden, onDirty, onSent, onCancel }: {
  page: { object: string; id: string };
  pageLabel: string;
  // people to suggest in To, Cc and Bcc (the record's contacts)
  recipients: Recipient[];
  // starts in To (a contact page's own address)
  prefill: string[];
  // files linked to the record, offered as attachments
  attachable: Attachable[];
  focusKey: number;
  hidden?: boolean;
  onDirty?: (dirty: boolean) => void;
  onSent: (result: SendResult) => Promise<void>;
  onCancel: () => void;
}) {
  const { me, toast } = useApp();
  const [senders, setSenders] = useState<Sender[] | null>(null);
  const [senderKey, setSenderKey] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState<string[]>(prefill);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<string[]>([]);
  const [show, setShow] = useState({ cc: false, bcc: false, replyTo: false });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState({ html: '', empty: true });
  const [files, setFiles] = useState<Attached[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [signature, setSignature] = useState(!!me.user?.email_signature);
  const [later, setLater] = useState<string | null>(null);
  const [templates, setTemplates] = useState<CrmRecord[] | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<RichTextHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadSenders()
      .then((list) => {
        if (cancelled) return;
        setSenders(list);
        const first = list[0];
        if (first) {
          setSenderKey(first.key);
          setFrom(first.aliases[0]?.address ?? first.mailbox);
        }
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    api<{ results: CrmRecord[] }>('GET', '/v1/objects/email_templates?limit=200&properties=name,subject')
      .then((r) => !cancelled && setTemplates(r.results))
      .catch(() => !cancelled && setTemplates([]));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (prefill.length) box.current?.querySelector<HTMLInputElement>('.ec-subject')?.focus({ preventScroll: true });
    else box.current?.querySelector<HTMLInputElement>('.ec-row input')?.focus({ preventScroll: true });
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!subject.trim() || !body.empty || files.length > 0 || cc.length > 0 || bcc.length > 0;
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);

  const sender = senders?.find((s) => s.key === senderKey) ?? null;
  const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
  const badAddress = [...to, ...cc, ...bcc, ...replyTo].find((a) => !EMAIL_RE.test(a));
  const ready = !!sender && !!from && to.length > 0 && !!subject.trim() && !body.empty && !badAddress && total <= MAX_BYTES && !uploading;
  const laterDate = later ? new Date(later) : null;
  const laterOk = !laterDate || (!Number.isNaN(laterDate.getTime()) && laterDate.getTime() > Date.now() + 60_000);

  const fromOptions = useMemo(() => (senders ?? []).flatMap((s) => s.aliases.map((a) => ({
    value: `${s.key}|${a.address}`,
    label: `${s.kind === 'shared' ? (s.display_name ?? s.mailbox) : 'You'}: ${a.address}`
  }))), [senders]);

  async function chooseTemplate(id: string) {
    if (!id) return;
    if ((subject.trim() || !body.empty) && !(await confirmDialog('The template replaces the subject and the text you wrote.', { title: 'Use this template?', confirmLabel: 'Replace' }))) return;
    try {
      const t = await api<{ subject: string; body_html: string }>('POST', `/v1/mailboxes/templates/${id}/render`, { object: page.object, record_id: page.id });
      setSubject(t.subject);
      editor.current?.setHTML(t.body_html);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    for (const f of [...list]) {
      if (total + f.size > MAX_BYTES) {
        setError(`${f.name} would take the attachments over 25 MB.`);
        break;
      }
      setUploading(f.name);
      try {
        const id = await uploadFile(f, null);
        setFiles((x) => [...x, { id, name: f.name, size: f.size }]);
      } catch (err) {
        setError((err as Error).message);
        break;
      }
    }
    setUploading(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function send() {
    if (!ready || sending || !laterOk) return;
    setSending(true);
    setError(null);
    try {
      const result = await api<SendResult>('POST', '/v1/mailboxes/send', {
        record: page,
        sender: senderKey,
        from_address: from,
        to, cc, bcc,
        reply_to: replyTo[0] ?? null,
        subject: subject.trim(),
        body_html: body.html,
        file_ids: files.map((f) => f.id),
        add_signature: signature,
        scheduled_at: laterDate ? laterDate.toISOString() : null
      });
      // a failed email is saved on the record with its own Send again, so the
      // box closes either way (sending this draft again would save a second one)
      toast(result.status === 'failed'
        ? `Not sent: ${result.error ?? 'the provider refused it'}. It is saved on this ${pageLabel.toLowerCase()}: use Send again there.`
        : result.status === 'scheduled' ? `Scheduled for ${new Date(result.scheduled_at!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Email sent');
      await onSent(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function cancel() {
    if (dirty && !(await confirmDialog('What you wrote is not sent or saved.', { title: 'Discard this email?', confirmLabel: 'Discard', danger: true }))) return;
    onCancel();
  }

  const offered = attachable.filter((a) => !files.some((f) => f.id === a.id));

  return (
    <div className="composer email-composer" ref={box} hidden={hidden}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}>
      <div className="ec-row">
        <span className="ec-label">From</span>
        {senders === null ? <span className="muted small">Loading your mailboxes…</span>
          : senders.length === 0 ? <span className="muted small">No mailbox is set up for you. An admin can set one up in Settings → Mailboxes.</span>
          : (
            <Select className="ec-from" aria-label="From" value={`${senderKey}|${from}`} options={fromOptions}
              onChange={(v) => { const i = v.indexOf('|'); setSenderKey(v.slice(0, i)); setFrom(v.slice(i + 1)); }} />
          )}
        {sender?.error && <span className="ec-note" title={sender.error}>Aliases unavailable</span>}
        <span className="ec-toggles">
          {!show.cc && <button type="button" className="ec-link" onClick={() => setShow({ ...show, cc: true })}>Cc</button>}
          {!show.bcc && <button type="button" className="ec-link" onClick={() => setShow({ ...show, bcc: true })}>Bcc</button>}
          {!show.replyTo && <button type="button" className="ec-link" onClick={() => setShow({ ...show, replyTo: true })}>Reply-to</button>}
        </span>
      </div>
      <AddressInput label="To" value={to} onChange={setTo} suggestions={recipients} taken={[...cc, ...bcc]} />
      {show.cc && <AddressInput label="Cc" value={cc} onChange={setCc} suggestions={recipients} taken={[...to, ...bcc]} autoFocus />}
      {show.bcc && <AddressInput label="Bcc" value={bcc} onChange={setBcc} suggestions={recipients} taken={[...to, ...cc]} autoFocus />}
      {show.replyTo && <AddressInput label="Reply-to" value={replyTo} onChange={setReplyTo} suggestions={[]} autoFocus single />}
      <div className="ec-row">
        <span className="ec-label">Subject</span>
        <input className="ec-subject" aria-label="Subject" value={subject} maxLength={900} onChange={(e) => setSubject(e.target.value)} />
        <Select className="ec-template" aria-label="Use a template" value="" face={<><FileText size={14} /> Template</>}
          options={[{ value: '', label: templates === null ? 'Loading…' : templates.length ? 'Choose a template' : 'No email templates' },
            ...(templates ?? []).map((t) => ({ value: t.id, label: String(t.properties.name ?? t.properties.subject ?? 'Untitled') }))]}
          onChange={chooseTemplate} />
      </div>
      <div className="ec-body">
        <RichTextEditor ref={editor} value="" onChange={(html, empty) => setBody({ html, empty })} record={page} ariaLabel="Email body"
          placeholder="Write your email… (# for a snippet)" />
      </div>
      {signature && me.user?.email_signature && (
        <div className="ec-signature" aria-label="Your signature, added under the email">
          <span className="muted small">Signature</span>
          <SignaturePreview html={me.user.email_signature} />
        </div>
      )}
      {(files.length > 0 || uploading) && (
        <div className="ec-files">
          {files.map((f) => (
            <span key={f.id} className="ec-chip file">
              <Paperclip size={12} /> {f.name} {f.size !== null && <span className="muted">{formatBytes(f.size)}</span>}
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.id !== f.id))}><X size={12} /></button>
            </span>
          ))}
          {uploading && <span className="ec-chip file muted">Uploading {uploading}…</span>}
          {total > MAX_BYTES && <span className="error small">Attachments are over 25 MB.</span>}
        </div>
      )}
      {later !== null && (
        <div className="ec-row ec-later">
          <span className="ec-label">Send at</span>
          <DatePicker withTime noPastDays value={later} onChange={setLater} ariaLabel="Send at" />
          {!laterOk && later && <span className="error small">Pick a time at least a minute from now.</span>}
          <button type="button" className="ec-link" onClick={() => setLater(null)}>Send now instead</button>
        </div>
      )}
      {error && <div className="error composer-note" role="alert">{error}</div>}
      {badAddress && <div className="error composer-note">{badAddress} is not an email address.</div>}
      <div className="composer-foot">
        <span className="ec-foot-left">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <button type="button" className="btn small" disabled={!!uploading} onClick={() => fileInput.current?.click()}><Paperclip size={14} /> Attach</button>
          {offered.length > 0 && (
            <Select className="ec-attach-crm" aria-label="Attach a file from this record" value="" face={<>Files on this {pageLabel.toLowerCase()}</>}
              options={[{ value: '', label: 'Choose a file' }, ...offered.map((a) => ({ value: a.id, label: `${a.name ?? 'File'}${a.size_bytes !== null ? ` (${formatBytes(a.size_bytes)})` : ''}` }))]}
              onChange={(id) => {
                const a = offered.find((x) => x.id === id);
                if (a) setFiles([...files, { id: a.id, name: a.name ?? 'File', size: a.size_bytes }]);
              }} />
          )}
          {me.user?.email_signature && (
            <label className="ec-switch small"><input type="checkbox" role="switch" checked={signature} onChange={(e) => setSignature(e.target.checked)} /> Signature</label>
          )}
        </span>
        <span className="composer-buttons">
          <button className="btn small" onClick={cancel} disabled={sending}>Cancel</button>
          {later === null && (
            <button className="btn small" disabled={sending} title="Send later" onClick={() => {
              const d = new Date(Date.now() + 60 * 60_000);
              d.setMinutes(0, 0, 0);
              const pad = (n: number) => String(n).padStart(2, '0');
              setLater(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
            }}><Clock size={14} /> Send later</button>
          )}
          <button className="btn primary small" onClick={send} disabled={sending || !ready || !laterOk}>
            <Send size={14} /> {sending ? (later ? 'Scheduling…' : 'Sending…') : later ? 'Schedule' : 'Send'}
          </button>
        </span>
      </div>
    </div>
  );
}

// The signature as it will look, in a sandboxed frame (it is HTML from the
// user's own settings, cleaned by the API, still kept away from this page).
function SignaturePreview({ html }: { html: string }) {
  const [height, setHeight] = useState(40);
  const frame = useRef<HTMLIFrameElement>(null);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}body{font:13px/1.5 Inter,system-ui,sans-serif;color:#1f2328;background:transparent}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  return (
    <iframe ref={frame} className="ec-signature-frame" title="Signature" sandbox="allow-same-origin" srcDoc={doc} style={{ height }}
      onLoad={() => { const d = frame.current?.contentDocument; if (d) setHeight(Math.min(240, Math.max(24, d.documentElement.scrollHeight))); }} />
  );
}
