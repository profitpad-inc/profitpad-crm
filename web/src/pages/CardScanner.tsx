import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Camera, Check, IdCard, ImagePlus, Keyboard, Loader2, RotateCcw, X } from 'lucide-react';
import { api, ApiError, getSchema, type Property } from '../lib/api';
import { useApp } from '../lib/app-context';
import { uploadFile } from '../lib/files';
import { useIsMobile } from '../lib/use-mobile';
import { findCard, forOcr, insetQuad, loadPhoto, straighten, toBase64, toBlob, type Point, type Quad } from '../lib/card-image';
import { PropertyInput } from '../components/ui';
import { Select } from '../components/Select';
import { DatePicker } from '../components/DatePicker';
import { MobileHeader } from '../components/MobileNav';
import '../scanner.css';

// Business card scanner (/scan). Take or pick a photo, check the corners the
// page found, and the card is straightened, uploaded (kept on the contact)
// and read by the API (api/src/card-scan.ts: Tesseract on the server, or
// Claude when an admin added a key in Settings → Card scanner). The person
// checks what was read, picks an existing contact or company when one
// matches, and saves. Trade Show Mode also records the contact at an event
// with a follow-up priority, and stays on between scans (kept in this
// browser) so a stack of cards goes quickly.

interface Setup {
  reader: 'tesseract' | 'claude' | 'none';
  events: { id: string; name: string | null; start_at: string | null; trade_show: boolean }[];
  can_create_contacts: boolean;
  can_create_events: boolean;
}

interface CardFields {
  first_name: string; last_name: string; job_title: string; department: string; company: string; email: string; phone: string;
  other_phones: { label: string; number: string }[]; website: string; linkedin_url: string;
  address_street_1: string; address_street_2: string; address_city: string; address_province: string; address_postalcode: string; address_country: string;
  other_text: string; is_business_card: boolean;
}

interface ContactMatch { id: string; name: string | null; email: string | null; job_title: string | null; company: string | null; why: 'email' | 'name' }
interface CompanyMatch { id: string; name: string | null; domain: string | null; why: 'domain' | 'name' }
interface Matches { contacts: ContactMatch[]; companies: CompanyMatch[] }

type Priority = 'hot' | 'warm' | 'cold';
interface TradeShow { on: boolean; eventId: string; newEvent: string; priority: Priority }

type Step =
  | { kind: 'capture' }
  | { kind: 'crop'; photo: HTMLCanvasElement; url: string; quad: Quad; found: boolean }
  | { kind: 'reading'; cardUrl: string }
  | { kind: 'review'; cardUrl: string | null; fileId: string | null; scanId: string | null };

// the contact fields on the review form, in order
const FIELDS: { key: keyof CardFields; label: string; wide?: boolean }[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'job_title', label: 'Title', wide: true },
  { key: 'company', label: 'Company', wide: true },
  { key: 'email', label: 'Email', wide: true },
  { key: 'phone', label: 'Phone', wide: true },
  { key: 'address_street_1', label: 'Street', wide: true },
  { key: 'address_city', label: 'City' },
  { key: 'address_province', label: 'State/Province' },
  { key: 'address_postalcode', label: 'Zip/Postal code' },
  { key: 'address_country', label: 'Country' }
];
type Form = Record<string, string>;
const EMPTY_FORM: Form = Object.fromEntries(FIELDS.map((f) => [f.key, '']));

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: 'hot', label: 'Hot' },
  { value: 'warm', label: 'Warm' },
  { value: 'cold', label: 'Cold' }
];

const PREFS_KEY = 'pcrm.cardScanner';
function loadPrefs(): TradeShow {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { on: p.on === true, eventId: typeof p.eventId === 'string' ? p.eventId : '', newEvent: '', priority: ['hot', 'warm', 'cold'].includes(p.priority) ? p.priority : 'warm' };
  } catch {
    return { on: false, eventId: '', newEvent: '', priority: 'warm' };
  }
}
function savePrefs(t: TradeShow) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ on: t.on, eventId: t.eventId, priority: t.priority }));
  } catch {
    // private windows: the settings just are not remembered
  }
}

