import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import { API_BASE, api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { EmptyState, SettingsPage, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';
import '../booking.css';
import { confirmDialog } from '../components/confirm';

// Settings -> Calendars: the user's Google and Microsoft calendars for the
// meeting booker (api/src/calendar/connect.ts). Connecting leaves the CRM for
// the provider's consent screen and comes back here with ?calendar=connected
// or ?calendar_error=<code>. Booking pages check every connected calendar for
// busy times and add new meetings to the one marked for new meetings.

interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  can_write: boolean;
}

interface Connection {
  id: string;
  provider: 'google' | 'microsoft';
  email: string | null;
  busy_calendar_ids: string[];
  write_calendar_id: string | null;
  use_for_new_events: boolean;
  status: 'active' | 'needs_reconnect';
  error: string | null;
  calendars: CalendarInfo[] | null;
  created_at: string;
}

interface Config {
  google: boolean;
  microsoft: boolean;
  google_domains: string[];
}

const PROVIDER = { google: 'Google Calendar', microsoft: 'Microsoft Outlook' };

const ERRORS: Record<string, string> = {
  cancelled: 'Connecting was cancelled.',
  domain_not_allowed: 'That account cannot be connected.',
  missing_permission: 'Calendar access was not allowed on the consent screen. Try again and allow it.',
  signed_out: 'Your CRM session ended while connecting. Sign in and try again.',
  not_configured: 'Calendar connections are not set up on the server yet.',
  failed: 'The calendar could not be connected.'
};

export function CalendarSettings() {
  const { toast } = useApp();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [config, setConfig] = useState<Config | null>(null);
  const [list, setList] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([api<Config>('GET', '/v1/calendar/config'), api<{ results: Connection[] }>('GET', '/v1/calendar/connections')]);
    setConfig(c);
    setList(l.results);
  }, []);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  // result of the provider round trip, shown once
  useEffect(() => {
    const failed = params.get('calendar_error');
    if (params.get('calendar') === 'connected') toast('Calendar connected');
    else if (failed) setNotice([ERRORS[failed] ?? ERRORS.failed, params.get('calendar_detail')].filter(Boolean).join(' '));
    if (params.has('calendar') || failed) navigate('/settings/calendars', { replace: true });
  }, [params, navigate, toast]);

  async function run(fn: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await fn();
      toast(message);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const connect = (p: 'google' | 'microsoft') => {
    window.location.href = `${API_BASE}/v1/calendar/${p}/connect`;
  };
  const patch = (c: Connection, body: Record<string, unknown>, message = 'Saved') =>
    run(() => api('PATCH', `/v1/calendar/connections/${c.id}`, body), message);

  const busyIds = (c: Connection) => (c.busy_calendar_ids.length ? c.busy_calendar_ids : (c.calendars ?? []).filter((x) => x.primary).map((x) => x.id));
  const toggleBusy = (c: Connection, id: string, on: boolean) => {
    const next = on ? [...busyIds(c), id] : busyIds(c).filter((x) => x !== id);
    if (!next.length) return setError('Keep at least one calendar checked for busy times.');
    void patch(c, { busy_calendar_ids: next });
  };

  const providers = config && (
    <>
      <button className="btn" onClick={() => connect('google')} disabled={!config.google}>Connect Google Calendar</button>
      <button className="btn" onClick={() => connect('microsoft')} disabled={!config.microsoft}>Connect Microsoft Outlook</button>
    </>
  );

  return (
    <SettingsPage
      title="Calendars"
      description={<>
        Booking pages offer only the times when your connected calendars are free, and add booked meetings to your calendar with the visitor invited.
        {config && config.google_domains.length > 0 && ` Google accounts must be ${config.google_domains.join(' or ')} accounts.`}
      </>}
      actions={list && list.length > 0 ? providers : undefined}
    >
      {notice && <div className="error">{notice}</div>}
      {error && <div className="error">{error}</div>}
      {config && !config.google && !config.microsoft && <div className="callout">Calendar connections are not set up on the server yet.</div>}

      {!list && !error && <TableSkeleton rows={2} />}
      {list && list.length === 0 && (
        <EmptyState icon={<CalendarDays size={18} />} title="No calendars connected" action={config && (config.google || config.microsoft) && <div className="cal-provider-row">{providers}</div>}>
          Connect a calendar so booking pages can see when you are busy and add meetings for you.
        </EmptyState>
      )}
      <div className="thing-list">
        {list?.map((c) => (
          <div className="thing" key={c.id}>
            <div className="thing-head">
              <div>
                <div className="thing-title">
                  {PROVIDER[c.provider]}
                  {c.status === 'needs_reconnect' && <StatusPill tone="warn">Needs to be connected again</StatusPill>}
                  {c.use_for_new_events && c.status === 'active' && <StatusPill tone="on">New meetings go here</StatusPill>}
                </div>
                {c.email && <div className="thing-sub">{c.email}</div>}
              </div>
              <div className="thing-actions">
                {c.status === 'needs_reconnect' && <button className="btn primary small" onClick={() => connect(c.provider)}>Connect again</button>}
                {!c.use_for_new_events && c.status === 'active' && (
                  <button className="btn small" onClick={() => patch(c, { use_for_new_events: true }, 'New meetings go to this calendar')}>Use for new meetings</button>
                )}
                <button className="btn small ghost danger-text" onClick={async () => (await confirmDialog('Booking pages stop checking it.', { title: `Disconnect ${PROVIDER[c.provider]}${c.email ? ` (${c.email})` : ''}?`, confirmLabel: 'Disconnect', danger: true }))
                  && run(() => api('DELETE', `/v1/calendar/connections/${c.id}`), 'Calendar disconnected')}>Disconnect</button>
              </div>
            </div>
            {(c.error || c.calendars) && (
              <div className="thing-body">
                {c.error && <div className="error">{c.error}</div>}
                {c.calendars && (
                  <>
                    <div className="cal-calendars">
                      <span className="cal-calendars-title">Count as busy</span>
                      {c.calendars.map((cal) => (
                        <label key={cal.id}>
                          <input type="checkbox" checked={busyIds(c).includes(cal.id)} onChange={(e) => toggleBusy(c, cal.id, e.target.checked)} />
                          {cal.name}{cal.primary ? ' (main)' : ''}
                        </label>
                      ))}
                    </div>
                    <label className="field cal-write">
                      <span>Add new meetings to</span>
                      <Select value={c.write_calendar_id ?? ''} onChange={(v) => patch(c, { write_calendar_id: v || null })}>
                        <option value="">Main calendar</option>
                        {c.calendars.filter((cal) => cal.can_write && !cal.primary).map((cal) => <option key={cal.id} value={cal.id}>{cal.name}</option>)}
                      </Select>
                    </label>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </SettingsPage>
  );
}
