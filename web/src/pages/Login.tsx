import { useEffect, useState } from 'react';
import { API_BASE, api, type Me } from '../lib/api';
import { LogoMark } from '../components/Logo';

// Set by the API's callback as ?auth_error=...
const AUTH_ERRORS: Record<string, string> = {
  no_user: 'No active CRM user has this account\u2019s email. Ask an admin to add you.',
  user_deactivated: 'Your CRM user is deactivated. Ask an admin if you need access again.',
  domain_not_allowed: 'This account\u2019s domain is not allowed to sign in.',
  email_not_verified: 'This account\u2019s email is not verified.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_not_configured: 'Google sign-in is not set up on this server.',
  google_failed: 'Google sign-in failed. Please try again.',
  microsoft_cancelled: 'Microsoft sign-in was cancelled.',
  microsoft_not_configured: 'Microsoft sign-in is not set up on this server.',
  microsoft_failed: 'Microsoft sign-in failed. Please try again.',
  no_verified_email: 'Microsoft did not confirm an email address for this account, so it cannot be linked to a CRM user. Try Google, or ask an admin.'
};

function takeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('auth_error');
  const detail = url.searchParams.get('auth_detail');
  if (!code && !detail) return null;
  url.searchParams.delete('auth_error');
  url.searchParams.delete('auth_detail');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  const base = code ? (AUTH_ERRORS[code] ?? (code.startsWith('microsoft_') ? AUTH_ERRORS.microsoft_failed : AUTH_ERRORS.google_failed)) : 'Sign-in failed.';
  return detail ? `${base} (${detail})` : base;
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

function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

// reauth: shown over the app when an admin change needs a fresh sign-in;
// signing in comes back to the same page.
export function Login({ onSignedIn, reauth, onCancel }: { onSignedIn: (me: Me) => void; reauth?: boolean; onCancel?: () => void }) {
  const [error, setError] = useState<string | null>(takeAuthError);
  const [config, setConfig] = useState<{ google: boolean; microsoft: boolean }>({ google: false, microsoft: false });
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api<{ google?: boolean; microsoft?: boolean }>('GET', '/v1/auth/config', undefined, null)
      .then((c) => setConfig({ google: Boolean(c.google), microsoft: Boolean(c.microsoft) }))
      .catch(() => setConfig({ google: false, microsoft: false }))
      .finally(() => setChecking(false));
  }, []);

  const returnTo = window.location.pathname + window.location.search;
  const googleHref = `${API_BASE}/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
  const msHref = `${API_BASE}/v1/auth/microsoft/start?return_to=${encodeURIComponent(returnTo)}`;

  if (checking) return <div className="splash">Loading…</div>;

  const hasAny = config.google || config.microsoft;

  return (
    <div className={`login${reauth ? ' reauth' : ''}`}>
      <div className="login-card">
        <div className="wordmark"><LogoMark size={22} /><b>ProfitPad</b></div>
        <h1>{reauth ? 'Confirm it\u2019s you' : 'Log in to ProfitPad CRM'}</h1>
        {reauth && <p className="muted">Changes to access (roles, API keys, sharing rules, other people{'\u2019'}s sessions) need a sign-in within the last 4 hours. Sign in again, then repeat the change.</p>}
        {hasAny ? (
          <div className="login-actions">
            {config.google && (
              <a className="btn sso-btn google-btn" href={googleHref}>
                <GoogleMark />
                Log in with Google
              </a>
            )}
            {config.microsoft && (
              <a className="btn sso-btn ms-btn" href={msHref}>
                <MicrosoftMark />
                Log in with Microsoft
              </a>
            )}
          </div>
        ) : (
          <p className="muted">Sign-in is not configured. Contact an administrator.</p>
        )}
        {error && <div className="error">{error}</div>}
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
