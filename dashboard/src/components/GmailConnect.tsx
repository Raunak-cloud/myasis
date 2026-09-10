import { useEffect, useState } from 'react';

/**
 * Read-only Gmail access, so a run can enter the one-time codes employer
 * sites email during an application. Connecting is a Google consent redirect;
 * the token is stored server-side and never reaches the browser.
 *
 * Two shapes. The numbered card belongs in Setup, where an account is
 * configured once. The compact row sits on the Apply page and disappears the
 * moment it is connected — it exists to catch the person who is about to run
 * without it, not to take up space forever.
 */

interface GmailStatus {
  connected: boolean;
  email: string | null;
  /**
   * Whether this account has any use for Gmail access. Only an intensive pass
   * reaches employer sites, which are the only things that email a code, and
   * a profile already signed in to Google can have the code read out of the
   * browser instead. The server decides; this component only obeys.
   */
  needed?: boolean;
  /** The Google account already signed in to this profile's Chrome, if any. */
  browserAccount?: string | null;
}

const BLURB =
  'Many employer sites email a one-time code before an application can be sent. With read-only access to your Gmail, the agent enters that code itself instead of stopping and asking you. Nothing is sent or deleted.';

export function GmailConnect({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    fetch('/api/gmail/status')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ connected: false, email: null }));

  useEffect(() => {
    void refresh();
    const params = new URLSearchParams(location.search);
    if (params.get('gmail') === 'connected') {
      setNotice({ tone: 'ok', text: 'Gmail connected. Runs can now enter emailed verification codes.' });
    }
    const failed = params.get('gmail_error');
    if (failed) setNotice({ tone: 'bad', text: failed });
    if (params.has('gmail') || params.has('gmail_error')) history.replaceState(null, '', location.pathname);
  }, []);

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/gmail/disconnect', { method: 'POST' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  // On the Apply page this is a prompt, not a setting: once it is done, it
  // goes — and it never appears for an account that has no use for it.
  if (compact) {
    if (status.connected && !notice) return null;
    if (status.needed === false && !notice) return null;
    return (
      <div className="seek-connect">
        {notice && <div className={`banner ${notice.tone === 'ok' ? 'banner-ok' : 'banner-bad'}`}>{notice.text}</div>}
        {!status.connected && (
          <div className="seek-connect-row">
            <div>
              <h3>Verification emails</h3>
              <p className="job-meta">Let the agent read one-time codes employers email, instead of stopping to ask.</p>
            </div>
            <a className="btn" href="/api/gmail/connect">
              Connect Gmail
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card step">
      <div className="step-head">
        <span className={`step-n ${status.connected ? 'done' : ''}`}>{status.connected ? '✓' : '5'}</span>
        <div>
          <h3 className="step-title">Verification emails</h3>
          <p className="job-meta step-blurb">{BLURB}</p>
        </div>
      </div>
      {notice && <div className={`banner ${notice.tone === 'ok' ? 'banner-ok' : 'banner-bad'}`}>{notice.text}</div>}
      <div className="step-body gmail-actions">
        {status.browserAccount && !status.connected ? (
          // Already solvable without OAuth: the agent reads the code out of
          // the browser it is driving. Offering to connect here would ask for
          // an account's whole inbox to buy nothing.
          <span className="job-meta">
            Not needed — the agent reads codes from {status.browserAccount}, already signed in to your browser.
          </span>
        ) : status.needed === false && !status.connected ? (
          <span className="job-meta">
            Not needed on your plan. Employer sites are the only ones that email a code, and only an intensive pass applies to those.
          </span>
        ) : status.connected ? (
          <>
            <span className="job-meta">Connected{status.email ? ` as ${status.email}` : ''}.</span>
            <button className="btn" disabled={busy} onClick={disconnect}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        ) : (
          <a className="btn primary" href="/api/gmail/connect">
            Connect Gmail
          </a>
        )}
      </div>
    </div>
  );
}
