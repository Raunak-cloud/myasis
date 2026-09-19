import { Wordmark } from './components/Wordmark';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Application } from './types';
import type { AttentionItem } from './components/AttentionPanel';
/**
 * Everything behind sign-in loads only once someone has signed in. A visitor
 * reading the landing page used to download the whole dashboard first.
 */
const RunPanel = lazy(() => import('./components/RunPanel').then((m) => ({ default: m.RunPanel })));
const AttentionPanel = lazy(() => import('./components/AttentionPanel').then((m) => ({ default: m.AttentionPanel })));
const ApplicationsPanel = lazy(() => import('./components/ApplicationsPanel').then((m) => ({ default: m.ApplicationsPanel })));
const SetupPanel = lazy(() => import('./components/SetupPanel').then((m) => ({ default: m.SetupPanel })));
const HumanizerPanel = lazy(() => import('./components/HumanizerPanel').then((m) => ({ default: m.HumanizerPanel })));
const AdminPanel = lazy(() => import('./components/AdminPanel').then((m) => ({ default: m.AdminPanel })));
const PricingPanel = lazy(() => import('./components/PricingPanel').then((m) => ({ default: m.PricingPanel })));
import { daysSince } from './format';
import { useAuth, wasSignedIn } from './components/SignIn';
import { Landing } from './components/Landing';
import { MascotLogo } from './components/MascotLogo';
import { applyTheme, loadThemePref, resolvedTheme, saveThemePref, type ThemePref } from './theme';
import { useEntitlements } from './entitlements';
import { planName, shortDate, useBillingStatus } from './billing';
import { stopSimulation, useSimulation } from './simulation';
import { useBoardsStatus } from './boards';
import { useRouteStatus } from './route';
import { JobBoardsDialog } from './components/JobBoardsDialog';
import { trackPage } from './analytics';
import { useRunStatus } from './runStatus';

type Tab = 'run' | 'attention' | 'applications' | 'humanizer' | 'pricing' | 'setup' | 'admin';

