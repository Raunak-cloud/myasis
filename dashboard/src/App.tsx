import { Wordmark } from './components/Wordmark';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Application } from './types';
import { RunPanel } from './components/RunPanel';
import { AttentionPanel, type AttentionItem } from './components/AttentionPanel';
import { ApplicationsPanel } from './components/ApplicationsPanel';
import { SetupPanel } from './components/SetupPanel';
import { HumanizerPanel } from './components/HumanizerPanel';
import { AdminPanel } from './components/AdminPanel';
import { PricingPanel } from './components/PricingPanel';
import { daysSince } from './format';
import { useAuth } from './components/SignIn';
import { Landing } from './components/Landing';
import { MascotLogo } from './components/MascotLogo';
import { applyTheme, loadThemePref, resolvedTheme, saveThemePref, type ThemePref } from './theme';
import { useEntitlements } from './entitlements';
import { trackPage } from './analytics';

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

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => theme === 'system' && applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  useEffect(() => {
    let wasRunning = false;
    const id = window.setInterval(async () => {
      try {
        const status = await fetch('/api/run/status').then((response) => response.json());
        setRunning(Boolean(status.running));
        if (typeof status.startedAt === 'string') setLastRunAt(status.startedAt);
        if (wasRunning && !status.running) {
          void load();
          setToast(`Run finished${status.applied ? ` — ${status.applied} submitted` : ''}`);
          window.setTimeout(() => setToast(null), 6000);
        }
        wasRunning = Boolean(status.running);
      } catch {
        // The local server may be restarting.
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [load]);

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
  const go = (next: Tab) => {
    setTab(next);
    setMenuOpen(false);
  };
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
          <div className="nav-foot">
            <div className="nav-theme" role="group" aria-label="Theme">
              {THEME_CYCLE.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={theme === option ? 'on' : ''}
                  aria-pressed={theme === option}
                  title={option === 'system' ? `Follow the device (${resolvedTheme('system')})` : `Always ${option}`}
                  onClick={() => setTheme(option)}
                >
                  {THEME_LABEL[option]}
                </button>
              ))}
            </div>

            <div className="nav-account">
              {user.avatarUrl
                ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
                : <span className="nav-account-initial" aria-hidden="true">{(user.name ?? user.email).trim().charAt(0).toUpperCase()}</span>}
              <span className="nav-account-id">
                <strong>{user.name ?? 'Signed in'}</strong>
                <span className="job-meta">{user.email}</span>
              </span>
            </div>
            <button type="button" className="btn nav-signout" onClick={signOut}>Sign out</button>
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
              <span>jobs reviewed today</span>
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

        <div className="page-content">
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
        </div>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
