import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { SaveBar, SettingRow, SettingsPage, SettingsSection, TableSkeleton } from '../components/settings';
import { Select, type SelectOption } from '../components/Select';

// Settings > Calculations (Properties permission): when every calculation is
// recomputed each night, and how much calculation work is waiting
// (api/src/calc-settings.ts, migration 0168).

interface CalcSettings {
  nightly_hour: number;
  nightly_time_zone: string;
  updated_by: string | null;
  updated_at: string | null;
  last_run_at: string | null;
  last_run_count: number | null;
  next_run_at: string | null;
  waiting_now: number;
  waiting_later: number;
  chains_waiting: number;
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = (): string[] => (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [browserZone()];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '--');
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const count = (n: number) => n.toLocaleString();

export function CalculationSettings() {
  const { toast } = useApp();
  const [settings, setSettings] = useState<CalcSettings | null>(null);
  const [draft, setDraft] = useState<{ nightly_hour: number; nightly_time_zone: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function show(s: CalcSettings) {
    setSettings(s);
    setDraft({ nightly_hour: s.nightly_hour, nightly_time_zone: s.nightly_time_zone });
  }

  useEffect(() => {
    api<CalcSettings>('GET', '/v1/calculation-settings').then(show).catch((err) => setError((err as Error).message));
  }, []);

  const zoneOptions = useMemo<SelectOption[]>(() => {
    const list = zones();
    const extra = [settings?.nightly_time_zone, 'UTC'].filter((z): z is string => !!z && !list.includes(z));
    return [...extra, ...list].map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
  }, [settings?.nightly_time_zone]);
  const hourOptions = useMemo<SelectOption[]>(() => Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) })), []);

  const description = 'Calculation properties update as soon as what they read changes. Every calculation is also recomputed once a night, to catch anything further away.';
  if (!settings || !draft) {
    return <SettingsPage className="calc-settings" title="Calculations" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={3} />}</SettingsPage>;
  }

  const dirty = draft.nightly_hour !== settings.nightly_hour || draft.nightly_time_zone !== settings.nightly_time_zone;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      show(await api<CalcSettings>('PUT', '/v1/calculation-settings', draft));
      toast('Calculation settings saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage className="calc-settings" title="Calculations" description={description}>
      <SettingsSection title="Nightly recompute">
        <SettingRow
          label="Time"
          htmlFor="calc-hour"
          hint="Starts within 5 minutes of this time, once a day. Records are worked through in the background, after any changes waiting to be calculated."
        >
          <div className="rate-options">
            <label className="field" htmlFor="calc-hour">
              <span>At</span>
              <Select id="calc-hour" value={String(draft.nightly_hour)} onChange={(v) => setDraft({ ...draft, nightly_hour: Number(v) })} options={hourOptions} />
            </label>
            <label className="field" htmlFor="calc-zone">
              <span>Time zone</span>
              <Select id="calc-zone" value={draft.nightly_time_zone} onChange={(v) => setDraft({ ...draft, nightly_time_zone: v })} options={zoneOptions} search />
            </label>
          </div>
        </SettingRow>
        <SettingRow label="Last run">
          {settings.last_run_at
            ? <span>{when(settings.last_run_at)}<span className="muted small"> · {count(settings.last_run_count ?? 0)} records queued</span></span>
            : <span className="muted">Not yet</span>}
        </SettingRow>
        <SettingRow label="Next run" hint="In your own time.">
          {when(settings.next_run_at)}
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Waiting" description="Records whose calculations are queued. Changed records and the records one association away go first; records two and three associations away, and the nightly run, follow once nothing else waits.">
        <SettingRow label="Changed records and one away">{count(settings.waiting_now)}</SettingRow>
        <SettingRow label="Two and three away, nightly run">{count(settings.waiting_later)}</SettingRow>
        <SettingRow label="Changes not yet followed further" hint="Turned into queued records every 30 seconds.">{count(settings.chains_waiting)}</SettingRow>
      </SettingsSection>

      <SaveBar dirty={dirty} error={error}>
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft({ nightly_hour: settings.nightly_hour, nightly_time_zone: settings.nightly_time_zone })}>Discard</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={save}>Save</button>
      </SaveBar>
    </SettingsPage>
  );
}
