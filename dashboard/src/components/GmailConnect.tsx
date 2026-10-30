import { useEffect, useState } from 'react';

interface GmailStatus { eligible?: boolean; needed?: boolean; connected: boolean; configured: boolean; account: string | null; error?: string | null;
  provider?: 'browser' | 'mcp'; providers?: Array<'browser' | 'mcp'>; admin?: boolean }
export function GmailConnect({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [error, setError] = useState(() => {
    const result = new URLSearchParams(location.search);
    return result.get('gmail') === 'error' ? result.get('gmail_error') || 'Gmail could not connect.' : '';
  });
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch('/api/gmail/status');
    if (!response.ok) throw new Error('Could not load the Gmail connection.');
    setStatus(await response.json());
  }
  useEffect(() => {
    void (async () => {
      try { await load(); } catch (reason) { setError((reason as Error).message); }
    })();
    const refresh = () => { void load().catch(reason => setError(reason.message)); };
    window.addEventListener('gmail-connection-changed', refresh);
    window.addEventListener('setup-status-changed', refresh);
    return () => {
      window.removeEventListener('gmail-connection-changed', refresh);
      window.removeEventListener('setup-status-changed', refresh);
    };
  }, []);
  async function connect() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (status?.provider === 'browser') {
        const state = await fetch('/api/signin/session').then(response => response.json());
        const response = await fetch(state.supported ? '/api/signin/session' : '/api/browser/manual-login?target=gmail&consent=true', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'gmail', consent: true }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Gmail could not open.');
        if (state.supported) window.dispatchEvent(new CustomEvent('signin-session-changed', { detail: body.session }));
        else setError('Chrome opened on this computer. Sign in to your profile Gmail address, close Chrome, then refresh Settings.');
        setBusy(false);
        return;
      }
      const response = await fetch('/api/gmail/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Gmail could not connect.');
      window.location.assign(body.url);
    } catch (reason) { setError((reason as Error).message); setBusy(false); }
  }
  async function choose(provider: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/gmail/connection', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Gmail method could not change.');
      await load();
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
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
    {status?.admin && <label className="job-meta">Connection method <select aria-label="Gmail connection method" disabled={busy} value={status.provider} onChange={event => void choose(event.target.value)}>
      <option value="browser">Browser Gmail</option><option value="mcp">Gmail MCP</option>
    </select></label>}
    {status?.account && <span className="job-meta">{status.provider === 'browser' ? 'Saved browser account' : status.connected ? 'Connected' : 'Gmail'}: {status.account}</span>}
    {status?.error && <p className="job-meta">{status.error}</p>}
    <button className={`btn ${status?.connected ? '' : 'primary'}`} disabled={busy || !status?.configured || status.eligible === false} onClick={() => void connect()}>
      {busy ? 'Please wait…' : status?.provider === 'browser' ? 'Connect browser Gmail' : status?.account ? 'Reconnect Gmail' : 'Connect Gmail'}
    </button>
    {status?.connected && <button className="btn" disabled={busy} onClick={() => void disconnect()}>{status.provider === 'browser' ? 'Disable mailbox access' : 'Disconnect'}</button>}
    {status && !status.configured && <span className="job-meta">Gmail connections are not configured yet.</span>}
  </>;
  const description = status?.provider === 'browser'
    ? 'Connect the Gmail address in your profile using your private browser. By connecting, you allow Owtomate to read verification emails and send only email applications you confirm. The browser session can access the entire mailbox. Message bodies are processed locally. See our privacy policy.'
    : 'Connect the Gmail address used in your profile. Owtomate reads recent verification emails and sends only the email applications you confirm. Message bodies are processed locally. See our privacy policy.';
  if (compact) return <div className="seek-connect">
    {error && <div className="banner banner-bad" role="alert">{error}</div>}<a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>
    <div className="seek-connect-row gmail-connect-card"><div><h3>Gmail</h3><p className="job-meta">{description}</p></div><div className="gmail-actions">{controls}</div></div>
  </div>;
  return <div className="card step">
    <div className="step-head"><span className={`step-n ${status?.connected ? 'done' : ''}`}>{status?.connected ? '✓' : '5'}</span>
      <div><h3 className="step-title">Gmail</h3><p className="job-meta step-blurb">{description}</p></div></div>
    {error && <div className="banner banner-bad" role="alert">{error}</div>}
    <div className="step-body gmail-actions">{controls}<a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a></div>
  </div>;
}