const FOLLOW_UP_DAYS = 10;
const THEME_CYCLE: ThemePref[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<ThemePref, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

interface TodayStats {
  runs: number;
  reviewed: number;
  submitted: number;
}

const PAGE_COPY: Record<Tab, { title: string; description: string }> = {
  run: {
    title: 'Apply for jobs',
    description: '',
  },
  attention: {
    title: 'Needs attention',
    description: 'Resolve anything the automation could not finish on its own.',
  },
  applications: {
    title: 'Applications',
    description: 'Track what was sent and record employer responses.',
  },
  admin: {
    title: 'Admin',
    description: 'Every account, every run, and the controls for them.',
  },
  humanizer: {
    title: 'Rewrite text',
    description: 'Turn a stiff draft into clearer, more natural writing.',
  },
  pricing: {
    title: 'Plans & pricing',
    description: 'Choose a simple one-time pass when you need more applications.',
  },
  setup: {
    title: 'Settings',
    description: 'Manage your profile, documents and job preferences.',
  },
};

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return requested === 'pricing' ? 'pricing' : requested === 'admin' ? 'admin' : 'run';
  });
  const [apps, setApps] = useState<Application[]>([]);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [today, setToday] = useState<TodayStats>({ runs: 0, reviewed: 0, submitted: 0 });
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref());
  const [toast, setToast] = useState<string | null>(null);
  const { user, googleConfigured, loading: authLoading, signOut } = useAuth();
  const entitlements = useEntitlements();
  const billing = useBillingStatus();
  const simulation = useSimulation();
  const boards = useBoardsStatus();
  const route = useRouteStatus();
  const [boardsOpen, setBoardsOpen] = useState(false);
  /**
   * The rewriting tool is the operator's, so its tab is not offered. Landing
   * on it by an old link or a stale tab falls back to Apply rather than
   * rendering a page whose every request the server will refuse.
   */
  const canRewrite = entitlements?.rewriteText ?? false;
  useEffect(() => {
    if (entitlements && !canRewrite && tab === 'humanizer') setTab('run');
  }, [entitlements, canRewrite, tab]);
  /** The admin dashboard is only offered to admins; the server refuses everyone else regardless. */
  const isAdmin = entitlements?.tier === 'admin';
  useEffect(() => {
    if (entitlements && !isAdmin && tab === 'admin') setTab('run');
  }, [entitlements, isAdmin, tab]);
  /** What is in front of the visitor: the landing page while signed out, otherwise the tab. */
  useEffect(() => {
    if (authLoading) return;
    trackPage(user ? tab : 'landing');
  }, [authLoading, user, tab]);

  const load = useCallback(async () => {
    const [a, n, lastRun, todayStats] = await Promise.all([
      fetch('/api/applications').then((response) => response.json()).catch(() => []),
      fetch('/api/attention').then((response) => response.json()).catch(() => []),
      fetch('/api/run/last').then((response) => response.json()).catch(() => ({ startedAt: null })),
      fetch('/api/today').then((response) => response.json()).catch(() => null),
    ]);
    setApps(Array.isArray(a) ? a : []);
    setAttention(Array.isArray(n) ? n : []);
    setLastRunAt(typeof lastRun?.startedAt === 'string' ? lastRun.startedAt : null);
    if (todayStats && typeof todayStats.runs === 'number') setToday(todayStats as TodayStats);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    applyTheme(theme);
    saveThemePref(theme);
  }, [theme]);

  // Auto follows the Sydney clock, so it has to be looked at again as the evening arrives.
  useEffect(() => {
    if (theme !== 'system') return;
    const tick = () => applyTheme('system');
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [theme]);

  /**
   * The same poll the Apply panel reads, not a second one against the same
   * endpoint. This only watches for the run ending, to refresh the lists and
   * say so.
   */
  const runStatus = useRunStatus();
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!runStatus) return;
    setRunning(Boolean(runStatus.running));
    if (typeof runStatus.startedAt === 'string') setLastRunAt(runStatus.startedAt);
    if (wasRunning.current && !runStatus.running) {
      void load();
      setToast(`Run finished${runStatus.applied ? `, ${runStatus.applied} submitted` : ''}`);
      window.setTimeout(() => setToast(null), 6000);
    }
    wasRunning.current = Boolean(runStatus.running);
  }, [runStatus, load]);

  const stats = useMemo(() => {
    const week = apps.filter((app) => daysSince(app.appliedAt) <= 7).length;
    const awaiting = apps.filter(
      (app) => !app.outcome && daysSince(app.appliedAt) >= FOLLOW_UP_DAYS,
    ).length;
    const verification = attention.filter((item) => item.kind === 'verification').length;
    return { week, awaiting, blocked: attention.length, verification };
  }, [apps, attention]);

  const primaryNav: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: 'run', label: 'Apply' },
    { id: 'attention', label: 'Needs attention', badge: stats.blocked },
    { id: 'applications', label: 'Applications', badge: apps.length },
  ];

  /**
   * On a narrow screen the destinations live behind a menu button rather
   * than in a strip that scrolls sideways: seven of them never fit, and a
   * label cut in half is worse than one that is put away. The drawer closes
   * on a choice, on Escape and on a tap outside, and the page underneath
   * does not scroll while it is open.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const signOutButton = useRef<HTMLButtonElement>(null);
  const go = (next: Tab) => {
    setTab(next);
    setMenuOpen(false);
  };
  useEffect(() => {
    if (!confirmSignOut) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmSignOut(false);
    };
    window.addEventListener('keydown', close);
    signOutButton.current?.focus();
    return () => window.removeEventListener('keydown', close);
  }, [confirmSignOut]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.body.classList.add('nav-open');
    window.addEventListener('keydown', close);
    return () => {
      document.body.classList.remove('nav-open');
      window.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  if (authLoading) {
    // A visitor who has never signed in here sees the landing straight away; the answer will almost certainly be "signed out".
    if (!wasSignedIn()) return <Landing googleConfigured={googleConfigured} />;
    return <div className="signin-wrap"><div className="job-meta">Loading…</div></div>;
  }
  // Signed out, a visitor gets the landing page rather than a bare sign-in box:
  // nothing behind this point is public, so this page has to do the explaining.
  if (!user) return <Landing googleConfigured={googleConfigured} />;

  return (
    <div className={`app-shell ${tab === 'run' ? 'apply-shell' : ''} ${menuOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <button
          type="button"
          className={`nav-toggle ${stats.blocked ? 'has-news' : ''}`}
          aria-label={menuOpen ? 'Close menu' : 'Menu'}
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="nav-toggle-bars" aria-hidden="true"><span /><span /><span /></span>
        </button>

        <button className="product" onClick={() => go('run')} aria-label="Go to Apply">
          <span className="product-mark" aria-hidden="true">
            <MascotLogo size={38} />
          </span>
          <Wordmark className="product-name" />
        </button>

        <nav className="side-nav" id="main-nav" aria-label="Main navigation">
          <span className="nav-label">Workspace</span>
          {primaryNav.map((item) => (
            <button
              key={item.id}
              className={`side-link ${tab === item.id ? 'active' : ''}`}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => go(item.id)}
            >
              <span>{item.label}</span>
              {item.badge ? <span className="nav-count">{item.badge}</span> : null}
            </button>
          ))}

          {isAdmin && (
            <>
              <span className="nav-label nav-label-tools">Admin</span>
              <button
                className={`side-link ${tab === 'admin' ? 'active' : ''}`}
                aria-current={tab === 'admin' ? 'page' : undefined}
                onClick={() => go('admin')}
              >
                Admin dashboard
              </button>
            </>
          )}

          {canRewrite && (
            <>
              <span className="nav-label nav-label-tools">Tools</span>
              <button
                className={`side-link ${tab === 'humanizer' ? 'active' : ''}`}
                aria-current={tab === 'humanizer' ? 'page' : undefined}
                onClick={() => go('humanizer')}
              >
                Rewrite text
              </button>
            </>
          )}

          <span className="nav-label nav-label-tools">Account</span>
          <button
            className={`side-link ${tab === 'pricing' ? 'active' : ''}`}
            aria-current={tab === 'pricing' ? 'page' : undefined}
            onClick={() => go('pricing')}
          >
            Plans & pricing
          </button>
          <button
            className={`side-link ${tab === 'setup' ? 'active' : ''}`}
            aria-current={tab === 'setup' ? 'page' : undefined}
            onClick={() => go('setup')}
          >
            Settings
          </button>

          {/*
            Who is signed in, and how the app looks, live at the foot of the
            menu on every screen. They were in the page header, which on a
            phone left two controls competing with the title for one row.
          */}
          {/*
            The foot of the menu, as one panel: who is signed in, the plan and
            what is left on it, whether the job boards are signed in, and the
            two controls. Four separate boxes read as four separate things;
            one panel with dividers reads as the account.
          */}
          <div className="nav-foot">
            <div className="nav-card">
              <div className="nav-account">
                {user.avatarUrl
                  ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
                  : <span className="nav-account-initial" aria-hidden="true">{(user.name ?? user.email).trim().charAt(0).toUpperCase()}</span>}
                <span className="nav-account-id">
                  <strong>{user.name ?? 'Signed in'}</strong>
                  <span className="job-meta">{user.email}</span>
                </span>
              </div>

              {billing && entitlements && (
                <button
                  type="button"
                  className={`nav-row ${tab === 'pricing' ? 'active' : ''}`}
                  onClick={() => go('pricing')}
                  aria-label="Plan and applications remaining. Opens plans and pricing."
                >
                  <span className="nav-row-main">
                    <span className="nav-row-title">{planName(billing, entitlements.tier === 'admin')}</span>
                    <span className="nav-row-sub">
                      {entitlements.tier === 'admin'
                        ? 'No application limits'
                        : billing.paid.hasActivePass && billing.paid.expiresAt
                          ? `${billing.paid.remaining} on your pass · until ${shortDate(billing.paid.expiresAt)}`
                          : `${billing.free.remaining} of ${billing.free.allowance} free applications`}
                    </span>
                  </span>
                  {entitlements.tier !== 'admin' && (
                    <span className="nav-row-value">
                      <strong>{billing.totalRemaining}</strong>
                      <span>left</span>
                    </span>
                  )}
                  <svg className="nav-row-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                </button>
              )}

              {boards && (boards.seek || boards.indeed) && (
                <button
                  type="button"
                  className="nav-row"
                  onClick={() => setBoardsOpen(true)}
                  aria-haspopup="dialog"
                  aria-label="Job boards: which account is signed in, sign out, sign in."
                  title="See which account each job board is signed in with, sign out, or sign in yourself."
                >
                  <span className="nav-row-main">
                    <span className="nav-row-title">Job boards</span>
                    <span className="nav-row-sub">
                      {(['seek', 'indeed'] as const)
                        .filter((board) => boards[board])
                        .map((board) => `${board === 'seek' ? 'SEEK' : 'Indeed'}${boards[board]!.signedIn ? '' : ' signed out'}`)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="nav-dots" aria-hidden="true">
                    {(['seek', 'indeed'] as const).filter((board) => boards[board]).map((board) => (
                      <span key={board} className={`nav-dot ${boards[board]!.signedIn ? 'on' : 'off'}`} />
                    ))}
                  </span>
                  <svg className="nav-row-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                </button>
              )}

              {route && (
                <div
                  className="nav-row nav-row-static"
                  title={route.using === 'home'
                    ? 'Applications go out from your own home internet connection while your computer is on.'
                    : route.configured && route.homeOnline
                      ? 'Your home computer reconnected while a browser was already open on the server connection. A browser never changes address part-way, so the next one uses your home internet.'
                    : route.configured
                      ? 'Your home computer is not connected, so applications go out from the Owtomate server.'
                      : 'Applications go out from the Owtomate server.'}
                >
                  <span className="nav-row-main">
                    <span className="nav-row-title">Connection</span>
                    <span className="nav-row-sub">
                      {route.using === 'home'
                        ? `Your home internet${route.homeAddress ? ` · ${route.homeAddress}` : ''}`
                        : !route.configured
                          ? 'Owtomate server'
                          : route.homeOnline
                            ? 'Owtomate server · back to home after this run'
                            : 'Owtomate server · home computer off'}
                    </span>
                  </span>
                  <span className="nav-dots" aria-hidden="true">
                    <span className={`nav-dot ${route.using === 'home' || !route.configured ? 'on' : 'off'}`} />
                  </span>
                </div>
              )}

              <div className="nav-tools">
                <div className="nav-theme" role="group" aria-label="Theme">
                  {THEME_CYCLE.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={theme === option ? 'on' : ''}
                      aria-pressed={theme === option}
                      title={option === 'system' ? `Dark from 7 pm to 7 am, Sydney time (${resolvedTheme('system')} now)` : `Always ${option}`}
                      onClick={() => setTheme(option)}
                    >
                      {THEME_LABEL[option]}
                    </button>
                  ))}
                </div>
                <button type="button" className="nav-signout" onClick={() => setConfirmSignOut(true)}>Sign out</button>
              </div>
            </div>
          </div>
        </nav>
      </aside>

      {/* Tapping beside the drawer closes it, the way every drawer on a phone does. */}
      <button type="button" className="nav-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setMenuOpen(false)} />

      <main className={`main-shell ${tab === 'run' ? 'run-dashboard' : ''}`}>
        <header className="page-header">
          <div>
            <h1>{PAGE_COPY[tab].title}</h1>
            {PAGE_COPY[tab].description && <p>{PAGE_COPY[tab].description}</p>}
          </div>
          <div className="toolbar">
            {running && <span className="badge ok">Running</span>}
          </div>
        </header>

        {tab === 'run' && (
          <section className="dashboard-metrics" aria-label="Application summary">
            <button type="button" className="metric-tile" onClick={() => setTab('applications')}>
              <strong>{stats.week}</strong>
              <span>applied this week</span>
            </button>
            <div className="metric-tile">
              <strong>{today.submitted}</strong>
              <span>sent today</span>
            </div>
            <div className="metric-tile">
              <strong>{today.reviewed}</strong>
              <span>reviewed today</span>
            </div>
            {/* Only when there is something to do: a row of zeros is noise. */}
            {stats.awaiting > 0 && (
              <button type="button" className="metric-tile needs-action" onClick={() => setTab('applications')}>
                <strong>{stats.awaiting}</strong>
                <span>to follow up</span>
              </button>
            )}
            {stats.blocked > 0 && (
              <button type="button" className="metric-tile needs-action" onClick={() => setTab('attention')}>
                <strong>{stats.blocked}</strong>
                <span>{stats.verification ? 'need verification' : 'need attention'}</span>
              </button>
            )}
          </section>
        )}

        {simulation && (
          <div className="simulation-bar" role="status">
            <span><strong>Preview:</strong> {simulation.group} · {simulation.label}. Nothing you press is sent.</span>
            <button type="button" className="btn" onClick={() => { stopSimulation(); setTab('admin'); }}>Exit preview</button>
          </div>
        )}
        <div className="page-content">
          <Suspense fallback={<div className="job-meta">Loading…</div>}>
          {tab === 'run' && (
            <RunPanel
              lastRunAt={lastRunAt}
              onFinished={load}
              onGoSetup={() => setTab('setup')}
              onGoPricing={() => setTab('pricing')}
            />
          )}
          {tab === 'attention' && <AttentionPanel items={attention} onCleared={load} />}
          {tab === 'applications' && (
            <ApplicationsPanel apps={apps} onChange={setApps} followUpDays={FOLLOW_UP_DAYS} />
          )}
          {tab === 'humanizer' && canRewrite && <HumanizerPanel />}
          {tab === 'admin' && isAdmin && <AdminPanel />}
          {tab === 'pricing' && <PricingPanel />}
          {tab === 'setup' && <SetupPanel />}
          </Suspense>
        </div>
      </main>

      {boardsOpen && boards && <JobBoardsDialog boards={boards} onClose={() => setBoardsOpen(false)} onSignIn={() => go('run')} />}

      {confirmSignOut && (
        <div className="overlay center" onClick={() => setConfirmSignOut(false)}>
          <div
            className="card confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sign-out-title"
            aria-describedby="sign-out-description"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="sign-out-title">Sign out of Owtomate?</h2>
            <p id="sign-out-description" className="dim">
              Any run already going keeps running. You will need to sign in again to see it.
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmSignOut(false)}>Stay signed in</button>
              <button ref={signOutButton} className="btn btn-danger-solid" onClick={() => { setConfirmSignOut(false); void signOut(); }}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
