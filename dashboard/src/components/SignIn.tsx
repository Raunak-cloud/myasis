import { useEffect, useState } from 'react';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export function useAuth() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [googleConfigured, setGoogleConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = () =>
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((j) => {
        setUser(j.user ?? null);
        setGoogleConfigured(Boolean(j.googleConfigured));
      })
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    refresh();
  }, []);

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  };

  return { user, googleConfigured, loading, refresh, signOut };
}

/** Google's mark, inlined so the button works offline and in both themes. */
function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.6 5.9c4.4-4.1 6.7-10.1 6.7-17.4z" />
      <path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.8 2.3-8.3 2.3-6.3 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/**
 * Sign-in gate.
 *
 * Applications, résumés and contact details all belong to an account, so the
 * app asks who you are before showing any of it.
 */
export function SignIn({ googleConfigured }: { googleConfigured: boolean }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The OAuth callback redirects here with a readable reason on failure.
    const p = new URLSearchParams(location.search).get('auth_error');
    if (p) {
      setError(p);
      history.replaceState({}, '', location.pathname);
    }
  }, []);

  return (
    <div className="signin-wrap">
      <div className="card signin">
        <div className="signin-brand">
          <img className="signin-logo" src="/favicon.svg" alt="" />
          <h1>Myasis</h1>
          <p className="job-meta">Automated job applications</p>
        </div>

        {error && <div className="banner banner-bad signin-error">{error}</div>}

        {googleConfigured ? (
          <>
            <a className="btn google-btn" href="/api/auth/google">
              <GoogleMark />
              Continue with Google
            </a>
            <p className="job-meta signin-note">
              Your résumé, details and application history are tied to this account.
            </p>
          </>
        ) : (
          <div className="banner">
            Google sign-in isn't configured. Add <span className="mono">GOOGLE_CLIENT_ID</span> and{' '}
            <span className="mono">GOOGLE_CLIENT_SECRET</span> to the server environment.
          </div>
        )}
      </div>
    </div>
  );
}

/** Header chip: who is signed in, and a way out. */
export function UserChip({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const initial = (user.name ?? user.email).trim().charAt(0).toUpperCase();

  return (
    <div className="userchip-wrap">
      <button className="userchip" onClick={() => setOpen(!open)} title={user.email}>
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="userchip-initial">{initial}</span>
        )}
      </button>
      {open && (
        <>
          <div className="userchip-backdrop" onClick={() => setOpen(false)} />
          <div className="card userchip-menu">
            <div className="userchip-id">
              <strong>{user.name ?? 'Signed in'}</strong>
              <div className="job-meta">{user.email}</div>
            </div>
            <button className="btn" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
