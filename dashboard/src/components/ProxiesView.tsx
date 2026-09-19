import { useCallback, useEffect, useState } from 'react';
import { api } from '../adminApi';

/**
 * The Webshare pool: which dedicated address each paying account holds,
 * which are free, and whether any paying account is going without.
 * The server decides every assignment; this page only shows them.
 */

interface PoolReport {
  enabled: boolean;
  countries: string[];
  lastSyncAt: string | null;
  lastSyncError: string | null;
  plans: Array<{ id: string; type: string; subtype: string; pooled: boolean }>;
  proxies: Array<{
    id: string;
    address: string;
    countryCode: string | null;
    city: string | null;
    valid: boolean;
    holder: string | null;
    reservedFor: string | null;
    coolingUntil: string | null;
  }>;
  waitingEmails: string[];
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function ProxiesView() {
  const [report, setReport] = useState<PoolReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => {
    api<PoolReport>('/proxies').then(setReport).catch((reason) => setError((reason as Error).message));
  }, []);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  function sync() {
    setSyncing(true);
    setError(null);
    api<PoolReport>('/proxies/sync', { method: 'POST' })
      .then(setReport)
      .catch((reason) => setError((reason as Error).message))
      .finally(() => setSyncing(false));
  }

  if (!report) return <div className="admin-stack">{error ? <div className="banner banner-bad">{error}</div> : <p className="job-meta">Loading…</p>}</div>;

  const inCountry = (code: string | null) => Boolean(code && report.countries.includes(code.toUpperCase()));
  const free = report.proxies.filter((proxy) => !proxy.holder && !proxy.reservedFor && !proxy.coolingUntil && proxy.valid && inCountry(proxy.countryCode)).length;
  const held = report.proxies.filter((proxy) => proxy.holder).length;

  return (
    <div className="admin-stack">
      {!report.enabled ? (
        <div className="banner">Off. Add your Webshare API key under Config → Dedicated addresses, and every account with paid applications left is given its own static residential proxy.</div>
      ) : report.lastSyncError ? (
        <div className="banner banner-bad">Last sync failed: {report.lastSyncError}</div>
      ) : report.waitingEmails.length ? (
        <div className="banner banner-bad">
          {report.waitingEmails.length} paying account(s) have no proxy and apply from the server: {report.waitingEmails.join(', ')}. Buy more static residential proxies in {report.countries.join(', ')} on Webshare, then Sync.
        </div>
      ) : (
        <div className="banner banner-ok">Every paying account has its own address.</div>
      )}
      {error && <div className="banner banner-bad">{error}</div>}

      <section className="card admin-section">
        <div className="admin-button-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="job-meta" style={{ margin: 0 }}>
            {report.proxies.length} proxies · {held} given out · {free} free in {report.countries.join(', ')}
            {report.lastSyncAt ? ` · synced ${when(report.lastSyncAt)}` : ' · not synced yet'}
            {report.plans.length > 0 && (
              <span style={{ display: 'block' }}>
                Webshare plans: {report.plans.map((plan) => `#${plan.id} ${plan.type}/${plan.subtype} (${plan.pooled ? 'pooled' : 'not static residential, left out'})`).join(' · ')}
              </span>
            )}
          </p>
          <button className="btn primary" disabled={!report.enabled || syncing} onClick={sync}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Location</th>
                <th>Status</th>
                <th>Held by</th>
              </tr>
            </thead>
            <tbody>
              {report.proxies.map((proxy) => (
                <tr key={proxy.id}>
                  <td><code>{proxy.address}</code></td>
                  <td>{[proxy.city, proxy.countryCode].filter(Boolean).join(', ') || '—'}</td>
                  <td>
                    <span className={`badge ${proxy.valid ? 'ok' : 'warn'}`}>{proxy.valid ? 'Working' : 'Not working'}</span>
                  </td>
                  <td>
                    {proxy.holder
                      ? proxy.holder
                      : proxy.reservedFor
                        ? <span className="job-meta">Set by hand for {proxy.reservedFor}</span>
                        : proxy.coolingUntil
                          ? <span className="job-meta">Free from {when(proxy.coolingUntil)}</span>
                          : !inCountry(proxy.countryCode)
                            ? <span className="job-meta">Not given out: outside {report.countries.join(', ')}</span>
                            : <span className="job-meta">Free</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!report.proxies.length && <p className="job-meta admin-empty">{report.enabled ? 'No static residential proxies found on your Webshare account yet.' : 'The pool is off.'}</p>}
      </section>
    </div>
  );
}
