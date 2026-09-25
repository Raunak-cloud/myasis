import { useEffect, useState } from 'react';

interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

const SIGNED_IN_HINT = 'myasis-signed-in';

/**
 * Whether this browser was signed in the last time we looked. Not trusted
 * for anything; it only decides what to draw for the half second before the
 * server answers, so a visitor is not shown "Loading…" instead of the page.
 */
export function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_HINT) === '1';
  } catch {
    return false;
  }
}

function rememberSignedIn(value: boolean) {
  try {
    if (value) localStorage.setItem(SIGNED_IN_HINT, '1');
    else localStorage.removeItem(SIGNED_IN_HINT);
  } catch {
    // Private mode or storage off; the next load just shows "Loading…" briefly.
  }
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
        rememberSignedIn(Boolean(j.user));
        setGoogleConfigured(Boolean(j.googleConfigured));
      })
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    refresh();
  }, []);

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    rememberSignedIn(false);
    setUser(null);
  };

  return { user, googleConfigured, loading, refresh, signOut };
}
