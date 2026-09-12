import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Application } from './types';
import { RunPanel } from './components/RunPanel';
import { AttentionPanel, type AttentionItem } from './components/AttentionPanel';
import { ApplicationsPanel } from './components/ApplicationsPanel';
import { SetupPanel } from './components/SetupPanel';
import { HumanizerPanel } from './components/HumanizerPanel';
import { PricingPanel } from './components/PricingPanel';
import { daysSince } from './format';
import { UserChip, useAuth } from './components/SignIn';
import { Landing } from './components/Landing';
import { applyTheme, loadThemePref, resolvedTheme, saveThemePref, type ThemePref } from './theme';
import { useEntitlements } from './entitlements';

type Tab = 'run' | 'attention' | 'applications' | 'humanizer' | 'pricing' | 'setup';

const FOLLOW_UP_DAYS = 10;
const THEME_CYCLE: ThemePref[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<ThemePref, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

const PAGE_COPY: Record<Tab, { title: string; description: string }> = {
  run: {
    title: 'Apply for jobs',
    description: 'Run a safe rehearsal or submit applications when you are ready.',
  },
  attention: {
    title: 'Needs attention',
    description: 'Resolve anything the automation could not finish on its own.',
  },
  applications: {
    title: 'Applications',
    description: 'Track what was sent and record employer responses.',
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
    return requested === 'pricing' ? 'pricing' : 'run';
  });
  const [apps, setApps] = useState<Application[]>([]);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
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

  const load = useCallback(async () => {
    const [a, n, lastRun] = await Promise.all([
      fetch('/api/applications').then((response) => response.json()).catch(() => []),
      fetch('/api/attention').then((response) => response.json()).catch(() => []),
      fetch('/api/run/last').then((response) => response.json()).catch(() => ({ startedAt: null })),
    ]);
    setApps(Array.isArray(a) ? a : []);
    setAttention(Array.isArray(n) ? n : []);
    setLastRunAt(typeof lastRun?.startedAt === 'string' ? lastRun.startedAt : null);
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
  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];

  if (authLoading) {
    return <div className="signin-wrap"><div className="job-meta">Loading…</div></div>;
  }
  // Signed out, a visitor gets the landing page rather than a bare sign-in box:
  // nothing behind this point is public, so this page has to do the explaining.
  if (!user) return <Landing googleConfigured={googleConfigured} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="product" onClick={() => setTab('run')} aria-label="Go to Apply">
          <span className="product-mark" aria-hidden="true">
            <img src="/favicon.svg" alt="" />
          </span>
          <span className="product-name">Myasis</span>
        </button>

        <nav className="side-nav" aria-label="Main navigation">
          <span className="nav-label">Workspace</span>
          {primaryNav.map((item) => (
            <button
              key={item.id}
              className={`side-link ${tab === item.id ? 'active' : ''}`}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              <span>{item.label}</span>
              {item.badge ? <span className="nav-count">{item.badge}</span> : null}
            </button>
          ))}

          {canRewrite && (
            <>
              <span className="nav-label nav-label-tools">Tools</span>
              <button
                className={`side-link ${tab === 'humanizer' ? 'active' : ''}`}
                aria-current={tab === 'humanizer' ? 'page' : undefined}
                onClick={() => setTab('humanizer')}
              >
                Rewrite text
              </button>
            </>
          )}

          <span className="nav-label nav-label-tools">Account</span>
          <button
            className={`side-link ${tab === 'pricing' ? 'active' : ''}`}
            aria-current={tab === 'pricing' ? 'page' : undefined}
            onClick={() => setTab('pricing')}
          >
            Plans & pricing
          </button>
          <button
            className={`side-link ${tab === 'setup' ? 'active' : ''}`}
            aria-current={tab === 'setup' ? 'page' : undefined}
            onClick={() => setTab('setup')}
          >
            Settings
          </button>
        </nav>
      </aside>

      <main className="main-shell">
        <header className="page-header">
          <div>
            <h1>{PAGE_COPY[tab].title}</h1>
            <p>{PAGE_COPY[tab].description}</p>
          </div>
          <div className="toolbar">
            {running && <span className="badge ok">Running</span>}
            <button
              className="btn theme-btn"
              title={`Theme: ${theme}${theme === 'system' ? ` (${resolvedTheme('system')})` : ''}. Switch to ${nextTheme}.`}
              onClick={() => setTheme(nextTheme)}
            >
              {THEME_LABEL[theme]}
            </button>
            <UserChip user={user} onSignOut={signOut} />
          </div>
        </header>

        {tab === 'run' && (
          <section className="quick-status" aria-label="Application summary">
            <button onClick={() => setTab('applications')}>
              <strong>{stats.week}</strong>
              <span>applied this week</span>
            </button>
            <button
              className={stats.awaiting ? 'needs-action' : ''}
              onClick={() => setTab('applications')}
            >
              <strong>{stats.awaiting}</strong>
              <span>ready to follow up</span>
            </button>
            <button
              className={stats.blocked ? 'needs-action' : ''}
              onClick={() => setTab('attention')}
            >
              <strong>{stats.blocked}</strong>
              <span>{stats.verification ? 'need verification' : 'need attention'}</span>
            </button>
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
          {tab === 'pricing' && <PricingPanel />}
          {tab === 'setup' && <SetupPanel />}
        </div>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
