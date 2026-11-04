import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';

// Shown on every page while a Super Admin is signed in as another user. It has
// no close button on purpose: the only way out is back to their own account
// (or signing out).
export function SignedInAsBanner() {
  const { me } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const by = me.signed_in_as_by;
  if (!by) return null;
  const who = me.user?.name || me.user?.email || 'another user';

  async function goBack() {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/sign-in-as/end');
      // a full load, so nothing of this user's (menu, views, objects) stays behind
      window.location.assign(me.user ? `/objects/users/${me.user.id}` : '/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="signed-in-as" role="status" aria-live="polite">
      <span className="signed-in-as-text">
        <UserRound size={16} aria-hidden />
        <span>
          You are signed in as <strong>{who}</strong>{me.user?.email && me.user.name ? ` (${me.user.email})` : ''}. Everything you do here is done as them.
        </span>
      </span>
      <button type="button" onClick={goBack} disabled={busy}>
        {busy ? 'Going back…' : `Back to ${by.name || by.email || 'my account'}`}
      </button>
      {error && <span>{error}</span>}
    </div>
  );
}
