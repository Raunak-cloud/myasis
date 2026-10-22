import { useEffect, useState } from 'react';

interface GmailStatus { eligible?: boolean; needed?: boolean; connected: boolean; configured: boolean; account: string | null; error?: string | null }
export function GmailConnect({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch('/api/gmail/status');
    if (!response.ok) throw new Error('Could not load the Gmail connection.');
    setStatus(await response.json());
  }
  useEffect(() => {
    void load().catch(reason => setError(reason.message));
    const result = new URLSearchParams(location.search);
    if (result.get('gmail') === 'error') setError(result.get('gmail_error') || 'Gmail could not connect.');
  }, []);
  async function connect() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/gmail/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Gmail could not connect.');
      window.location.assign(body.url);
    } catch (reason) { setError((reason as Error).message); setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/gmail/connection', { method: 'DELETE' });
      if (!response.ok) throw new Error('Gmail could not disconnect.');
      await load();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  if (status?.eligible === false && !status.connected) return null;
  if (compact && status?.connected && !status.error && !error) return null;
  const controls = <>
    {status?.account && <span className="job-meta">{status.connected ? 'Connected' : 'Gmail'}: {status.account}</span>}
    {status?.error && <p className="job-meta">{status.error}</p>}
    <button className={`btn ${status?.connected ? '' : 'primary'}`} disabled={busy || !status?.configured || status.eligible === false} onClick={() => void connect()}>
      {busy ? 'Please wait…' : status?.account ? 'Reconnect Gmail' : 'Connect Gmail'}
    </button>
    {status?.account && <button className="btn" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>}
    {status && !status.configured && <span className="job-meta">Gmail connections are not configured yet.</span>}
  </>;
  const description = 'Connect the Gmail address used in your profile. Owtomate reads verification emails and sends only the email applications you confirm.';
  if (compact) return <div className="seek-connect">
    {error && <div className="banner banner-bad" role="alert">{error}</div>}
    <div className="seek-connect-row"><div><h3>Gmail</h3><p className="job-meta">{description}</p></div><div className="gmail-actions">{controls}</div></div>
  </div>;
  return <div className="card step">
    <div className="step-head"><span className={`step-n ${status?.connected ? 'done' : ''}`}>{status?.connected ? '✓' : '5'}</span>
      <div><h3 className="step-title">Gmail</h3><p className="job-meta step-blurb">{description}</p></div></div>
    {error && <div className="banner banner-bad" role="alert">{error}</div>}
    <div className="step-body gmail-actions">{controls}</div>
  </div>;
}
