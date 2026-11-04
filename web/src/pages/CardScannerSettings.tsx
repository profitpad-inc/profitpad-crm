import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { SaveBar, SettingRow, SettingsPage, SettingsSection, StatusPill, TableSkeleton } from '../components/settings';
import { Select } from '../components/Select';

// Settings -> Card scanner (admins): how the business card scanner reads
// cards (api/src/card-scan.ts). Tesseract on this server by default; Claude
// Haiku 5.5 with the tenant's own Anthropic API key when an admin adds one. The key is
// stored sealed and never shown again, only its last four characters.

interface State {
  reader: 'tesseract' | 'claude';
  has_key: boolean;
  key_unreadable: boolean;
  key_hint: string | null;
  tesseract_version: string | null;
  can_store_secrets: boolean;
}

export function CardScannerSettings() {
  const { toast } = useApp();
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<{ reader: State['reader'] } | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<State>('GET', '/v1/card-scans/settings')
      .then((s) => { setState(s); setDraft({ reader: s.reader }); })
      .catch((err) => setError((err as Error).message));
  }, []);

  async function put(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const s = await api<State>('PUT', '/v1/card-scans/settings', body);
      setState(s);
      setDraft({ reader: s.reader });
      setKey('');
      toast(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const description = (
    <>Pick how the <Link to="/scan">card scanner</Link> reads business cards. Either way, people check what was read before anything is saved.</>
  );
  if (!state || !draft) {
    return <SettingsPage title="Card scanner" description={description}>{error ? <div className="error">{error}</div> : <TableSkeleton rows={3} />}</SettingsPage>;
  }
  const dirty = draft.reader !== state.reader;

  return (
    <SettingsPage title="Card scanner" description={description}>
      <SettingsSection title="Reading cards">
        <SettingRow
          label="Read cards with"
          htmlFor="card-reader"
          hint={draft.reader === 'tesseract'
            ? 'Tesseract reads the photo on this server, so it never leaves the CRM. Good on clear, flat photos; glare, blur and fancy fonts trip it up.'
            : 'The photo goes to Anthropic with your API key, and Claude Haiku 5.5 reads it. Much better on poor photos and unusual layouts. Anthropic bills your account for each card, about US$0.0007 per card.'}
        >
          <Select
            id="card-reader"
            value={draft.reader}
            onChange={(v) => setDraft({ ...draft, reader: v as State['reader'] })}
            options={[
              { value: 'tesseract', label: 'On this server (Tesseract)' },
              { value: 'claude', label: 'Claude Haiku 5.5 (Anthropic)', disabled: !state.has_key }
            ]}
          />
        </SettingRow>
        <SettingRow label="Tesseract on this server">
          {state.tesseract_version
            ? <StatusPill tone="on">Installed (version {state.tesseract_version})</StatusPill>
            : <StatusPill tone="failed">Not installed</StatusPill>}
        </SettingRow>
        {!state.tesseract_version && state.reader === 'tesseract' && (
          <div className="callout warn">Tesseract is not installed on the API server, so cards can't be read yet; people type the details in. Install it (docs/deploy.md) or add a Claude API key below.</div>
        )}
      </SettingsSection>

      <SettingsSection title="Claude Haiku 5.5" description="Optional. Cards are read with Anthropic's Claude Haiku 5.5 model, on your own Anthropic account: create a key at console.anthropic.com.">
        <SettingRow
          label="Anthropic API key"
          htmlFor="anthropic-key"
          hint={state.has_key ? `A key ending in ${state.key_hint} is saved. It is never shown again.` : 'Checked with Anthropic before it is saved, then stored encrypted.'}
        >
          {state.key_unreadable && <div className="error">The saved key can't be opened on this server (its encryption key changed). Save the API key again.</div>}
          {!state.can_store_secrets ? (
            <div className="callout warn">This server can't store secrets yet (MASTER_ENCRYPTION_KEY is not set).</div>
          ) : (
            <div className="key-row">
              <input
                id="anthropic-key"
                type="password"
                autoComplete="off"
                placeholder={state.has_key ? 'Paste a new key to replace it' : 'sk-ant-...'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button className="btn primary" disabled={busy || !key.trim()} onClick={() => put({ anthropic_key: key.trim() }, 'API key saved.')}>
                {busy ? 'Checking…' : state.has_key ? 'Replace key' : 'Save key'}
              </button>
              {state.has_key && (
                <button className="btn ghost danger-text" disabled={busy} onClick={() => put({ anthropic_key: null }, 'API key removed. Cards are read with Tesseract.')}>Remove</button>
              )}
            </div>
          )}
        </SettingRow>
      </SettingsSection>

      <SaveBar dirty={dirty} error={error}>
        <button className="btn" disabled={!dirty || busy} onClick={() => setDraft({ reader: state.reader })}>Discard</button>
        <button className="btn primary" disabled={!dirty || busy} onClick={() => put(draft, 'Card scanner settings saved.')}>Save</button>
      </SaveBar>
    </SettingsPage>
  );
}
