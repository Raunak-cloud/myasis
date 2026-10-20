import { useEffect, useState } from 'react';
import { api } from '../adminApi';
import { StackedTable } from './StackedTable';
import './VisitorsView.css';

interface Breakdown {
  label: string;
  sub: string | null;
  code: string | null;
  visitors: number;
  views: number;
  seconds: number | null;
}

interface RecentVisit {
  sessionId: string;
  visitorId: string;
  startedAt: string;
  endedAt: string;
  views: number;
  durationMs: number | null;
  pages: string[];
  ip: string | null;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  screen: string | null;
  language: string | null;
  timeZone: string | null;
  referrer: string | null;
  attributionSource: string | null;
  attributionMedium: string | null;
  attributionCampaign: string | null;
  email: string | null;
}

type VisitorRange = 'today' | '7d' | '30d' | '90d';
/** Visits from the country the product serves, or from everywhere else. */
type VisitorMarket = 'all' | 'home' | 'abroad';

interface VisitorReport {
  range: VisitorRange;
  market: VisitorMarket;
  home: { code: string; name: string };
  timeZone: string;
  retentionDays: number;
  geoConfigured: boolean;
  totals: {
    visitors: number;
    visits: number;
    views: number;
    signedIn: number;
    located: number;
    avgSeconds: number | null;
  };
  countries: Breakdown[];
  regions: Breakdown[];
  cities: Breakdown[];
  pages: Breakdown[];
  referrers: Breakdown[];
  devices: Breakdown[];
  browsers: Breakdown[];
  days: Array<{ day: string; visitors: number; views: number }>;
  addresses: {
    count: number;
    list: Array<{
      ip: string;
      city: string | null;
      region: string | null;
      country: string | null;
      visits: number;
      views: number;
      lastSeenAt: string;
    }>;
  };
  recent: RecentVisit[];
  /** The operators' own addresses: never recorded, and hidden from every report. */
  ignored: Array<{ ip: string; note: string | null; createdAt: string }>;
  /** Where this admin is browsing from right now. */
  yourAddress: string | null;
}

interface LiveVisitors {
  generatedAt: string;
  activeWithinSeconds: number;
  count: number;
  visitors: Array<{
    visitorId: string;
    page: string;
    email: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    device: string | null;
    browser: string | null;
    lastSeenAt: string;
  }>;
}
const RANGES: Record<VisitorRange, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};
const PAGES: Record<string, string> = {
  landing: 'Home',
  run: 'Apply',
  attention: 'Needs attention',
  applications: 'Applications',
  pricing: 'Pricing',
  setup: 'Settings',
  support: 'Support',
  admin: 'Admin',
};
const pageLabel = (page: string) => PAGES[page] ?? page;
const place = (row: {
  city: string | null;
  region: string | null;
  country: string | null;
}) =>
  [...new Set([row.city, row.region, row.country].filter(Boolean))].join(
    ', ',
  ) || 'Location unavailable';
function spent(ms: number | null): string {
  if (ms === null) return 'Not recorded';
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
const when = (iso: string, timeZone = 'Australia/Sydney') =>
  new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone,
  }).format(new Date(iso));

