import { useEffect, useState } from 'react';
import { api } from '../adminApi';

interface Credit {
  status: 'ready' | 'disconnected' | 'unavailable';
  creditBalanceCents?: number;
  currency?: string;
  workspaceName?: string;
  checkedAt?: string;
  message?: string;
}

/** Admin-only workspace credit, independent of a candidate's run allowance. */
export function CelerisBalance() {
  const [balance, setBalance] = useState<Credit | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const value = await api<Credit>('/celeris/balance', { signal: controller.signal });
        if (!controller.signal.aborted) { setBalance(value); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { busy = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    document.addEventListener('visibilitychange', load);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [refresh]);
  return <div className="celeris-credit" aria-live="polite">
    <div>
      <strong>Celeris credit</strong>
      <span className="celeris-credit-amount">{balance?.status === 'ready'
        ? new Intl.NumberFormat('en-AU', { style: 'currency', currency: balance.currency, currencyDisplay: 'code' }).format(balance.creditBalanceCents! / 100)
        : error ? 'Unavailable' : !balance ? 'Checking…' : balance.status === 'disconnected' ? 'Connect billing access' : 'Unavailable'}</span>
      <span className="job-meta">{balance?.status === 'ready'
        ? `Remaining prepaid credit · ${balance.workspaceName} · checked ${new Date(balance.checkedAt!).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' })} Sydney`
        : balance?.message || 'Workspace balance · admin only'}</span>
      {error && balance?.status === 'ready' && <span className="job-meta" role="status">Could not refresh. Showing the last checked balance.</span>}
    </div>
    <div className="celeris-credit-actions">
      <button type="button" className="btn" onClick={() => setRefresh(value => value + 1)}>Refresh</button>
      <a href="https://console.celeris.ai" target="_blank" rel="noopener noreferrer">Celeris billing ↗</a>
    </div>
  </div>;
}
