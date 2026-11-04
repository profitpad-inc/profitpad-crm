import { useEffect, useMemo, useState } from 'react';
import { Coins, MoreHorizontal, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Menu, Modal } from '../components/ui';
import { EmptyState, SaveBar, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';

// Settings -> Currencies (admins): the base currency, how exchange rates are
// kept (typed by hand, or looked up on a schedule from a free provider), each
// currency's rate with manual pins, and the rate history that reports convert
// with (api/src/currency.ts, migration 0068a).
//
// Rates are shown and typed as "1 <base> = x <currency>", the way people
// quote them; the API stores the inverse (rate_to_base).

interface Currency {
  code: string;
  name: string;
  symbol: string | null;
  decimals: number;
  rate_to_base: string;
  is_base: boolean;
  record_status: 'active' | 'archived';
  rate_date: string | null;
  rate_source: 'manual' | 'provider' | null;
  rate_manual: boolean;
}

interface Provider { key: string; label: string; about: string; url: string; terms_url: string }

interface CurrencySettingsState {
  base_currency: string;
  mode: 'manual' | 'automatic';
  schedule: string;
  provider: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_status: 'ok' | 'partial' | 'failed' | null;
  last_error: string | null;
  next_fetch_at: string | null;
  schedules: string[];
  providers: Provider[];
}

interface FetchOutcome { status: 'ok' | 'partial' | 'failed' | 'skipped'; reason?: string; error?: string; updated?: string[] }

interface RateRow { rate_date: string; from_code: string; to_code: string; rate: string; source: 'manual' | 'provider'; provider: string | null; created_by: string | null }

const SCHEDULE_LABEL: Record<string, string> = {
  daily: 'Every day',
  every_2_days: 'Every 2 days',
  weekly: 'Every 7 days',
  every_14_days: 'Every 14 days',
  monthly: 'On the 1st of every month',
  quarterly: 'On the 1st of every quarter (Jan, Apr, Jul, Oct)'
};

const num = (v: number, digits = 6) => v.toLocaleString(undefined, { maximumSignificantDigits: digits });
// "1 base = x code" from the stored "1 code = rate_to_base base"
const perBase = (c: Currency) => 1 / Number(c.rate_to_base);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '--');
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }) : '--');

function fetchMessage(f: FetchOutcome | undefined): string | null {
  if (!f) return null;
  if (f.status === 'ok') return `Rates updated${f.updated?.length ? ` for ${f.updated.join(', ')}` : ''}.`;
  if (f.status === 'partial') return `Some rates updated. ${f.error ?? ''}`;
  if (f.status === 'failed') return `The rate lookup failed: ${f.error ?? 'unknown error'}`;
  return `No lookup: ${f.reason ?? 'skipped'}.`;
}

