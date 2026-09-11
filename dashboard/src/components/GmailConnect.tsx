import { useEffect, useState } from 'react';

/**
 * The mailbox a run reads one-time codes from.
 *
 * This is a browser session, not an API connection. Gmail's API needs the
 * `gmail.readonly` scope, which Google classes as restricted: granting it to
 * a production app requires a paid third-party security assessment, so for an
 * unverified app OAuth just returns access_denied. A mailbox signed in to the
 * account's own Chrome needs no scope, no token and no review — and the run
 * already drives that browser, so the code is one tab away.
 *
 * It must be a Gmail made for this, never a real inbox: everything in that
 * mailbox is readable by the agent for as long as it stays signed in.
 *
 * Two shapes. The numbered card belongs in Setup, where an account is set up
 * once. The compact row sits on the Apply page and disappears once a mailbox
 * is in place — it exists to catch the person about to run without one, not
 * to take up space forever.
 */

interface GmailStatus {
  /**
   * Whether this account has any reason to be asked for a mailbox at all.
   * Only an intensive pass reaches employer sites, and those are the only
   * things that email a code. The server decides; this component obeys.
   */
  needed?: boolean;
  /** The Google account signed in to this profile's Chrome, if any. */
  browserAccount?: string | null;
}

const WHY =
  'Many employer sites email a one-time code before an application can be sent. With a mailbox it can read, the agent enters that code itself instead of stopping to ask you.';

const SEPARATE =
  'Create a new Gmail account just for this at gmail.com — not your real inbox. Everything in it is readable by the agent for as long as it stays signed in.';

export function GmailConnect({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/gmail/status')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ browserAccount: null }));
  }, []);

  /**
   * Opens the same private browser window the SEEK sign-in uses, on Google's
   * account chooser. Reloading afterwards is what brings that window up: the
   * viewer component reads the session when it mounts.
   */
  async function openGmailWindow() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/signin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'gmail' }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not open the browser.');
      location.reload();
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  }

  if (!status) return null;
  const signedIn = Boolean(status.browserAccount);

  if (compact) {
    if (signedIn && !error) return null;
    if (status.needed === false && !error) return null;
    return (
      <div className="seek-connect">
        {error && <div className="banner banner-bad">{error}</div>}
        <div className="seek-connect-row">
          <div>
            <h3>Verification emails</h3>
            <p className="job-meta">{SEPARATE}</p>
          </div>
          <button className="btn" disabled={busy} onClick={openGmailWindow}>
            {busy ? 'Opening…' : 'Sign in to Gmail'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card step">
      <div className="step-head">
        <span className={`step-n ${signedIn ? 'done' : ''}`}>{signedIn ? '✓' : '5'}</span>
        <div>
          <h3 className="step-title">Verification emails</h3>
          <p className="job-meta step-blurb">{WHY} {SEPARATE}</p>
        </div>
      </div>
      {error && <div className="banner banner-bad">{error}</div>}
      <div className="step-body gmail-actions">
        {signedIn ? (
          <>
            <span className="job-meta">Reading codes from {status.browserAccount}, signed in to your browser.</span>
            <button className="btn" disabled={busy} onClick={openGmailWindow}>
              {busy ? 'Opening…' : 'Change account'}
            </button>
          </>
        ) : status.needed === false ? (
          <span className="job-meta">
            Not needed on your plan. Employer sites are the only ones that email a code, and only an intensive pass
            applies to those.
          </span>
        ) : (
          <button className="btn primary" disabled={busy} onClick={openGmailWindow}>
            {busy ? 'Opening…' : 'Sign in to Gmail'}
          </button>
        )}
      </div>
    </div>
  );
}
