import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PAID_PLANS, aud } from '../pricing';

/**
 * The operator's dashboard: the whole installation at a glance, every
 * account with its controls, and every run with its console.
 *
 * Everything here is served by /api/admin, which refuses anyone who is not
 * an admin on every request; this page only decides what to show.
 */

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  admin: boolean;
  plan: string;
  allowance: { freeRemaining: number; paidRemaining: number; paidExpiresAt: string | null };
  setupMissing: string[];
  resumes: number;
  boards: { seek: boolean | null; indeed: boolean | null };
  autoApply: { runsPerDay: number; usedToday: number; paused: boolean; canPause: boolean };
  overrides: { evaluationsPerRun: number | null; maxApplicationsPerRun: number | null };
  manualRunsToday: number;
  applications: { total: number; week: number; today: number };
  lastRun: { startedAt: string; finishedAt: string | null; exitCode: number | null; trigger: string } | null;
  running: boolean;
  signingIn: boolean;
}

interface AdminRun {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  mode: string;
  trigger: string;
  startedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  applied: number | null;
  hasLog: boolean;
  running: boolean;
}

interface Overview {
  users: { total: number; newThisWeek: number; activeThisWeek: number };
  passes: { jobSearch: number; intensive: number };
  today: { runs: number; applications: number; failedRuns: number };
  week: { applications: number };
  revenueCents: { last30Days: number; total: number };
  capacity: { running: number; lanes: number };
  recentRuns: AdminRun[];
}

interface UserDetail extends AdminUser {
  passes: Array<{
    id: string;
    plan: string;
    amountPaidCents: number;
    granted: boolean;
    paidAt: string;
    applications: { total: number; used: number };
    expiresAt: string;
    active: boolean;
  }>;
  runs: AdminRun[];
  recentApplications: Array<{ jobId: string; title: string; company: string; platform: string; external: boolean; appliedAt: string }>;
}

interface LogLine {
  seq?: number;
  ts: string;
  stream: string;
  text: string;
}

const TIME_ZONE = 'Australia/Sydney';
const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE }).format(new Date(iso)) : '—';
const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: TIME_ZONE }).format(new Date(iso));

function duration(run: AdminRun): string {
  // Runs from before finish times were recorded have no end to measure to.
  if (!run.finishedAt && !run.running) return '—';
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function runStatus(run: AdminRun): { label: string; tone: string } {
  if (run.running) return { label: 'Running', tone: 'info' };
  if (!run.finishedAt) return { label: 'Not recorded', tone: 'muted' };
  if (run.exitCode === 0) return { label: 'Finished', tone: 'ok' };
  if (run.exitCode === null) return { label: 'Stopped', tone: 'warn' };
  return { label: `Failed (exit ${run.exitCode})`, tone: 'bad' };
}

const TRIGGER_LABEL: Record<string, string> = { manual: 'By the user', auto: 'Scheduled', admin: 'By an admin' };

async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
  return body as T;
}

// ------------------------------------------------------------------ run console
function RunLog({ run, onClose }: { run: AdminRun; onClose: () => void }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    api<{ lines: LogLine[]; live: boolean; userId: string }>(`/runs/${run.id}/log`)
      .then((log) => {
        if (cancelled) return;
        setLines(log.lines);
        setLive(log.live);
        if (log.live) {
          // Follow a run still going: the stream replays its console, then keeps it coming.
          setLines([]);
          source = new EventSource(`/api/admin/users/${log.userId}/stream`);
          source.onmessage = (event) => {
            const line = JSON.parse(event.data) as LogLine;
            setLines((current) => [...current.slice(-4000), line]);
          };
        }
      })
      .catch((reason) => setError((reason as Error).message));
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [run.id]);

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [lines]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card admin-log" role="dialog" aria-modal="true" aria-label="Run console" onClick={(event) => event.stopPropagation()}>
        <div className="admin-log-head">
          <div>
            <h2>{run.name || run.email}</h2>
            <p className="job-meta">
              {when(run.startedAt)} · {TRIGGER_LABEL[run.trigger] ?? run.trigger}{run.startedBy ? ` (${run.startedBy})` : ''} · {duration(run)}
              {live ? ' · live' : ''}
            </p>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        {error && <div className="banner banner-bad">{error}</div>}
        <pre ref={body} className="admin-log-body">
          {lines.length
            ? lines.map((line, index) => (
                <span key={`${line.seq ?? index}-${index}`} className={`admin-log-line ${line.stream}`}>
                  <time>{clock(line.ts)}</time> {line.text}
                  {'\n'}
                </span>
              ))
            : error ? '' : 'No console was saved for this run.'}
        </pre>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ runs table
