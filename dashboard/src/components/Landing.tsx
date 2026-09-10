import { useEffect, useState } from 'react';
import { FREE_MONTHLY_APPLICATIONS, PAID_PLANS } from '../pricing';

/**
 * What a visitor sees before they sign in.
 *
 * The dashboard is entirely private — every screen behind it holds somebody's
 * résumé, contact details and application history — so this page carries the
 * whole job of explaining what Myasis does and why it can be trusted with
 * that. It is deliberately plain about the limits too: a tool that applies for
 * jobs on your behalf earns more confidence by saying what it will not do.
 */

const price = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const STEPS = [
  {
    n: '1',
    title: 'Add your résumé and what you are after',
    body: 'Upload the résumé you want employers to see, then set the roles, locations and pay you would accept. Everything after this runs from that.',
  },
  {
    n: '2',
    title: 'Rehearse before anything is sent',
    body: 'A rehearsal completes the entire application — the questions, the cover letter, the forms — and stops at the submit button so you can read exactly what would have gone out.',
  },
  {
    n: '3',
    title: 'Let it apply, and review what it could not',
    body: 'When you are satisfied, it applies for real. Anything it cannot answer honestly comes back to you with the question, rather than being guessed at.',
  },
];

const POINTS = [
  {
    title: 'It reads the job before applying',
    body: 'Every listing is checked against your actual experience. Roles that need a licence, a clearance or years you do not have are skipped, with the reason recorded.',
  },
  {
    title: 'Cover letters written for the job',
    body: 'Each letter is drafted from your own history and the specific listing. Nothing is templated, and nothing is claimed that your documents do not support.',
  },
  {
    title: 'It will not invent an answer',
    body: 'Screening questions are answered only from your profile and documents. When there is no honest answer, the application pauses and asks you instead.',
  },
  {
    title: 'You keep the record',
    body: 'Every application is stored with the cover letter and answers exactly as sent, so you know what each employer received.',
  },
];

export function Landing({ googleConfigured }: { googleConfigured: boolean }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The OAuth callback sends a readable reason back here when sign-in fails.
    const reason = new URLSearchParams(location.search).get('auth_error');
    if (reason) {
      setError(reason);
      history.replaceState({}, '', location.pathname);
    }
  }, []);

  const signIn = googleConfigured ? (
    <a className="btn primary landing-cta" href="/api/auth/google">
      Continue with Google
    </a>
  ) : (
    <div className="banner">
      Google sign-in isn't configured. Add <span className="mono">GOOGLE_CLIENT_ID</span> and{' '}
      <span className="mono">GOOGLE_CLIENT_SECRET</span> to the server environment.
    </div>
  );

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Myasis</span>
        </div>
        {googleConfigured && (
          <a className="btn" href="/api/auth/google">
            Sign in
          </a>
        )}
      </header>

      <main>
        <section className="landing-hero">
          <h1>Apply for the jobs worth applying for.</h1>
          <p className="landing-lede">
            Myasis reads your résumé, finds roles on SEEK that genuinely match it, writes a cover letter for each one
            and submits the application. You review what it could not answer.
          </p>
          {error && <div className="banner banner-bad landing-error">{error}</div>}
          <div className="landing-actions">{signIn}</div>
          <p className="job-meta landing-note">
            Free for {FREE_MONTHLY_APPLICATIONS} applications a month. No card required to start.
          </p>
        </section>

        <section className="landing-section">
          <h2>How it works</h2>
          <ol className="landing-steps">
            {STEPS.map((step) => (
              <li key={step.n}>
                <span className="landing-step-n" aria-hidden="true">
                  {step.n}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section">
          <h2>What makes it different</h2>
          <div className="landing-grid">
            {POINTS.map((point) => (
              <article key={point.title} className="card landing-point">
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section">
          <h2>Pricing</h2>
          <p className="landing-sub">Passes are one-off. There is no subscription and nothing renews on its own.</p>
          <div className="landing-grid landing-plans">
            <article className="card landing-plan">
              <h3>Free</h3>
              <p className="landing-price">
                $0<span>/month</span>
              </p>
              <p>{FREE_MONTHLY_APPLICATIONS} applications every month, and unlimited rehearsals so you can see it work first.</p>
            </article>
            {(['job-search-pass', 'intensive-pass'] as const).map((key) => {
              const plan = PAID_PLANS[key];
              return (
                <article key={plan.key} className="card landing-plan">
                  <h3>{plan.name}</h3>
                  <p className="landing-price">
                    {price(plan.priceCents)}<span>one-off</span>
                  </p>
                  <p>
                    {plan.applications} applications, valid {plan.validDays} days. {plan.description}
                  </p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="landing-section landing-honest">
          <h2>What it will not do</h2>
          <p>
            Myasis never invents experience, qualifications or work rights to get past a question, and it never asks
            for your SEEK password — you sign in to SEEK yourself, in your own browser session. Applications that need
            a real decision from you stop and wait. It applies on your behalf, so what it sends is still your name on
            the application.
          </p>
          <div className="landing-actions">{signIn}</div>
        </section>
      </main>

      <footer className="landing-foot">
        <span>Myasis</span>
        <span className="job-meta">Automated job applications, reviewed by you.</span>
      </footer>
    </div>
  );
}
