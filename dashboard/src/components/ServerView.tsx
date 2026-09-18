import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../adminApi';

/**
 * The machine, on one screen.
 *
 * Owning a single server means the questions are always the same: is it about
 * to run out of disk, is it about to run out of memory, is anything down, and
 * what has it been saying. This answers those four in that order, and puts the
 * console underneath so a problem and its explanation are on the same page.
 */

interface ServerHealth {
  at: string;
  hostUptimeSeconds: number;
  processUptimeSeconds: number;
  cpu: { cores: number; loadAverage: number[]; busyPercent: number | null };
  memory: { totalMb: number; usedMb: number; availableMb: number; percent: number };
  swap: { totalMb: number; usedMb: number; percent: number };
  disk: { totalGb: number; usedGb: number; freeGb: number; percent: number };
  storage: {
    databaseMb: number;
    userDataMb: number;
    chromeMb: number;
    tracesMb: number;
    otherMb: number;
    perUser: Array<{ userId: string; totalMb: number; chromeMb: number; tracesMb: number }>;
    measuredAt: string | null;
    measuring: boolean;
  };
  runs: { active: number; capacity: number };
  traceRetentionDays: number;
  services: Array<{ name: string; ok: boolean; detail: string }>;
  topProcesses: Array<{ pid: number; name: string; rssMb: number }>;
}

interface PruneResult {
  profiles: { freedBytes: number; pruned: number; skipped: number };
  traces: { freedBytes: number; removed: number; kept: number };
  traceRetentionDays: number;
}

interface ServerLog {
  stream: 'out' | 'error';
  text: string;
}

const HEALTH_INTERVAL = 5_000;
const LOG_INTERVAL = 4_000;

function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Green until it matters, amber when it is worth planning for, red when it
 * needs doing today. The thresholds are the same for every meter so the
 * colour means one thing across the page.
 */
function level(percent: number): 'ok' | 'warn' | 'bad' {
  if (percent >= 90) return 'bad';
  if (percent >= 75) return 'warn';
  return 'ok';
}

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const tone = level(percent);
  return (
    <div className={`server-meter tone-${tone}`}>
      <div className="server-meter-head">
        <span>{label}</span>
        <strong>{Math.round(percent)}%</strong>
      </div>
      <div className="server-meter-track">
        <span style={{ width: `${Math.max(1, Math.min(100, percent))}%` }} />
      </div>
      <span className="job-meta">{detail}</span>
    </div>
  );
}

// ------------------------------------------------------------------ console

/**
 * The server's console, refreshed on a timer.
 *
 * It follows the newest line unless the operator has scrolled up, because
 * scrolling up is how you read something that already happened and yanking
 * the view back to the bottom every few seconds makes that impossible.
 */