const NEW_EVENT = '__new';
const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export function CardScanner() {
  const { toast } = useApp();
  const mobile = useIsMobile();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [props, setProps] = useState<Map<string, Property>>(new Map());
  const [step, setStep] = useState<Step>({ kind: 'capture' });
  const [error, setError] = useState<string | null>(null);
  const [trade, setTrade] = useState<TradeShow>(loadPrefs);
  const [recent, setRecent] = useState<{ id: string; name: string; company: string; created: boolean }[]>([]);
  const [webcam, setWebcam] = useState(false);

  const loadSetup = useCallback(() => api<Setup>('GET', '/v1/card-scans/setup').then(setSetup).catch((err) => setError((err as Error).message)), []);
  useEffect(() => {
    loadSetup();
    getSchema('contacts').then((s) => setProps(new Map(s.properties.map((p) => [p.api_name, p])))).catch(() => undefined);
  }, [loadSetup]);
  useEffect(() => savePrefs(trade), [trade]);
  // an event that is gone (archived, or not visible) is dropped from the saved choice
  useEffect(() => {
    if (setup && trade.eventId && trade.eventId !== NEW_EVENT && !setup.events.some((e) => e.id === trade.eventId)) setTrade((t) => ({ ...t, eventId: '' }));
  }, [setup]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- review state ----
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [read, setRead] = useState<CardFields | null>(null);
  const [matches, setMatches] = useState<Matches>({ contacts: [], companies: [] });
  const [domain, setDomain] = useState<string | null>(null);
  const [contactChoice, setContactChoice] = useState<string>('new');
  const [companyChoice, setCompanyChoice] = useState<string>('new');
  const [priority, setPriority] = useState<Priority>(trade.priority);
  const [followUp, setFollowUp] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // emails are unique: a contact already using this one can only be updated
  const emailMatch = matches.contacts.find((c) => c.why === 'email' && (c.email ?? '').toLowerCase() === form.email.trim().toLowerCase());
  const emailTaken = !!form.email.trim() && !!emailMatch;
  useEffect(() => {
    if (emailMatch && contactChoice === 'new') setContactChoice(emailMatch.id);
  }, [emailMatch?.id, contactChoice]); // eslint-disable-line react-hooks/exhaustive-deps

  const startReview = (fields: CardFields | null, m: Matches, d: string | null, cardUrl: string | null, fileId: string | null, scanId: string | null = null) => {
    const f: Form = { ...EMPTY_FORM };
    if (fields) for (const { key } of FIELDS) f[key] = String(fields[key] ?? '');
    setForm(f);
    setRead(fields);
    setMatches(m);
    setDomain(d);
    // a contact with the same email is almost surely the same person; a same-name one may not be
    setContactChoice(m.contacts.find((c) => c.why === 'email')?.id ?? 'new');
    setCompanyChoice(m.companies[0]?.id ?? (f.company ? 'new' : 'none'));
    setPriority(trade.priority);
    setFollowUp('');
    setNote('');
    setStep({ kind: 'review', cardUrl, fileId, scanId });
  };

  // ---- capture ----
  const takeInput = useRef<HTMLInputElement>(null);
  const pickInput = useRef<HTMLInputElement>(null);

  // Claude reads photos as taken (scripts/card-bench), so it skips the
  // corners step and gets the whole photo; Tesseract needs the card cut out
  // and straightened, so the person checks the corners first.
  const readerRef = useRef(setup?.reader);
  readerRef.current = setup?.reader;
  const readRef = useRef<(s: Extract<Step, { kind: 'crop' }>) => Promise<void>>(async () => undefined);

  const openPhoto = useCallback(async (file: Blob) => {
    setError(null);
    try {
      const photo = await loadPhoto(file);
      const url = photo.toDataURL('image/jpeg', 0.85);
      if (readerRef.current === 'claude') {
        const { width: w, height: h } = photo;
        await readRef.current({ kind: 'crop', photo, url, quad: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], found: true });
        return;
      }
      const found = findCard(photo);
      setStep({ kind: 'crop', photo, url, quad: found ?? insetQuad(photo.width, photo.height), found: found !== null });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // paste a photo anywhere on the capture screen (desktop)
  useEffect(() => {
    if (step.kind !== 'capture') return;
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        openPhoto(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [step.kind, openPhoto]);

  function takePhoto() {
    // phones open their camera from the file input; desktops use the webcam
    if (isTouch() || !navigator.mediaDevices?.getUserMedia) takeInput.current?.click();
    else setWebcam(true);
  }

  // ---- read ----
  async function readCard(s: Extract<Step, { kind: 'crop' }>) {
    setError(null);
    const card = straighten(s.photo, s.quad);
    const cardUrl = card.toDataURL('image/jpeg', 0.85);
    setStep({ kind: 'reading', cardUrl });
    let fileId: string | null = null;
    try {
      const blob = await toBlob(card);
      fileId = await uploadFile(new File([blob], `business-card-${new Date().toISOString().slice(0, 10)}.jpg`, { type: 'image/jpeg' }), null);
      if (setup?.reader === 'none') {
        startReview(null, { contacts: [], companies: [] }, null, cardUrl, fileId);
        return;
      }
      const r = await api<{ scan_id: string; fields: CardFields; company_domain: string | null; matches: Matches }>('POST', '/v1/card-scans/read', {
        file_id: fileId,
        ...(setup?.reader === 'tesseract' ? { ocr_image: await toBase64(forOcr(card)) } : {})
      });
      if (!r.fields.is_business_card) setError("That doesn't look like a business card. Fill in what you can, or retake the photo.");
      startReview(r.fields, r.matches, r.company_domain, cardUrl, fileId, r.scan_id);
    } catch (err) {
      setError(`${(err as Error).message}${fileId ? ' Type the details in below.' : ''}`);
      if (fileId) startReview(null, { contacts: [], companies: [] }, null, cardUrl, fileId);
      else setStep(readerRef.current === 'claude' ? { kind: 'capture' } : s);
    }
  }
  readRef.current = readCard;

  // matches again after the details change
  const firstMatch = useRef(true);
  useEffect(() => {
    if (step.kind !== 'review') return;
    if (firstMatch.current) {
      firstMatch.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      api<{ company_domain: string | null; matches: Matches }>('POST', '/v1/card-scans/match', {
        email: form.email, first_name: form.first_name, last_name: form.last_name, company: form.company, website: read?.website ?? ''
      }).then((r) => {
        setMatches(r.matches);
        setDomain(r.company_domain);
        setContactChoice((cur) => (cur === 'new' || r.matches.contacts.some((c) => c.id === cur) ? cur : 'new'));
        setCompanyChoice((cur) => (['new', 'none'].includes(cur) || r.matches.companies.some((c) => c.id === cur) ? cur : r.matches.companies[0]?.id ?? 'new'));
      }).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(t);
  }, [form.email, form.first_name, form.last_name, form.company]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (step.kind !== 'review') firstMatch.current = true;
  }, [step.kind]);

  // ---- save ----
  async function save(s: Extract<Step, { kind: 'review' }>) {
    setSaving(true);
    setError(null);
    const eventOn = trade.on && (trade.eventId === NEW_EVENT ? trade.newEvent.trim() : trade.eventId);
    try {
      const r = await api<{ contact_id: string; created: boolean; event_id: string | null }>('POST', '/v1/card-scans/save', {
        scan_id: s.scanId,
        file_id: s.fileId,
        contact_id: contactChoice === 'new' ? null : contactChoice,
        contact: form,
        company: companyChoice === 'none' ? null : companyChoice === 'new' ? { name: form.company, domain } : { id: companyChoice },
        event: eventOn ? (trade.eventId === NEW_EVENT ? { name: trade.newEvent.trim() } : { id: trade.eventId }) : null,
        priority: eventOn ? priority : null,
        follow_up_date: eventOn ? followUp || null : null,
        note: note.trim() || null
      });
      const name = [form.first_name, form.last_name].filter(Boolean).join(' ') || form.email || 'Contact';
      setRecent((list) => [{ id: r.contact_id, name, company: form.company, created: r.created }, ...list].slice(0, 20));
      toast(r.created ? `${name} added` : `${name} updated`);
      if (trade.eventId === NEW_EVENT && r.event_id) {
        setTrade((t) => ({ ...t, eventId: r.event_id!, newEvent: '' }));
        loadSetup();
      }
      setStep({ kind: 'capture' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'contact_exists') {
        const id = (err.details as { contact_id?: string } | undefined)?.contact_id;
        if (id) {
          setMatches((m) => (m.contacts.some((c) => c.id === id) ? m : { ...m, contacts: [{ id, name: null, email: form.email, job_title: null, company: null, why: 'email' }, ...m.contacts] }));
          setContactChoice(id);
        }
      }
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ---- render ----
  if (setup && !setup.can_create_contacts) {
    return (
      <Shell mobile={mobile}>
        <div className="callout">You can't add contacts, so the card scanner is not available to you. Ask an admin for access.</div>
      </Shell>
    );
  }

  return (
    <Shell mobile={mobile}>
      {error && step.kind !== 'review' && <div className="error" role="alert">{error}</div>}

      {step.kind === 'capture' && (
        <>
          <TradeShowBar setup={setup} trade={trade} setTrade={setTrade} />
          <div
            className="scan-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
              if (file) openPhoto(file);
            }}
          >
            <IdCard size={40} strokeWidth={1.25} className="scan-drop-icon" aria-hidden />
            <p className="scan-drop-title">Scan a business card</p>
            <p className="muted">{mobile ? 'Lay the card flat on a darker surface, fill the frame, and avoid glare.' : 'Take a photo, choose one, drop it here, or paste it.'}</p>
            <div className="scan-drop-actions">
              <button className="btn primary big" onClick={takePhoto}><Camera size={18} /> Take photo</button>
              <button className="btn big" onClick={() => pickInput.current?.click()}><ImagePlus size={18} /> Choose photo</button>
            </div>
            <button className="btn ghost small" onClick={() => startReview(null, { contacts: [], companies: [] }, null, null, null)}>
              <Keyboard size={14} /> Type it in instead
            </button>
            {setup?.reader === 'none' && <p className="muted scan-note">Card reading is off on this server, so you'll type the details in after the photo.</p>}
            <input ref={takeInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openPhoto(f); }} />
            <input ref={pickInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openPhoto(f); }} />
          </div>
          {recent.length > 0 && (
            <section className="scan-recent">
              <h2>Scanned just now</h2>
              <ul>
                {recent.map((r, i) => (
                  <li key={`${r.id}-${i}`}>
                    <Link to={`/objects/contacts/${r.id}`}>{r.name}</Link>
                    {r.company && <span className="muted"> · {r.company}</span>}
                    <span className="scan-recent-tag">{r.created ? 'added' : 'updated'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {step.kind === 'crop' && (
        <div className="scan-crop">
          <p className="muted">{step.found ? 'Check the corners sit on the card, then read it.' : "Couldn't find the card's edges. Drag the corners onto the card."}</p>
          <CornerEditor url={step.url} width={step.photo.width} height={step.photo.height} quad={step.quad} onChange={(quad) => setStep({ ...step, quad })} />
          <div className="scan-actions">
            <button className="btn" onClick={() => setStep({ kind: 'capture' })}><RotateCcw size={16} /> Retake</button>
            <button className="btn primary" onClick={() => readCard(step)}><Check size={16} /> {setup?.reader === 'none' ? 'Use this' : 'Read card'}</button>
          </div>
        </div>
      )}

      {step.kind === 'reading' && (
        <div className="scan-reading">
          <img src={step.cardUrl} alt="The card, straightened" />
          <p><Loader2 size={16} className="spin" aria-hidden /> Reading the card…</p>
        </div>
      )}

      {step.kind === 'review' && (
        <div className="scan-review">
          <div className="scan-review-card">
            {step.cardUrl ? <img src={step.cardUrl} alt="The card" /> : <div className="scan-no-photo">No photo</div>}
            {read && <Extras read={read} />}
          </div>
          <div className="scan-review-form">
            <div className="scan-fields">
              {FIELDS.map(({ key, label, wide }) => {
                const prop = key === 'company' ? undefined : props.get(key);
                const value = form[key] ?? '';
                const onChange = (v: string) => setForm((f) => ({ ...f, [key]: v }));
                return (
                  <label key={key} className={`field${wide ? ' wide' : ''}`}>
                    <span>{label}</span>
                    {prop ? <PropertyInput key={`${key}-${step.fileId}`} property={prop} value={value} onChange={onChange} /> : <input value={value} onChange={(e) => onChange(e.target.value)} />}
                  </label>
                );
              })}
            </div>

            {matches.contacts.length > 0 && (
              <Choice
                title="Already in the CRM?"
                value={contactChoice}
                onChange={setContactChoice}
                options={[
                  ...matches.contacts.map((c) => ({
                    value: c.id,
                    label: <>Update <b>{c.name || c.email || 'this contact'}</b>{c.company ? ` · ${c.company}` : ''}</>,
                    hint: `${c.why === 'email' ? 'Same email' : 'Same name'}. Only empty fields are filled in; the card photo is added.`
                  })),
                  emailTaken
                    ? { value: 'new', label: 'Add as a new contact', hint: 'A contact with this email already exists, and emails are unique. Change the email to add a new contact.', disabled: true }
                    : { value: 'new', label: 'Add as a new contact' }
                ]}
              />
            )}

            {(form.company || matches.companies.length > 0) && (
              <Choice
                title="Company"
                value={companyChoice}
                onChange={setCompanyChoice}
                options={[
                  ...matches.companies.map((c) => ({ value: c.id, label: <>Link to <b>{c.name}</b>{c.domain ? ` · ${c.domain}` : ''}</>, hint: c.why === 'domain' ? 'Same web domain' : 'Same name' })),
                  ...(form.company ? [{ value: 'new', label: <>New company: <b>{form.company}</b>{domain ? ` · ${domain}` : ''}</> }] : []),
                  { value: 'none', label: "Don't link a company" }
                ]}
              />
            )}

            {trade.on && (trade.eventId === NEW_EVENT ? trade.newEvent.trim() : trade.eventId) ? (
              <section className="scan-followup">
                <h3>Follow-up · {trade.eventId === NEW_EVENT ? trade.newEvent : setup?.events.find((e) => e.id === trade.eventId)?.name}</h3>
                <Segmented value={priority} onChange={setPriority} options={PRIORITIES} label="Priority" />
                <label className="field">
                  <span>Follow up by</span>
                  <DatePicker value={followUp} onChange={setFollowUp} ariaLabel="Follow up by" />
                </label>
                <label className="field">
                  <span>Notes</span>
                  <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you talked about, what to send them" />
                </label>
              </section>
            ) : (
              <label className="field">
                <span>Note</span>
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Where you met, what to follow up on" />
              </label>
            )}

            {error && <div className="error" role="alert">{error}</div>}
            <div className="scan-actions sticky">
              <button className="btn" disabled={saving} onClick={() => { setError(null); setStep({ kind: 'capture' }); }}><X size={16} /> Discard</button>
              <button
                className="btn primary"
                disabled={saving || !(form.first_name.trim() || form.last_name.trim() || form.email.trim() || contactChoice !== 'new')}
                onClick={() => save(step)}
              >
                {saving ? 'Saving…' : contactChoice === 'new' ? 'Save contact' : 'Update contact'}
              </button>
            </div>
          </div>
        </div>
      )}

      {webcam && <Webcam onClose={() => setWebcam(false)} onPhoto={(blob) => { setWebcam(false); openPhoto(blob); }} />}
    </Shell>
  );
}

function Shell({ mobile, children }: { mobile: boolean; children: ReactNode }) {
  return (
    <>
      {mobile && <MobileHeader />}
      <div className="page scan-page">
        <header className="scan-head">
          <h1 className="page-title">Card scanner</h1>
        </header>
        {children}
      </div>
    </>
  );
}

function TradeShowBar({ setup, trade, setTrade }: { setup: Setup | null; trade: TradeShow; setTrade: (fn: (t: TradeShow) => TradeShow) => void }) {
  const events = setup?.events ?? [];
  return (
    <section className={`scan-trade${trade.on ? ' on' : ''}`}>
      <label className="scan-trade-switch">
        <input type="checkbox" checked={trade.on} onChange={(e) => setTrade((t) => ({ ...t, on: e.target.checked }))} />
        <span><b>Trade Show Mode</b><span className="muted"> · records each person at the event, with a follow-up priority</span></span>
      </label>
      {trade.on && (
        <div className="scan-trade-fields">
          <label className="field">
            <span>Event</span>
            <Select
              value={trade.eventId}
              onChange={(v) => setTrade((t) => ({ ...t, eventId: v }))}
              options={[
                { value: '', label: 'Pick an event' },
                ...events.map((e) => ({ value: e.id, label: `${e.name ?? 'Untitled event'}${e.start_at ? ` · ${new Date(e.start_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}` })),
                ...(setup?.can_create_events ? [{ value: NEW_EVENT, label: 'New event…' }] : [])
              ]}
            />
          </label>
          {trade.eventId === NEW_EVENT && (
            <label className="field">
              <span>Event name</span>
              <input value={trade.newEvent} maxLength={200} placeholder="e.g. AUSA Annual Meeting 2026" onChange={(e) => setTrade((t) => ({ ...t, newEvent: e.target.value }))} />
            </label>
          )}
          <Segmented value={trade.priority} onChange={(v) => setTrade((t) => ({ ...t, priority: v }))} options={PRIORITIES} label="Default priority" />
        </div>
      )}
    </section>
  );
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="scan-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`seg-${o.value}${value === o.value ? ' active' : ''}`} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Choice({ title, value, onChange, options }: { title: string; value: string; onChange: (v: string) => void; options: { value: string; label: ReactNode; hint?: string; disabled?: boolean }[] }) {
  return (
    <section className="scan-choice" role="radiogroup" aria-label={title}>
      <h3>{title}</h3>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={o.disabled} className={`scan-choice-row${value === o.value ? ' active' : ''}`} onClick={() => onChange(o.value)}>
          <span className="scan-choice-dot" aria-hidden />
          <span>
            <span className="scan-choice-label">{o.label}</span>
            {o.hint && <span className="scan-choice-hint">{o.hint}</span>}
          </span>
        </button>
      ))}
    </section>
  );
}

// What the card shows beyond the contact fields: shown so nothing is lost; copy what you need into the note.
function Extras({ read }: { read: CardFields }) {
  const items: [string, string][] = [
    ...read.other_phones.map((p): [string, string] => [p.label || 'Phone', p.number]),
    ...(read.website ? [['Website', read.website] as [string, string]] : []),
    ...(read.linkedin_url ? [['LinkedIn', read.linkedin_url] as [string, string]] : []),
    ...(read.department ? [['Department', read.department] as [string, string]] : []),
    ...(read.address_street_2 ? [['Street 2', read.address_street_2] as [string, string]] : []),
    ...(read.other_text ? [['Also on the card', read.other_text] as [string, string]] : [])
  ];
  if (items.length === 0) return null;
  return (
    <dl className="scan-extras">
      {items.map(([k, v], i) => (
        <div key={i}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

// The photo with the card's four corners as handles to drag.
function CornerEditor({ url, width, height, quad, onChange }: { url: string; width: number; height: number; quad: Quad; onChange: (q: Quad) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef<number | null>(null);
  const toPhoto = (e: ReactPointerEvent): Point => {
    const r = svg.current!.getBoundingClientRect();
    return {
      x: Math.min(width, Math.max(0, ((e.clientX - r.left) / r.width) * width)),
      y: Math.min(height, Math.max(0, ((e.clientY - r.top) / r.height) * height))
    };
  };
  const handle = Math.max(width, height) / 40;
  return (
    <div className="scan-corners">
      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={(e) => {
          if (dragging.current === null) return;
          const q = [...quad] as Quad;
          q[dragging.current] = toPhoto(e);
          onChange(q);
        }}
        onPointerUp={() => { dragging.current = null; }}
        onPointerCancel={() => { dragging.current = null; }}
      >
        <image href={url} width={width} height={height} />
        <path d={`M0 0H${width}V${height}H0Z M${quad.map((p) => `${p.x} ${p.y}`).join(' L')} Z`} fill="rgba(0,0,0,.45)" fillRule="evenodd" />
        <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#fff" strokeWidth={handle / 4} />
        {quad.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={handle}
            className="scan-corner"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              dragging.current = i;
            }}
          />
        ))}
      </svg>
    </div>
  );
}

// Desktop camera: a live view and a button to take the picture.
function Webcam({ onClose, onPhoto }: { onClose: () => void; onPhoto: (b: Blob) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setErr("Couldn't open a camera. Allow camera access in the browser, or choose a photo instead."));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);
  function snap() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    toBlob(c, 'image/jpeg', 0.92).then(onPhoto).catch(() => setErr('Could not take the picture.'));
  }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal wide scan-webcam" role="dialog" aria-label="Camera" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Take a photo of the card</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          {err ? <div className="error">{err}</div> : <video ref={video} autoPlay playsInline muted />}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!!err} onClick={snap}><Camera size={16} /> Take photo</button>
        </div>
      </div>
    </div>
  );
}
