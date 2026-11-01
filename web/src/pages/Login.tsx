import { useEffect, useState, type FormEvent } from 'react';
import { API_BASE, api, setApiKey, type Me } from '../lib/api';

// Set by the API's Google callback as ?auth_error=...
const AUTH_ERRORS: Record<string, string> = {
  no_user: 'No active CRM user has this Google account’s email. Ask an admin to add you.',
  user_deactivated: 'Your CRM user is deactivated. Ask an admin if you need access again.',
  domain_not_allowed: 'This Google account’s domain is not allowed to sign in.',
  email_not_verified: 'This Google account’s email is not verified.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_not_configured: 'Google sign-in is not set up on this server.',
  google_failed: 'Google sign-in failed. Please try again.'
};

function takeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('auth_error');
  if (!code) return null;
  url.searchParams.delete('auth_error');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  return AUTH_ERRORS[code] ?? AUTH_ERRORS.google_failed;
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(takeAuthError);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);

  useEffect(() => {
    api<{ google: boolean }>('GET', '/v1/auth/config', undefined, null)
      .then((c) => setGoogle(c.google))
      .catch(() => setGoogle(false));
  }, []);

  const returnTo = window.location.pathname + window.location.search;
  const googleHref = `${API_BASE}/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;

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
        {google && (
          <>
            <a className="btn google-btn" href={googleHref}>
              <GoogleMark />
              Continue with Google
            </a>
            <div className="login-divider muted">or use an API key</div>
          </>
        )}
        {!google && <p className="muted">Sign in with your API key.</p>}
        <label className="field">
          <span>API key</span>
          <input type="password" autoFocus={!google} value={key} onChange={(e) => setKey(e.target.value)} placeholder="pcrm_…" />
        </label>
        {error && <div className="error">{error}</div>}
        <button className={`btn${google ? '' : ' primary'}`} disabled={busy || !key.trim()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