function Console() {
  const [lines, setLines] = useState<ServerLog[] | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [following, setFollowing] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const body = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api<{ lines: ServerLog[] }>('/health/logs?lines=400')
        .then((result) => {
          if (cancelled) return;
          setLines(result.lines);
          setFailure(null);
        })
        .catch((reason) => !cancelled && setFailure((reason as Error).message));
    };
    load();
    const id = window.setInterval(load, LOG_INTERVAL);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const shown = useMemo(() => (lines ?? []).filter((line) => !errorsOnly || line.stream === 'error'), [lines, errorsOnly]);

  useEffect(() => {
    if (following && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [shown, following]);

  const onScroll = () => {
    const element = body.current;
    if (!element) return;
    // A small tolerance, so "at the bottom" survives fractional scroll heights.
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
  };

  return (
    <section className="card server-console">
      <div className="queue-bar">
        <div>
          <h3>Server console</h3>
          <p className="job-meta">Everything the dashboard has printed, newest at the bottom.</p>
        </div>
        <div className="chips">
          <button className={`chip ${errorsOnly ? 'on' : ''}`} onClick={() => setErrorsOnly((value) => !value)}>
            Errors only
          </button>
          <button className={`chip ${following ? 'on' : ''}`} onClick={() => setFollowing((value) => !value)}>
            {following ? 'Following' : 'Paused'}
          </button>
        </div>
      </div>
      {failure && <div className="banner banner-bad">{failure}</div>}
      <pre className="server-log" ref={body} onScroll={onScroll} tabIndex={0}>
        {lines === null
          ? 'Loading…'
          : shown.length === 0
            ? errorsOnly ? 'No errors in the recent log.' : 'The log is empty.'
            : shown.map((line, index) => (
                <span key={index} className={line.stream === 'error' ? 'log-error' : undefined}>
                  {line.text}
                  {'\n'}
                </span>
              ))}
      </pre>
    </section>
  );
}

// ------------------------------------------------------------------ the page

export function ServerView() {
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ServerHealth>('/health')
      .then((result) => {
        setHealth(result);
        setError(null);
      })
      .catch((reason) => setError((reason as Error).message));
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, HEALTH_INTERVAL);
    return () => window.clearInterval(id);
  }, [load]);

  const prune = async () => {
    setPruning(true);
    setPruneResult(null);
    try {
      const result = await api<PruneResult>('/health/prune', { method: 'POST' });
      const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
      const said: string[] = [];
      if (result.profiles.pruned > 0) {
        said.push(`freed ${mb(result.profiles.freedBytes)} MB of browser cache from ${result.profiles.pruned} profile${result.profiles.pruned === 1 ? '' : 's'}`);
      }
      if (result.traces.removed > 0) {
        said.push(`removed ${result.traces.removed} trace${result.traces.removed === 1 ? '' : 's'} worth ${mb(result.traces.freedBytes)} MB`);
      }
      setPruneResult(
        said.length === 0
          ? 'Nothing to clean: every profile was in use and no trace is old enough yet.'
          : `Cleanup ${said.join(' and ')}.${result.profiles.skipped ? ` ${result.profiles.skipped} profile(s) in use.` : ''}`,
      );
      load();
    } catch (reason) {
      setPruneResult((reason as Error).message);
    } finally {
      setPruning(false);
    }
  };

  if (!health) {
    return <div className="admin-stack">{error ? <div className="banner banner-bad">{error}</div> : <p className="job-meta">Loading…</p>}</div>;
  }

  const { cpu, memory, swap, disk, storage, runs } = health;
  /**
   * Load average against cores is the honest measure of whether work is
   * queueing: one core fully busy is 1.0, and anything above the core count
   * means jobs are waiting for a turn.
   */
  const loadPercent = cpu.cores ? (cpu.loadAverage[0] / cpu.cores) * 100 : 0;
  const down = health.services.filter((service) => !service.ok);

  /** How long the disk lasts if it keeps filling at the rate the data implies. */
  const daysOfDisk = storage.userDataMb > 0 && storage.perUser.length > 0
    ? Math.round((disk.freeGb * 1024) / Math.max(1, storage.userDataMb / storage.perUser.length))
    : null;

  const tiles = [
    { label: 'Disk free', value: `${disk.freeGb} GB`, note: `of ${disk.totalGb} GB, ${disk.percent}% used` },
    { label: 'Memory free', value: gb(memory.availableMb), note: `of ${gb(memory.totalMb)}` },
    { label: 'Runs', value: `${runs.active} / ${runs.capacity}`, note: runs.active >= runs.capacity ? 'at capacity' : 'slots free' },
    { label: 'CPU', value: cpu.busyPercent === null ? '-' : `${cpu.busyPercent}%`, note: `${cpu.cores} cores, load ${cpu.loadAverage[0].toFixed(2)}` },
    { label: 'Uptime', value: duration(health.hostUptimeSeconds), note: `app running ${duration(health.processUptimeSeconds)}` },
  ];

  return (
    <div className="admin-stack">
      {error && <div className="banner banner-bad">{error}</div>}
      {down.length > 0 && (
        <div className="banner banner-bad">
          {down.map((service) => `${service.name}: ${service.detail}`).join(' · ')}
        </div>
      )}

      <div className="admin-tiles">
        {tiles.map((tile) => (
          <div className="card admin-tile" key={tile.label}>
            <span className="job-meta">{tile.label}</span>
            <strong>{tile.value}</strong>
            <span className="job-meta">{tile.note}</span>
          </div>
        ))}
      </div>

      <section className="card server-meters">
        <Meter label="Disk" percent={disk.percent} detail={`${disk.usedGb} GB used · ${disk.freeGb} GB free`} />
        <Meter label="Memory" percent={memory.percent} detail={`${gb(memory.usedMb)} used · ${gb(memory.availableMb)} available`} />
        <Meter
          label="CPU load"
          percent={Math.min(100, loadPercent)}
          detail={`1m ${cpu.loadAverage[0].toFixed(2)} · 5m ${cpu.loadAverage[1].toFixed(2)} · 15m ${cpu.loadAverage[2].toFixed(2)} across ${cpu.cores} cores`}
        />
        {swap.totalMb > 0 && <Meter label="Swap" percent={swap.percent} detail={`${gb(swap.usedMb)} of ${gb(swap.totalMb)}`} />}
      </section>

      <section className="card admin-section">
        <h3>Services</h3>
        <ul className="server-services">
          {health.services.map((service) => (
            <li key={service.name}>
              <span className={`server-dot ${service.ok ? 'ok' : 'bad'}`} aria-hidden="true" />
              <strong>{service.name}</strong>
              <span className="job-meta">{service.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card admin-section">
        <div className="queue-bar">
          <div>
            <h3>What is using the disk</h3>
            <p className="job-meta">
              {storage.measuredAt
                ? `Measured ${new Date(storage.measuredAt).toLocaleTimeString()}. Walking every account takes a while, so this is refreshed every half hour.`
                : 'Measuring for the first time; this appears within a minute of the server starting.'}
            </p>
          </div>
          <button className="btn btn-small" onClick={prune} disabled={pruning}>
            {pruning ? 'Cleaning…' : 'Free up disk now'}
          </button>
        </div>
        {pruneResult && <div className="banner">{pruneResult}</div>}
        <div className="admin-tiles">
          {[
            { label: 'Database', value: gb(storage.databaseMb), note: 'Postgres, all tables' },
            { label: 'Browser profiles', value: gb(storage.chromeMb), note: 'cleaned daily' },
            { label: 'Run traces', value: gb(storage.tracesMb), note: `kept ${health.traceRetentionDays} days` },
            { label: 'Other account data', value: gb(storage.otherMb), note: 'résumés, logs, knowledge' },
          ].map((tile) => (
            <div className="admin-tile server-storage-tile" key={tile.label}>
              <span className="job-meta">{tile.label}</span>
              <strong>{tile.value}</strong>
              <span className="job-meta">{tile.note}</span>
            </div>
          ))}
        </div>
        {daysOfDisk !== null && (
          <p className="job-meta">
            At {gb(Math.round(storage.userDataMb / Math.max(1, storage.perUser.length)))} per account, the free space holds
            about {daysOfDisk} more accounts' worth of data.
          </p>
        )}
        {storage.perUser.length > 0 && (
          <div className="table-wrap">
            <table className="server-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Total</th>
                  <th>Browser profile</th>
                  <th>Traces</th>
                </tr>
              </thead>
              <tbody>
                {storage.perUser.map((row) => (
                  <tr key={row.userId}>
                    <td>#{row.userId}</td>
                    <td>{gb(row.totalMb)}</td>
                    <td>{gb(row.chromeMb)}</td>
                    <td>{gb(row.tracesMb)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card admin-section">
        <h3>Heaviest processes</h3>
        <ul className="server-services">
          {health.topProcesses.map((process) => (
            <li key={process.name}>
              <strong>{process.name}</strong>
              <span className="job-meta">{gb(process.rssMb)} of memory</span>
            </li>
          ))}
        </ul>
      </section>

      <Console />
    </div>
  );
}