export function CurrencySettings() {
  const { toast } = useApp();
  const [settings, setSettings] = useState<CurrencySettingsState | null>(null);
  const [currencies, setCurrencies] = useState<Currency[] | null>(null);
  const [draft, setDraft] = useState<{ base_currency: string; mode: string; schedule: string; provider: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Currency | 'new' | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  async function load() {
    const [s, c] = await Promise.all([
      api<CurrencySettingsState>('GET', '/v1/currency-settings'),
      api<{ results: Currency[] }>('GET', '/v1/currencies')
    ]);
    setSettings(s);
    setCurrencies(c.results);
    setDraft({ base_currency: s.base_currency, mode: s.mode, schedule: s.schedule, provider: s.provider });
    setHistoryKey((k) => k + 1);
  }

  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
  }, []);

  async function run(fn: () => Promise<{ fetch?: FetchOutcome } | void>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      await load();
      const f = out && 'fetch' in out ? out.fetch : undefined;
      toast(fetchMessage(f) ?? done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const description = 'Pick the currency totals are reported in and how exchange rates are kept. Deals, quotes and invoices keep their own currency; reports and views convert with these rates.';
  if (!settings || !currencies || !draft) {
    return <SettingsPage className="currency-settings" title="Currencies" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={4} />}</SettingsPage>;
  }

  const base = currencies.find((c) => c.is_base);
  const active = currencies.filter((c) => c.record_status === 'active');
  const shown = showArchived ? currencies : active;
  const provider = settings.providers.find((p) => p.key === draft.provider);
  const dirty = draft.base_currency !== settings.base_currency || draft.mode !== settings.mode
    || draft.schedule !== settings.schedule || draft.provider !== settings.provider;
  const automatic = settings.mode === 'automatic';
  const noRate = active.filter((c) => !c.is_base && !c.rate_date);

  return (
    <SettingsPage className="currency-settings" title="Currencies" description={description}>
      <SettingsSection title="Base currency and rates">
        <SettingRow
          label="Base currency"
          htmlFor="base-currency"
          hint={draft.base_currency !== settings.base_currency
            ? `Every rate is converted to ${draft.base_currency} through today's rates. Reports for earlier days keep using the rates of those days.`
            : 'Totals across currencies are converted to this one. A currency needs a rate before it can be the base.'}
        >
          <Select
            id="base-currency"
            value={draft.base_currency}
            onChange={(v) => setDraft({ ...draft, base_currency: v })}
            options={active.map((c) => ({ value: c.code, label: `${c.code}, ${c.name}`, disabled: !c.is_base && !c.rate_date }))}
          />
        </SettingRow>
        <SettingRow
          label="Keep rates up to date"
          hint={draft.mode === 'manual'
            ? 'You type each rate below. Nothing is looked up.'
            : 'Checked every hour; days are counted in UTC from the last successful lookup. You can still pin a rate by hand for any currency; lookups then leave that currency alone.'}
        >
          <div className="rate-options">
            <label className="field" htmlFor="rate-mode">
              <span>Rates</span>
              <Select
                id="rate-mode"
                value={draft.mode}
                onChange={(v) => setDraft({ ...draft, mode: v })}
                options={[
                  { value: 'manual', label: 'Manual: type each rate' },
                  { value: 'automatic', label: 'Automatic lookup' }
                ]}
              />
            </label>
            {draft.mode === 'automatic' && (
              <>
                <label className="field" htmlFor="rate-schedule">
                  <span>How often</span>
                  <Select
                    id="rate-schedule"
                    value={draft.schedule}
                    onChange={(v) => setDraft({ ...draft, schedule: v })}
                    options={settings.schedules.map((s) => ({ value: s, label: SCHEDULE_LABEL[s] ?? s }))}
                  />
                </label>
                <label className="field" htmlFor="rate-provider">
                  <span>Rates from</span>
                  <Select
                    id="rate-provider"
                    value={draft.provider}
                    onChange={(v) => setDraft({ ...draft, provider: v })}
                    options={settings.providers.map((p) => ({ value: p.key, label: p.label }))}
                  />
                </label>
              </>
            )}
          </div>
          {draft.mode === 'automatic' && provider && (
            <p className="muted small">{provider.about} <a href={provider.url} target="_blank" rel="noreferrer">About {provider.label}</a></p>
          )}
        </SettingRow>
        {automatic && (
          <SettingRow label="Last lookup">
            <div className="stack-sm">
              <div>
                {settings.last_status === 'ok' && <StatusPill tone="on">Updated</StatusPill>}
                {settings.last_status === 'partial' && <StatusPill tone="warn">Partly updated</StatusPill>}
                {settings.last_status === 'failed' && <StatusPill tone="failed">Failed</StatusPill>}
                {!settings.last_status && <StatusPill tone="off">Not yet</StatusPill>}
                {' '}<span className="muted small">{when(settings.last_attempt_at)}{settings.next_fetch_at && ` · next ${when(settings.next_fetch_at)}`}</span>
              </div>
              {settings.last_error && <div className="small error">{settings.last_error}</div>}
              <div>
                <button
                  className="btn"
                  disabled={busy || dirty}
                  title={dirty ? 'Save your changes first' : undefined}
                  onClick={() => run(() => api<{ fetch: FetchOutcome }>('POST', '/v1/currency-rates/fetch', {}), 'Rates looked up.')}
                >
                  {busy ? 'Looking up…' : 'Look up rates now'}
                </button>
              </div>
            </div>
          </SettingRow>
        )}
      </SettingsSection>

      <SettingsSection
        title="Currencies"
        description={base ? `Rates are shown as 1 ${base.code} = x of each currency.` : undefined}
        actions={
          <>
            <label className="small muted"><input type="checkbox" role="switch" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
            <button className="btn primary" onClick={() => setEditing('new')}><Plus size={14} /> Add currency</button>
          </>
        }
      >
        {noRate.length > 0 && (
          <div className="callout warn">
            {noRate.map((c) => c.code).join(', ')} {noRate.length === 1 ? 'has' : 'have'} no rate yet, so amounts in {noRate.length === 1 ? 'it' : 'them'} are left out of converted totals.
            {automatic ? ' Look up rates now, or set a rate by hand.' : ' Set a rate for each.'}
          </div>
        )}
        {shown.length === 0 ? (
          <EmptyState icon={<Coins size={18} />} title="No currencies">Add the currencies your deals, quotes and invoices use.</EmptyState>
        ) : (
          <div className="access-table">
            <table className="grid">
              <thead>
                <tr><th>Currency</th><th className="num">{base ? `1 ${base.code} =` : 'Rate'}</th><th>As of</th><th>Rate from</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.code} className={c.record_status === 'archived' ? 'muted' : undefined}>
                    <td className="primary-cell"><code>{c.code}</code> {c.name}</td>
                    <td className="num">{c.is_base ? '1' : c.rate_date ? `${num(perBase(c))} ${c.code}` : '--'}</td>
                    <td>{c.is_base ? '--' : day(c.rate_date)}</td>
                    <td>
                      {c.is_base ? <StatusPill tone="info">Base</StatusPill>
                        : c.record_status === 'archived' ? <StatusPill tone="off">Archived</StatusPill>
                        : !c.rate_date ? <StatusPill tone="warn">No rate</StatusPill>
                        : c.rate_manual ? <StatusPill tone="pending">Pinned by hand</StatusPill>
                        : c.rate_source === 'provider' ? 'Lookup'
                        : 'Typed by hand'}
                    </td>
                    <td className="row-actions">
                      {!c.is_base && (
                        <Menu align="right" trigger={(open) => <button className="icon-btn" onClick={open} aria-label={`Actions for ${c.code}`}><MoreHorizontal size={16} /></button>}>
                          {(close) => (
                            <>
                              {c.record_status === 'active' && <button onClick={() => { close(); setEditing(c); }}>{automatic ? 'Pin a rate' : 'Set rate'}</button>}
                              {automatic && c.rate_manual && (
                                <button onClick={() => { close(); run(() => api('PATCH', `/v1/currencies/${c.code}`, { rate_manual: false }), `${c.code} follows the lookup again.`); }}>
                                  Use looked up rate
                                </button>
                              )}
                              {c.record_status === 'active'
                                ? <button onClick={() => { close(); run(() => api('PATCH', `/v1/currencies/${c.code}`, { record_status: 'archived' }), `${c.code} archived.`); }}>Archive</button>
                                : <button onClick={() => { close(); run(() => api('PATCH', `/v1/currencies/${c.code}`, { record_status: 'active' }), `${c.code} restored.`); }}>Restore</button>}
                            </>
                          )}
                        </Menu>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Archiving a currency hides it here and from conversions; records keep their amounts. Archive it in the currency dropdowns too (Settings, Properties) to stop people picking it.
        </p>
      </SettingsSection>

      <SettingsSection title="Rate history" description="The rate used each day. Reports can convert an amount at the rate of its own day (for example a deal's close date).">
        <RateHistory key={historyKey} currencies={active} />
      </SettingsSection>

      <SaveBar dirty={dirty} error={error}>
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft({ base_currency: settings.base_currency, mode: settings.mode, schedule: settings.schedule, provider: settings.provider })}>Discard</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={() => run(() => api('PUT', '/v1/currency-settings', draft), 'Currency settings saved.')}>Save</button>
      </SaveBar>

      {editing && base && (
        <CurrencyEditor
          currency={editing === 'new' ? null : editing}
          base={base}
          automatic={automatic}
          onClose={() => setEditing(null)}
          onSaved={async (message, f) => { setEditing(null); await load(); toast(fetchMessage(f) ? `${message} ${fetchMessage(f)}` : message); }}
        />
      )}
    </SettingsPage>
  );
}

function RateHistory({ currencies }: { currencies: Currency[] }) {
  const [code, setCode] = useState('');
  const [rows, setRows] = useState<RateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    api<{ results: RateRow[] }>('GET', `/v1/currency-rates?limit=100${code ? `&code=${code}` : ''}`)
      .then((r) => setRows(r.results))
      .catch((err) => setError((err as Error).message));
  }, [code]);
  if (error) return <div className="error">{error}</div>;
  return (
    <>
      <div className="settings-toolbar">
        <Select
          value={code}
          onChange={setCode}
          aria-label="Currency"
          options={[{ value: '', label: 'All currencies' }, ...currencies.filter((c) => !c.is_base).map((c) => ({ value: c.code, label: c.code }))]}
        />
      </div>
      {!rows ? <TableSkeleton rows={3} /> : rows.length === 0 ? (
        <EmptyState compact title="No rates yet">Rates appear here once they are typed or looked up.</EmptyState>
      ) : (
        <div className="access-table">
          <table className="grid">
            <thead><tr><th>Day</th><th>Currency</th><th className="num">1 base =</th><th>From</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.rate_date}-${r.from_code}-${r.to_code}`}>
                  <td>{day(r.rate_date)}</td>
                  <td><code>{r.from_code}</code></td>
                  <td className="num">1 {r.to_code} = {num(1 / Number(r.rate))} {r.from_code}</td>
                  <td>{r.source === 'manual' ? 'Typed by hand' : `Lookup (${r.provider})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// The name and usual decimals of an ISO code, from the browser.
function isoDetails(code: string): { name: string; decimals: number } | null {
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'currency' }).of(code);
    const decimals = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
    return name && name !== code ? { name, decimals } : null;
  } catch {
    return null;
  }
}