function RunsTable({ runs, onOpen, showUser = true }: { runs: AdminRun[]; onOpen: (run: AdminRun) => void; showUser?: boolean }) {
  if (!runs.length) return <p className="job-meta admin-empty">No runs yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {showUser && <th>Account</th>}
            <th>Started</th>
            <th>How</th>
            <th>Took</th>
            <th>Applied</th>
            <th>Result</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const status = runStatus(run);
            return (
              <tr key={run.id}>
                {showUser && (
                  <td>
                    <div className="job-title">{run.name || run.email}</div>
                    {run.name && <div className="job-meta">{run.email}</div>}
                  </td>
                )}
                <td className="nowrap">{when(run.startedAt)}</td>
                <td>
                  {run.mode === 'scan' ? 'Queue scan' : TRIGGER_LABEL[run.trigger] ?? run.trigger}
                  {run.startedBy && <div className="job-meta">{run.startedBy}</div>}
                </td>
                <td className="nowrap">{duration(run)}</td>
                <td>{run.applied ?? '—'}</td>
                <td><span className={`badge ${status.tone}`}>{status.label}</span></td>
                <td className="nowrap">
                  {(run.hasLog || run.running) && (
                    <button className="btn btn-small" onClick={() => onOpen(run)}>{run.running ? 'Watch' : 'Console'}</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ overview
function OverviewView({ onOpenRun }: { onOpenRun: (run: AdminRun) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Overview>('/overview').then(setData).catch((reason) => setError((reason as Error).message));
  }, []);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (error) return <div className="banner banner-bad">{error}</div>;
  if (!data) return <p className="job-meta">Loading…</p>;
  const tiles = [
    { label: 'Accounts', value: data.users.total, note: `${data.users.newThisWeek} new · ${data.users.activeThisWeek} signed in this week` },
    { label: 'Active passes', value: data.passes.jobSearch + data.passes.intensive, note: `${data.passes.jobSearch} Job Search · ${data.passes.intensive} Intensive` },
    { label: 'Running now', value: `${data.capacity.running} of ${data.capacity.lanes}`, note: 'browser lanes in use' },
    { label: 'Runs today', value: data.today.runs, note: data.today.failedRuns ? `${data.today.failedRuns} failed` : 'none failed' },
    { label: 'Applications', value: data.today.applications, note: `today · ${data.week.applications} this week` },
    { label: 'Revenue', value: aud(data.revenueCents.last30Days), note: `last 30 days · ${aud(data.revenueCents.total)} all time` },
  ];
  const running = data.recentRuns.filter((run) => run.running);
  return (
    <div className="admin-stack">
      <div className="admin-tiles">
        {tiles.map((tile) => (
          <div className="card admin-tile" key={tile.label}>
            <span className="job-meta">{tile.label}</span>
            <strong>{tile.value}</strong>
            <span className={`job-meta${tile.label === 'Runs today' && data.today.failedRuns ? ' admin-bad' : ''}`}>{tile.note}</span>
          </div>
        ))}
      </div>
      <section className="card admin-section">
        <h3>Running now</h3>
        <RunsTable runs={running} onOpen={onOpenRun} />
      </section>
      <section className="card admin-section">
        <h3>Recent runs</h3>
        <RunsTable runs={data.recentRuns.slice(0, 15)} onOpen={onOpenRun} />
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ one account
function UserDrawer({ userId, onClose, onChanged, onOpenRun }: {
  userId: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenRun: (run: AdminRun) => void;
}) {
  const [user, setUser] = useState<UserDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [grantPlan, setGrantPlan] = useState<string>('job-search-pass');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [evaluationsInput, setEvaluationsInput] = useState('');
  const [maxAppsInput, setMaxAppsInput] = useState('');

  const load = useCallback(() => {
    api<UserDetail>(`/users/${userId}`).then(setUser).catch((reason) => setError((reason as Error).message));
  }, [userId]);
  useEffect(load, [load]);
  // Reflects the server's own numbers, including after a save is clamped to
  // the platform ceiling — not just what was typed.
  useEffect(() => {
    setEvaluationsInput(user?.overrides.evaluationsPerRun != null ? String(user.overrides.evaluationsPerRun) : '');
    setMaxAppsInput(user?.overrides.maxApplicationsPerRun != null ? String(user.overrides.maxApplicationsPerRun) : '');
  }, [user]);

  function saveLimits() {
    const parse = (raw: string): number | null | 'invalid' => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 'invalid';
    };
    const evaluationsPerRun = parse(evaluationsInput);
    const maxApplicationsPerRun = parse(maxAppsInput);
    if (evaluationsPerRun === 'invalid' || maxApplicationsPerRun === 'invalid') {
      setError('Limits must be a positive number, or left blank to use the plan default.');
      return;
    }
    void act(
      'limits',
      `/users/${user!.id}/limits`,
      { method: 'POST', json: { evaluationsPerRun, maxApplicationsPerRun } },
      'Limits saved.',
    );
  }

  async function act(label: string, path: string, init: RequestInit & { json?: unknown }, done: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await api(path, init);
      setNotice(done);
      load();
      onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer admin-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div className="minw">
            <h2>{user?.name || user?.email || 'Account'}</h2>
            {user && (
              <div className="job-meta">
                {user.email} · joined {when(user.createdAt)} · last signed in {when(user.lastLoginAt)}
              </div>
            )}
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        <div className="drawer-body">
          {error && <div className="banner banner-bad" role="alert">{error}</div>}
          {notice && <div className="banner" role="status">{notice}</div>}
          {!user ? (
            !error && <p className="job-meta">Loading…</p>
          ) : (
            <>
              <div className="section admin-badges">
                {user.admin && <span className="badge info">Admin</span>}
                <span className="badge muted">{user.plan}</span>
                {user.running && <span className="badge info">Running</span>}
                {user.signingIn && <span className="badge warn">Signing in</span>}
                {user.setupMissing.length ? <span className="badge warn">Setup: {user.setupMissing.length} steps left</span> : <span className="badge ok">Set up</span>}
              </div>

              <div className="section">
                <h3>Status</h3>
                <dl className="admin-facts">
                  <dt>Applications left</dt>
                  <dd>
                    {user.admin ? 'Unlimited' : `${user.allowance.freeRemaining} free · ${user.allowance.paidRemaining} paid`}
                    {user.allowance.paidExpiresAt && <span className="job-meta"> (paid until {when(user.allowance.paidExpiresAt)})</span>}
                  </dd>
                  <dt>Applications sent</dt>
                  <dd>{user.applications.total} total · {user.applications.week} this week · {user.applications.today} today</dd>
                  <dt>Job boards</dt>
                  <dd>
                    SEEK {user.boards.seek === true ? 'signed in' : user.boards.seek === false ? 'signed out' : 'not checked'} ·
                    {' '}Indeed {user.boards.indeed === true ? 'signed in' : user.boards.indeed === false ? 'signed out' : 'not checked'}
                  </dd>
                  <dt>Résumés</dt>
                  <dd>{user.resumes}</dd>
                  <dt>Runs today</dt>
                  <dd>{user.autoApply.usedToday} scheduled · {user.manualRunsToday} by the user</dd>
                  {user.setupMissing.length > 0 && (
                    <>
                      <dt>Setup still needed</dt>
                      <dd>{user.setupMissing.join(', ')}</dd>
                    </>
                  )}
                </dl>
              </div>

              <div className="section">
                <h3>Controls</h3>
                <div className="admin-controls">
                  {user.autoApply.runsPerDay > 0 && (
                    <label className="admin-switch-row">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!user.autoApply.paused}
                        className={`auto-switch${user.autoApply.paused ? '' : ' on'}`}
                        disabled={busy !== null}
                        onClick={() => act('auto', `/users/${user.id}/auto-apply`, { method: 'POST', json: { enabled: user.autoApply.paused } }, user.autoApply.paused ? 'Automatic runs switched on.' : 'Automatic runs switched off.')}
                      >
                        <span className="auto-switch-knob" aria-hidden="true" />
                      </button>
                      <span>Auto apply {user.autoApply.paused ? 'off' : `on · ${user.autoApply.runsPerDay} ${user.autoApply.runsPerDay === 1 ? 'run' : 'runs'} a day`}</span>
                    </label>
                  )}
                  <div className="admin-button-row">
                    {user.running ? (
                      <button
                        className="btn btn-danger"
                        disabled={busy !== null}
                        onClick={() => window.confirm(`Stop the run for ${user.email}? Anything already submitted stays submitted.`)
                          && act('stop', `/users/${user.id}/stop`, { method: 'POST', json: {} }, 'Stop requested.')}
                      >
                        Stop run
                      </button>
                    ) : (
                      <button
                        className="btn primary"
                        disabled={busy !== null}
                        onClick={() => window.confirm(`Start a live run for ${user.email}? It submits real applications under their plan.`)
                          && act('run', `/users/${user.id}/run`, { method: 'POST', json: {} }, 'Run started.')}
                      >
                        {busy === 'run' ? 'Starting…' : 'Start run'}
                      </button>
                    )}
                    <button
                      className="btn"
                      disabled={busy !== null}
                      onClick={() => window.confirm(`Sign ${user.email} out of every device?`)
                        && act('sign-out', `/users/${user.id}/sign-out`, { method: 'POST', json: {} }, 'Signed out everywhere.')}
                    >
                      Sign out everywhere
                    </button>
                    <button
                      className="btn"
                      disabled={busy !== null}
                      onClick={() => window.confirm(user.admin ? `Remove admin access for ${user.email}?` : `Make ${user.email} an admin? Admins control every account.`)
                        && act('admin', `/users/${user.id}/admin`, { method: 'POST', json: { admin: !user.admin } }, user.admin ? 'Admin access removed.' : 'Admin access given.')}
                    >
                      {user.admin ? 'Remove admin' : 'Make admin'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="section">
                <h3>Limits</h3>
                <p className="job-meta">Overrides {user.plan}'s own numbers for this account, for cost control or a one-off case. Leave a field blank to go back to the plan default.</p>
                <div className="admin-controls">
                  <label className="admin-switch-row">
                    <span>Jobs reviewed per run</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      placeholder="Plan default"
                      value={evaluationsInput}
                      onChange={(event) => setEvaluationsInput(event.target.value)}
                    />
                  </label>
                  <label className="admin-switch-row">
                    <span>Applications per run</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      placeholder="Plan default"
                      value={maxAppsInput}
                      onChange={(event) => setMaxAppsInput(event.target.value)}
                    />
                  </label>
                  <div className="admin-button-row">
                    <button className="btn primary" disabled={busy !== null} onClick={saveLimits}>
                      {busy === 'limits' ? 'Saving…' : 'Save limits'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="section">
                <h3>Passes</h3>
                {user.passes.length ? (
                  <ul className="admin-list">
                    {user.passes.map((pass) => (
                      <li key={pass.id}>
                        <div>
                          <strong>{pass.plan}</strong> {pass.granted ? <span className="badge muted">Given by admin</span> : <span className="job-meta">{aud(pass.amountPaidCents)}</span>}
                          <div className="job-meta">
                            {pass.applications.used} of {pass.applications.total} used · {pass.active ? `until ${when(pass.expiresAt)}` : `ended ${when(pass.expiresAt)}`}
                          </div>
                        </div>
                        <span className={`badge ${pass.active ? 'ok' : 'muted'}`}>{pass.active ? 'Active' : 'Ended'}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="job-meta">No passes.</p>
                )}
                <div className="admin-button-row">
                  <select className="input" value={grantPlan} onChange={(event) => setGrantPlan(event.target.value)} aria-label="Pass to give">
                    {Object.values(PAID_PLANS).map((plan) => (
                      <option key={plan.key} value={plan.key}>{plan.name} · {plan.applications} applications</option>
                    ))}
                  </select>
                  <button
                    className="btn"
                    disabled={busy !== null}
                    onClick={() => window.confirm(`Give ${user.email} a free ${PAID_PLANS[grantPlan as keyof typeof PAID_PLANS]?.name}?`)
                      && act('grant', `/users/${user.id}/grant`, { method: 'POST', json: { plan: grantPlan } }, 'Pass given.')}
                  >
                    Give pass
                  </button>
                  {user.passes.some((pass) => pass.active) && (
                    <button
                      className="btn btn-danger"
                      disabled={busy !== null}
                      onClick={() => window.confirm(`End every active pass for ${user.email} now? Their unused paid applications are lost.`)
                        && act('end', `/users/${user.id}/end-passes`, { method: 'POST', json: {} }, 'Active passes ended.')}
                    >
                      End active passes
                    </button>
                  )}
                </div>
              </div>

              <div className="section">
                <h3>Runs</h3>
                <RunsTable runs={user.runs} onOpen={onOpenRun} showUser={false} />
              </div>

              <div className="section">
                <h3>Latest applications</h3>
                {user.recentApplications.length ? (
                  <ul className="admin-list">
                    {user.recentApplications.map((app) => (
                      <li key={app.jobId}>
                        <div>
                          <strong>{app.title}</strong>
                          <div className="job-meta">{app.company} · {app.platform === 'indeed' ? 'Indeed' : 'SEEK'}{app.external ? ' · employer site' : ''}</div>
                        </div>
                        <span className="job-meta nowrap">{when(app.appliedAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="job-meta">None yet.</p>
                )}
              </div>

              {!user.admin && (
                <div className="section admin-danger">
                  <h3>Delete account</h3>
                  <p className="job-meta">Removes the account, its profile, runs and applications. Its files are moved aside on the server. This cannot be undone here.</p>
                  <div className="admin-button-row">
                    <input
                      className="input"
                      placeholder={`Type ${user.email} to confirm`}
                      value={confirmEmail}
                      onChange={(event) => setConfirmEmail(event.target.value)}
                    />
                    <button
                      className="btn btn-danger-solid"
                      disabled={busy !== null || confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()}
                      onClick={async () => {
                        setBusy('delete');
                        setError(null);
                        try {
                          await api(`/users/${user.id}`, { method: 'DELETE', json: { confirmEmail } });
                          onChanged();
                          onClose();
                        } catch (reason) {
                          setError((reason as Error).message);
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Delete account
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ all accounts
type UserFilter = 'all' | 'running' | 'paid' | 'free' | 'admin' | 'setup' | 'paused';

function UsersView({ onOpenRun }: { onOpenRun: (run: AdminRun) => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<UserFilter>('all');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api<AdminUser[]>('/users').then(setUsers).catch((reason) => setError((reason as Error).message));
  }, []);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const matches: Record<UserFilter, (user: AdminUser) => boolean> = {
    all: () => true,
    running: (user) => user.running,
    paid: (user) => user.plan === 'Job Search Pass' || user.plan === 'Intensive Pass',
    free: (user) => user.plan === 'Free',
    admin: (user) => user.admin,
    setup: (user) => user.setupMissing.length > 0,
    paused: (user) => user.autoApply.paused,
  };
  const labels: Record<UserFilter, string> = {
    all: 'All', running: 'Running', paid: 'Paid', free: 'Free', admin: 'Admins', setup: 'Not set up', paused: 'Auto apply off',
  };
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users ?? []).filter(matches[filter]).filter((user) => !q || user.email.toLowerCase().includes(q) || (user.name ?? '').toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, search, filter]);

  if (error) return <div className="banner banner-bad">{error}</div>;
  if (!users) return <p className="job-meta">Loading…</p>;

  return (
    <div className="admin-stack">
      <div className="queue-bar">
        <div className="chips">
          {(Object.keys(labels) as UserFilter[]).map((key) => (
            <button key={key} className={`chip ${filter === key ? 'on' : ''}`} onClick={() => setFilter(key)}>
              {labels[key]} <span className="chip-hint">{users.filter(matches[key]).length}</span>
            </button>
          ))}
        </div>
        <input className="input" placeholder="Search name or email" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Plan</th>
              <th>Setup</th>
              <th>Boards</th>
              <th>Auto apply</th>
              <th>Applications</th>
              <th>Last run</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((user) => {
              const last = user.lastRun;
              return (
                <tr key={user.id} className="clickable" onClick={() => setOpen(user.id)}>
                  <td>
                    <div className="job-title">
                      {user.name || user.email} {user.admin && <span className="badge info">Admin</span>} {user.running && <span className="badge info">Running</span>}
                    </div>
                    <div className="job-meta">{user.email}</div>
                  </td>
                  <td>
                    {user.plan}
                    {!user.admin && <div className="job-meta">{user.allowance.freeRemaining + Math.max(0, user.allowance.paidRemaining)} left</div>}
                  </td>
                  <td>{user.setupMissing.length ? <span className="badge warn">{user.setupMissing.length} left</span> : <span className="badge ok">Done</span>}</td>
                  <td className="nowrap">
                    <span className={`admin-board ${user.boards.seek ? 'on' : ''}`}>SEEK</span>{' '}
                    <span className={`admin-board ${user.boards.indeed ? 'on' : ''}`}>Indeed</span>
                  </td>
                  <td className="nowrap">
                    {user.autoApply.runsPerDay === 0 ? <span className="job-meta">None</span>
                      : user.autoApply.paused ? <span className="badge muted">Off</span>
                      : `${user.autoApply.usedToday} of ${user.autoApply.runsPerDay}`}
                  </td>
                  <td>{user.applications.total}<div className="job-meta">{user.applications.today} today</div></td>
                  <td className="nowrap">
                    {last ? when(last.startedAt) : '—'}
                    {last && (
                      <div className="job-meta">
                        {user.running ? 'running' : !last.finishedAt ? '—' : last.exitCode === 0 ? 'finished' : last.exitCode === null ? 'stopped' : 'failed'}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="job-meta admin-empty">No accounts match.</p>}
      </div>
      {open && <UserDrawer userId={open} onClose={() => setOpen(null)} onChanged={load} onOpenRun={onOpenRun} />}
    </div>
  );
}

// ------------------------------------------------------------------ every run
function RunsView({ onOpenRun }: { onOpenRun: (run: AdminRun) => void }) {
  const [runs, setRuns] = useState<AdminRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'all' | 'running' | 'failed'>('all');
  const [account, setAccount] = useState('');

  const load = useCallback(() => {
    api<AdminRun[]>('/runs?limit=300').then(setRuns).catch((reason) => setError((reason as Error).message));
  }, []);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 15_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (error) return <div className="banner banner-bad">{error}</div>;
  if (!runs) return <p className="job-meta">Loading…</p>;
  const accounts = [...new Map(runs.map((run) => [run.userId, run.name || run.email])).entries()];
  const shown = runs
    .filter((run) => !account || run.userId === account)
    .filter((run) => status === 'all' || (status === 'running' ? run.running : run.finishedAt && run.exitCode !== 0 && run.exitCode !== null));

  return (
    <div className="admin-stack">
      <div className="queue-bar">
        <div className="chips">
          {(['all', 'running', 'failed'] as const).map((key) => (
            <button key={key} className={`chip ${status === key ? 'on' : ''}`} onClick={() => setStatus(key)}>
              {key === 'all' ? 'All' : key === 'running' ? 'Running' : 'Failed'}
            </button>
          ))}
        </div>
        <select className="input" value={account} onChange={(event) => setAccount(event.target.value)} aria-label="Account">
          <option value="">Every account</option>
          {accounts.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
      <div className="card">
        <RunsTable runs={shown} onOpen={onOpenRun} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ visitors
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
  visitNumber: number;
  startedAt: string;
  endedAt: string;
  views: number;
  durationMs: number;
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
  email: string | null;
}

type VisitorRange = 'today' | '7d' | '30d' | '90d';

interface VisitorReport {
  range: VisitorRange;
  timeZone: string;
  retentionDays: number;
  geoConfigured: boolean;
  totals: { visitors: number; visits: number; views: number; signedIn: number; located: number; avgSeconds: number | null };
  countries: Breakdown[];
  regions: Breakdown[];
  cities: Breakdown[];
  pages: Breakdown[];
  referrers: Breakdown[];
  devices: Breakdown[];
  browsers: Breakdown[];
  days: Array<{ day: string; visitors: number; views: number }>;
  recent: RecentVisit[];
}

const RANGE_LABEL: Record<VisitorRange, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
const PAGE_LABEL: Record<string, string> = {
  landing: 'Landing page', run: 'Apply', attention: 'Needs attention', applications: 'Applications',
  humanizer: 'Rewrite text', pricing: 'Pricing', setup: 'Settings', admin: 'Admin',
};
const pageLabel = (page: string) => PAGE_LABEL[page] ?? page;

/** A country's flag from its ISO code: the two regional-indicator letters. */
function flag(code: string | null): string {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

function spent(ms: number | null | undefined): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function BreakdownTable({ title, rows, empty, label = (row) => row.label, viewsLabel = 'Views' }: {
  title: string;
  rows: Breakdown[];
  empty: string;
  label?: (row: Breakdown) => ReactNode;
  viewsLabel?: string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.visitors));
  return (
    <section className="card admin-section admin-breakdown">
      <h3>{title}</h3>
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th />
              <th className="num">Visitors</th>
              <th className="num">{viewsLabel}</th>
              <th className="num">Avg time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td>
                  <div>{label(row)}</div>
                  {row.sub && <div className="job-meta">{row.sub}</div>}
                  <span className="admin-bar" aria-hidden="true"><span style={{ width: `${(row.visitors / max) * 100}%` }} /></span>
                </td>
                <td className="num">{row.visitors}</td>
                <td className="num">{row.views}</td>
                <td className="num">{row.seconds === null ? '—' : spent(row.seconds * 1000)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="job-meta admin-empty">{empty}</p>
      )}
    </section>
  );
}

function VisitorsView() {
  const [range, setRange] = useState<VisitorRange>('7d');
  const [includeAdmins, setIncludeAdmins] = useState(false);
  const [data, setData] = useState<VisitorReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<VisitorReport>(`/visitors?range=${range}&admins=${includeAdmins ? 1 : 0}`)
      .then(setData)
      .catch((reason) => setError((reason as Error).message));
  }, [range, includeAdmins]);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (error) return <div className="banner banner-bad">{error}</div>;

  const totals = data?.totals;
  const tiles = data && totals ? [
    { label: 'Visitors', value: totals.visitors, note: `${totals.signedIn} signed in` },
    { label: 'Visits', value: totals.visits, note: 'browser sessions' },
    { label: 'Page views', value: totals.views, note: totals.visits ? `${(totals.views / totals.visits).toFixed(1)} per visit` : '—' },
    { label: 'Avg time on page', value: spent(totals.avgSeconds === null ? null : totals.avgSeconds * 1000), note: 'while the tab was in front' },
    {
      label: 'Located',
      value: totals.views ? `${Math.round((totals.located / totals.views) * 100)}%` : '—',
      note: data.geoConfigured ? 'of views resolved to a place' : 'no location database installed',
    },
  ] : [];

  return (
    <div className="admin-stack">
      <div className="queue-bar">
        <div className="chips">
          {(Object.keys(RANGE_LABEL) as VisitorRange[]).map((key) => (
            <button key={key} className={`chip ${range === key ? 'on' : ''}`} onClick={() => setRange(key)}>
              {RANGE_LABEL[key]}
            </button>
          ))}
        </div>
        <label className="admin-checkbox">
          <input type="checkbox" checked={includeAdmins} onChange={(event) => setIncludeAdmins(event.target.checked)} />
          Include admins' own visits
        </label>
      </div>

      {!data ? (
        <p className="job-meta">Loading…</p>
      ) : (
        <>
          {!data.geoConfigured && (
            <div className="banner">
              No location database is installed, so visits have no country or city yet. Run <code>deploy/geoip-update.sh</code> on the server (see DEPLOYMENT.md).
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

          <div className="admin-visitors-grid">
            <BreakdownTable title="Countries" rows={data.countries} empty="No visits yet." label={(row) => <>{flag(row.code)} {row.label}</>} />
            <BreakdownTable title="States and regions" rows={data.regions} empty="No located visits yet." />
            <BreakdownTable title="Cities" rows={data.cities} empty="No located visits yet." />
            <BreakdownTable title="Pages" rows={data.pages} empty="No page views yet." label={(row) => pageLabel(row.label)} />
            <BreakdownTable title="Came from" rows={data.referrers} empty="Every visit arrived directly." viewsLabel="Visits" />
            <BreakdownTable title="Devices" rows={data.devices} empty="No visits yet." />
            <BreakdownTable title="Browsers" rows={data.browsers} empty="No visits yet." />
          </div>

          <section className="card table-wrap admin-section">
            <h3>Recent visits</h3>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Where</th>
                  <th>Address</th>
                  <th>Visitor</th>
                  <th>Pages</th>
                  <th className="num">Time spent</th>
                  <th>Device</th>
                  <th>Came from</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((visit) => (
                  <tr key={visit.sessionId}>
                    <td className="nowrap">
                      {when(visit.startedAt)}
                      <div className="job-meta">{visit.views} {visit.views === 1 ? 'page' : 'pages'}</div>
                    </td>
                    <td>
                      {visit.country ? (
                        <>
                          {flag(visit.countryCode)} {[visit.city, visit.region].filter(Boolean).join(', ') || visit.country}
                          {(visit.city || visit.region) && <div className="job-meta">{visit.country}</div>}
                        </>
                      ) : (
                        <span className="job-meta">Unknown</span>
                      )}
                    </td>
                    <td className="nowrap">
                      <code>{visit.ip ?? '—'}</code>
                      {visit.timeZone && <div className="job-meta">{visit.timeZone}</div>}
                    </td>
                    <td>
                      {visit.email ?? <span className="job-meta">Not signed in</span>}
                      <div className="job-meta">
                        {visit.visitNumber === 1 ? 'first visit' : `visit ${visit.visitNumber}`}
                        {visit.language ? ` · ${visit.language}` : ''}
                      </div>
                    </td>
                    <td>
                      <div className="admin-pages">
                        {visit.pages.map((page, index) => <span key={index}>{pageLabel(page)}</span>)}
                      </div>
                    </td>
                    <td className="num">{spent(visit.durationMs)}</td>
                    <td className="nowrap">
                      {visit.browser} · {visit.os}
                      <div className="job-meta">{visit.device}{visit.screen ? ` · ${visit.screen}` : ''}</div>
                    </td>
                    <td>
                      {visit.referrer ? (
                        <a href={visit.referrer} target="_blank" rel="noreferrer noopener">
                          {visit.referrer.replace('https://', '').replace('http://', '').slice(0, 60)}
                        </a>
                      ) : (
                        <span className="job-meta">Direct</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.recent.length && <p className="job-meta admin-empty">No visits in this period.</p>}
          </section>

          <p className="job-meta admin-attribution">
            Page views are kept for {data.retentionDays} days. Location data by{' '}
            <a href="https://db-ip.com" target="_blank" rel="noreferrer noopener">DB-IP</a>.
          </p>
        </>
      )}
    </div>
  );
}

export function AdminPanel() {
  const [view, setView] = useState<'overview' | 'users' | 'runs' | 'visitors'>('overview');
  const [openRun, setOpenRun] = useState<AdminRun | null>(null);
  const labels = { overview: 'Overview', users: 'Users', runs: 'Runs', visitors: 'Visitors' } as const;
  return (
    <div className="admin-page">
      <nav className="admin-nav" aria-label="Admin sections">
        {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => (
          <button key={key} className={view === key ? 'on' : ''} aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)}>
            {labels[key]}
          </button>
        ))}
      </nav>
      {view === 'overview' && <OverviewView onOpenRun={setOpenRun} />}
      {view === 'users' && <UsersView onOpenRun={setOpenRun} />}
      {view === 'runs' && <RunsView onOpenRun={setOpenRun} />}
      {view === 'visitors' && <VisitorsView />}
      {openRun && <RunLog run={openRun} onClose={() => setOpenRun(null)} />}
    </div>
  );
}