/** Abort on filter changes; stale responses cannot overwrite a newer report. */
function useReport<T>(path: string, interval: number) {
  const [state, setState] = useState<{
    data: T | null;
    error: string | null;
    updated: string | null;
  }>({ data: null, error: null, updated: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    setState({ data: null, error: null, updated: null });
    const load = async () => {
      if (document.visibilityState === 'hidden' || controller) return;
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 8_000);
      try {
        const data = await api<T>(path, {
          signal: request.signal,
          cache: 'no-store',
        });
        if (!disposed)
          setState({ data, error: null, updated: new Date().toISOString() });
      } catch (reason) {
        if (!disposed)
          setState((previous) => ({
            ...previous,
            error: request.signal.aborted
              ? 'Refresh timed out.'
              : (reason as Error).message,
          }));
      } finally {
        window.clearTimeout(timeout);
        controller = null;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), interval);
    const visibility = () => {
      if (document.visibilityState !== 'hidden') void load();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [path, interval, revision]);
  return { ...state, refresh: () => setRevision((value) => value + 1) };
}
function BreakdownList({ title, rows }: { title: string; rows: Breakdown[] }) {
  return (
    <section>
      <h4>{title}</h4>
      {rows.length ? (
        <ul className="visitor-breakdown">
          {rows.map((row, i) => (
            <li key={i}>
              <span>
                {title === 'Pages' ? pageLabel(row.label) : row.label}
                {row.sub && <small> · {row.sub}</small>}
              </span>
              <strong>{row.visitors}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="job-meta">No recorded data.</p>
      )}
    </section>
  );
}
export function VisitorsView() {
  const [range, setRange] = useState<VisitorRange>('7d');
  const [market, setMarket] = useState<VisitorMarket>('all');
  const report = useReport<VisitorReport>(
    `/visitors?range=${range}&market=${market}`,
    30_000,
  );
  const live = useReport<LiveVisitors>('/visitors/live', 10_000);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const data = report.data;
  const liveData = live.error ? null : live.data;
  const refresh = () => {
    report.refresh();
    live.refresh();
  };
  const ignore = async (ip: string, remove = false) => {
    setBusy(true);
    setActionError(null);
    try {
      await api(
        remove
          ? `/visitors/ignored/${encodeURIComponent(ip)}`
          : '/visitors/ignored',
        remove ? { method: 'DELETE' } : { method: 'POST', json: { ip } },
      );
      setAddress('');
      refresh();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-stack visitors-view">
      <section className="card admin-section table-wrap visitor-live">
        <div className="visitor-heading">
          <div>
            <h2>
              <span
                className={liveData ? 'visitor-dot' : 'visitor-dot offline'}
              />
              Live visitors{' '}
              <strong data-testid="live-count">
                {liveData ? liveData.count : '—'}
              </strong>
            </h2>
            <p className="job-meta">
              All countries · Admin accounts and recognised admin browsers
              excluded
            </p>
          </div>
          <button className="btn btn-small" onClick={refresh}>
            Refresh
          </button>
        </div>
        <p className="job-meta">
          Visible tabs reporting within the last{' '}
          {liveData?.activeWithinSeconds ?? 60} seconds. Updates every 10
          seconds. Multiple tabs count as one browser visitor. Locations are approximate.
        </p>
        {live.error ? (
          <p role="status" className="banner banner-bad">
            Live information unavailable. {live.error}
          </p>
        ) : !liveData ? (
          <p className="job-meta">Checking live visitors…</p>
        ) : liveData.visitors.length ? (
          <StackedTable>
            <thead>
              <tr>
                <th>Visitor</th>
                <th>Current page</th>
                <th>Location</th>
                <th>Device</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {liveData.visitors.map((visitor) => (
                <tr key={visitor.visitorId}>
                  <td>
                    {visitor.email ?? 'Anonymous'}
                    <small className="job-meta">
                      Browser {visitor.visitorId.slice(0, 8)}
                    </small>
                  </td>
                  <td>{pageLabel(visitor.page)}</td>
                  <td>{place(visitor)}</td>
                  <td>
                    {[visitor.browser, visitor.device]
                      .filter(Boolean)
                      .join(' · ') || 'Unknown'}
                  </td>
                  <td>{when(visitor.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </StackedTable>
        ) : (
          <p className="visitor-empty">No visitors live right now.</p>
        )}
        {liveData && (
          <p className="job-meta">
            Checked {when(liveData.generatedAt)} Sydney time
            {liveData.count > liveData.visitors.length
              ? ` · Showing the latest ${liveData.visitors.length}`
              : ''}
          </p>
        )}
      </section>
      <div className="queue-bar visitor-filters">
        <div className="chips" aria-label="Visitor reporting period">
          {(Object.keys(RANGES) as VisitorRange[]).map((key) => (
            <button
              key={key}
              className={`chip ${range === key ? 'on' : ''}`}
              onClick={() => setRange(key)}
            >
              {RANGES[key]}
            </button>
          ))}
        </div>
        <label>
          Location{' '}
          <select
            aria-label="Visitor location"
            className="input"
            value={market}
            onChange={(event) => setMarket(event.target.value as VisitorMarket)}
          >
            <option value="all">All countries</option>
            <option value="home">{data?.home.name ?? 'Australia'}</option>
            <option value="abroad">Other / unknown countries</option>
          </select>
        </label>
      </div>
      {report.error && (
        <p role="status" className="banner banner-bad">
          Could not refresh history. {report.error}
          {report.updated && ` Showing data from ${when(report.updated)}.`}
        </p>
      )}
      {actionError && (
        <p role="alert" className="banner banner-bad">
          {actionError}
        </p>
      )}
      {!data ? (
        !report.error && <p className="job-meta">Loading visitor history…</p>
      ) : (
        <>
          <div className="admin-tiles visitor-totals">
            {[
              ['Visitors', data.totals.visitors, 'Unique browser IDs'],
              ['Visits', data.totals.visits, 'Browser sessions'],
              [
                'Page views',
                data.totals.views,
                `${data.totals.signedIn} visitors signed in`,
              ],
              [
                'Avg visible time / page',
                spent(
                  data.totals.avgSeconds === null
                    ? null
                    : data.totals.avgSeconds * 1000,
                ),
                'Only pages with recorded time',
              ],
            ].map(([label, value, note]) => (
              <div className="card admin-tile" key={label}>
                <span className="job-meta">{label}</span>
                <strong>{value}</strong>
                <span className="job-meta">{note}</span>
              </div>
            ))}
          </div>
          <section className="card admin-section table-wrap">
            <h3>Recent visits</h3>
            <p className="job-meta">
              Latest {data.recent.length} browser sessions in this period. Times
              shown in {data.timeZone}. Locations are estimated from IP
              addresses.
            </p>
            {data.recent.length ? (
              <StackedTable>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Visitor</th>
                    <th>Location</th>
                    <th>Pages / details</th>
                    <th>Visible time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((visit) => (
                    <tr key={`${visit.visitorId}:${visit.sessionId}`}>
                      <td>{when(visit.startedAt, data.timeZone)}</td>
                      <td>
                        {visit.email ?? 'Anonymous'}
                        <small className="job-meta">
                          Browser {visit.visitorId.slice(0, 8)}
                        </small>
                      </td>
                      <td>{place(visit)}</td>
                      <td>
                        <details>
                          <summary>
                            {visit.views} {visit.views === 1 ? 'page' : 'pages'}{' '}
                            · {pageLabel(visit.pages.at(-1) ?? 'Unknown')}
                          </summary>
                          <p>{visit.pages.map(pageLabel).join(' → ')}</p>
                          <p className="job-meta">
                            {[
                              visit.browser,
                              visit.os,
                              visit.device,
                              visit.screen,
                              visit.language,
                              visit.timeZone,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                          <p className="job-meta">
                            Source:{' '}
                            {visit.attributionSource ??
                              visit.referrer ??
                              'Direct / unknown'}
                            {visit.attributionCampaign
                              ? ` · ${visit.attributionCampaign}`
                              : ''}
                          </p>
                          <p className="job-meta">
                            IP: {visit.ip ?? 'Unavailable'} · Last report:{' '}
                            {when(visit.endedAt, data.timeZone)}
                          </p>
                        </details>
                      </td>
                      <td>{spent(visit.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </StackedTable>
            ) : (
              <p className="visitor-empty">No visits in this period.</p>
            )}
          </section>
          <details className="card admin-section">
            <summary>Traffic breakdown</summary>
            <p className="job-meta">
              Unique browser visitors per category, up to 25 each. A visitor can
              appear in several categories. Sources without a referrer or
              campaign are unavailable.
            </p>
            <div className="visitor-breakdowns">
              <BreakdownList title="Pages" rows={data.pages} />
              <BreakdownList title="Countries" rows={data.countries} />
              <BreakdownList title="Sources" rows={data.referrers} />
              <BreakdownList title="Devices" rows={data.devices} />
            </div>
          </details>
          <details className="card admin-section table-wrap">
            <summary>Addresses and exclusions</summary>
            <p className="job-meta">
              {data.addresses.count} distinct IP addresses. Showing the latest{' '}
              {data.addresses.list.length}. Ignoring an address hides its
              history and stops new tracking for everyone using it.
            </p>
            {data.yourAddress && (
              <p className="job-meta">
                Your IP: {data.yourAddress}. Admin browsing is already excluded
                automatically.
              </p>
            )}
            <form
              className="admin-button-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (address.trim()) void ignore(address.trim());
              }}
            >
              <input
                className="input"
                aria-label="IP address to ignore"
                placeholder="IP address to ignore"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              <button
                className="btn btn-small"
                disabled={busy || !address.trim()}
              >
                Ignore address
              </button>
            </form>
            {!!data.ignored.length && (
              <ul className="admin-list">
                {data.ignored.map((row) => (
                  <li key={row.ip}>
                    <span>
                      {row.ip}
                      {row.note ? ` · ${row.note}` : ''}
                    </span>
                    <button
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => void ignore(row.ip, true)}
                    >
                      Stop ignoring
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!!data.addresses.list.length && (
              <StackedTable>
                <thead>
                  <tr>
                    <th>IP address</th>
                    <th>Location</th>
                    <th>Visits</th>
                    <th>Last seen</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.addresses.list.map((row) => (
                    <tr key={row.ip}>
                      <td>{row.ip}</td>
                      <td>{place(row)}</td>
                      <td>{row.visits}</td>
                      <td>{when(row.lastSeenAt, data.timeZone)}</td>
                      <td>
                        <button
                          className="btn btn-small"
                          disabled={busy}
                          onClick={() => void ignore(row.ip)}
                        >
                          Ignore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </StackedTable>
            )}
          </details>
          <p className="job-meta">
            History refreshed{' '}
            {report.updated ? when(report.updated, data.timeZone) : 'just now'}.
            Browser IDs are not a count of people; cleared storage and blocked
            tracking affect counts. Data kept for {data.retentionDays} days.{' '}
            {data.geoConfigured ? (
              <>
                Approximate location data:{' '}
                <a href="https://db-ip.com" target="_blank" rel="noreferrer">
                  DB-IP
                </a>
                .
              </>
            ) : (
              'Location lookup is unavailable.'
            )}
          </p>
        </>
      )}
    </div>
  );
}