function CurrencyEditor({ currency, base, automatic, onClose, onSaved }: {
  currency: Currency | null; base: Currency; automatic: boolean; onClose: () => void; onSaved: (message: string, fetch?: FetchOutcome) => Promise<void>;
}) {
  const isNew = currency === null;
  const [code, setCode] = useState(currency?.code ?? '');
  const [name, setName] = useState(currency?.name ?? '');
  const [autoName, setAutoName] = useState(isNew);
  const [rate, setRate] = useState(currency?.rate_date ? String(Number(perBase(currency).toPrecision(8))) : '');
  const [toDropdowns, setToDropdowns] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const details = useMemo(() => isoDetails(code), [code]);
  const shownCode = code || 'XXX';
  const rateNum = Number(rate.replace(/,/g, ''));
  const rateOk = rate.trim() !== '' && Number.isFinite(rateNum) && rateNum > 0;
  const needRate = !isNew || !automatic;

  function onCode(v: string) {
    const c = v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    setCode(c);
    if (autoName) setName(isoDetails(c)?.name ?? '');
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const out = await api<Currency & { added_to: string[]; fetch?: FetchOutcome }>('POST', '/v1/currencies', {
          code,
          name: name.trim(),
          decimals: details?.decimals ?? 2,
          rate_to_base: rateOk ? String(1 / rateNum) : undefined,
          add_to_dropdowns: toDropdowns
        });
        await onSaved(`${out.code} added${out.added_to.length ? ` and offered in ${out.added_to.length} currency dropdowns` : ''}.`, out.fetch);
      } else {
        await api('PATCH', `/v1/currencies/${currency.code}`, { rate_to_base: String(1 / rateNum) });
        await onSaved(automatic ? `${currency.code} pinned at ${num(rateNum)} per ${base.code}.` : `${currency.code} rate saved.`);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const canSave = !busy && (isNew ? /^[A-Z]{3}$/.test(code) && !!name.trim() && (rate.trim() === '' ? !needRate : rateOk) : rateOk);

  return (
    <Modal
      locked={busy}
      title={isNew ? 'Add currency' : `${automatic ? 'Pin' : 'Set'} the ${currency.code} rate`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!canSave}>{isNew ? 'Add' : 'Save rate'}</button>
        </>
      }
    >
      <div className="prop-editor">
        {isNew && (
          <div className="field-row">
            <label className="field">
              <span>Code</span>
              <input value={code} placeholder="EUR" maxLength={3} onChange={(e) => onCode(e.target.value)} autoFocus />
            </label>
            <label className="field grow">
              <span>Name</span>
              <input value={name} maxLength={63} placeholder="Euro" onChange={(e) => { setAutoName(false); setName(e.target.value); }} />
            </label>
          </div>
        )}
        <label className="field">
          <span>1 {base.code} =</span>
          <div className="key-row">
            <input inputMode="decimal" value={rate} placeholder={isNew && automatic ? 'Looked up when added' : '0.00'} onChange={(e) => setRate(e.target.value)} autoFocus={!isNew} />
            <span className="muted">{shownCode}</span>
          </div>
        </label>
        {rateOk && <p className="muted small">So 1 {shownCode} = {num(1 / rateNum)} {base.code}.</p>}
        {automatic && (
          <p className="muted small">
            {isNew
              ? 'Leave the rate blank to look it up now. A rate typed here is pinned: lookups leave it alone until you choose "Use looked up rate".'
              : `Lookups leave ${currency.code} at this rate until you choose "Use looked up rate".`}
          </p>
        )}
        {isNew && (
          <div className="checks">
            <label><input type="checkbox" role="switch" checked={toDropdowns} onChange={(e) => setToDropdowns(e.target.checked)} /> Offer it in the currency dropdowns of deals, quotes, invoices and other money records</label>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  );
}
