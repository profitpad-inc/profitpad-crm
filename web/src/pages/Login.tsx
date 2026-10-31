import { useState, type FormEvent } from 'react';
import { api, setApiKey, type Me } from '../lib/api';

// Temporary sign-in with an API key until SSO, passkeys and magic links exist.
export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api<Me>('GET', '/v1/me', undefined, key.trim());
      setApiKey(key.trim());
      onSignedIn(me);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark">P</div>
        <h1>ProfitPad CRM</h1>
        <p className="muted">Sign in with your API key. Google, Microsoft, passkey and email sign-in are coming.</p>
        <label className="field">
          <span>API key</span>
          <input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="pcrm_…" />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy || !key.trim()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
