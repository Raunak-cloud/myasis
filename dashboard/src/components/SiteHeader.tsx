import { useRef, useState } from 'react';
import { Wordmark } from './Wordmark';
import './SiteHeader.css';

/** Shared by the homepage, automation guide, brief index and every brief article. */
export function SiteHeader({ home = false, active, googleConfigured = true }: {
  home?: boolean;
  active?: 'guide' | 'blog';
  googleConfigured?: boolean;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  return (
    <header className="home-header" onKeyDown={(event) => {
      if (event.key === 'Escape' && navigationOpen) {
        setNavigationOpen(false);
        navigationToggle.current?.focus();
      }
    }}>
      <div className="home-header-inner">
        <a href={home ? "#top" : "/"} className="home-brand" aria-label="owtomate home">
          <Wordmark />
        </a>
        <button ref={navigationToggle} className="home-nav-toggle" type="button" aria-expanded={navigationOpen} aria-controls="home-navigation" onClick={() => setNavigationOpen((open) => !open)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d={navigationOpen ? 'M6 6l12 12M6 18L18 6' : 'M4 6h16M4 12h16M4 18h16'} />
          </svg>
          {navigationOpen ? 'Close' : 'Menu'}
        </button>
        <nav id="home-navigation" className={navigationOpen ? 'is-open' : undefined} aria-label="Main" onClick={() => setNavigationOpen(false)}>
          <a href={`${home ? "" : "/"}#how-it-works`}>How it works</a>
          <a href={`${home ? "" : "/"}#story`}>The difference</a>
          <a href={`${home ? "" : "/"}#pricing`}>Pricing</a>
          <a href={`${home ? "" : "/"}#questions`}>Questions</a>
          <a className="home-nav-resource" href="/automate-job-applications-australia" aria-current={active === 'guide' ? 'page' : undefined}>Automation guide</a>
          <a className="home-nav-resource" href="/blog" aria-current={active === 'blog' ? 'true' : undefined}>Job market brief</a>
        </nav>
        {googleConfigured
          ? <a className="home-login" rel="nofollow" href="/api/auth/google">Sign in <span aria-hidden="true">↗</span></a>
          : <span className="home-login home-login-off">Sign-in unavailable</span>}
      </div>
    </header>
  );
}
