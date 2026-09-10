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
