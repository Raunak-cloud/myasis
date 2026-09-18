import './Landing.css';
import { useEffect, useRef, useState } from 'react';
import { FREE_APPLICATIONS, HUMANIZER_NOTE, PAID_PLANS, PLAN_PRESENTATION, SCHEDULED_MIN_SCORE, aud } from '../pricing';
import { LIVE_DEMO } from '../liveDemo';
import { MascotLogo } from './MascotLogo';
import { Wordmark } from './Wordmark';
import { HeroStory } from './HeroStory';

/** Mirrored word for word in index.html's FAQ structured data; change both together. */
const QUESTIONS = [
  { question: 'Does it actually submit applications?', answer: 'Yes. Owtomate submits applications on your behalf, using your résumé, your preferences and a cover letter written for each job. Every application is saved, so you can see exactly what was sent.' },
  { question: 'Is Owtomate a job application bot?', answer: `Owtomate is an application assistant, not a spam bot. Scheduled runs apply only to jobs that score at least ${SCHEDULED_MIN_SCORE}% against your profile, every application goes through your own SEEK or Indeed session, and it stops and asks you whenever it cannot answer something honestly.` },
  { question: 'What happens when it cannot answer a question?', answer: 'It pauses that application and puts the question in Needs attention. Owtomate uses your profile and documents to answer screening questions; it does not invent work experience, qualifications or work rights.' },
  { question: 'Do I need to give Owtomate my SEEK password?', answer: 'No. You sign in to SEEK yourself through your private browser session in Owtomate. The application agent reuses that session without asking for your password.' },
  { question: 'Can I see what was sent?', answer: 'Yes. Your application history stores the role, cover letter and screening answers, so you can see what each employer received and keep track of your search.' },
  { question: 'Is there a subscription?', answer: 'No. The free plan is a one-time allowance. Paid passes are one-off purchases, valid for 30 days, and do not automatically renew. Prices are in Australian dollars.' },
];

const STEPS = [
  {
    code: '01',
    title: 'You tell Owtomate what you want.',
    body: 'Add your résumé, the kinds of roles you want, where you would work, and the pay you would accept. Owtomate checks each listing it considers against what you have written. You set the rules once; the agent follows them on every run.',
  },
  {
    code: '02',
    title: 'Owtomate applies to the jobs that fit.',
    body: 'It reads the listing, picks the right résumé, writes a cover letter for that role and fills in the screening questions from your profile. If it cannot answer something honestly, it stops and brings the question back to your inbox.',
  },
  {
    code: '03',
    title: 'You keep going with your life.',
    body: 'Everything it sent is filed under your account: role, cover letter, screening answers, what the employer responded. Anything it could not answer lands in Needs attention. Otherwise, the page in front of you is just a log of applications you did not have to write.',
  },
];

export function Landing({ googleConfigured }: { googleConfigured: boolean }) {
  const [error] = useState(() => (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('auth_error')));
  const [playError, setPlayError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const autoPlayed = useRef(false);

  useEffect(() => {
    if (!error) return;
    const url = new URL(location.href);
    url.searchParams.delete('auth_error');
    history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [error]);

  useEffect(() => {
    const element = video.current;
    if (!element || !LIVE_DEMO.available) return;
    // People who asked for less motion, or are saving data, get the poster and a play button instead of a heavy download.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || (navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || autoPlayed.current) return;
      autoPlayed.current = true;
      element.muted = true;
      void element.play().catch(() => setPlayError(true));
      observer.disconnect();
    }, { threshold: 0.45 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function start(label = 'Start applying', variant: 'primary' | 'light' | 'white' = 'primary') {
    if (!googleConfigured) return <span className="home-unavailable">Sign-in is temporarily unavailable.</span>;
    const className = `home-button${variant === 'light' ? ' home-button-light' : variant === 'white' ? ' home-button-white' : ''}`;
    return <a className={className} rel="nofollow" href="/api/auth/google">{label}</a>;
  }

  const audPrice = (cents: number) => (cents / 100).toFixed(2);

  return (
    <div className="landing" id="top">
      <header className="home-header">
        <div className="home-width home-header-inner">
          <a href="#top" className="home-brand" aria-label="owtomate home">
            <Wordmark />
            <span className="home-brand-meta">Sydney, AU</span>
          </a>
          <nav aria-label="Main">
            <a href="#how-it-works">how it works</a>
            <a href="#story">the difference</a>
            <a href="#pricing">pricing</a>
            <a href="#questions">questions</a>
          </nav>
          {googleConfigured
            ? <a className="home-login" rel="nofollow" href="/api/auth/google">sign in</a>
            : <span className="home-login home-login-off">sign-in off</span>}
        </div>
      </header>

      <main>
        <section className="home-hero" aria-labelledby="home-heading">
          <div className="home-width home-hero-inner">
            <p className="home-hero-kicker">
              <span className="home-hero-dot" aria-hidden="true" />
              A job application assistant &mdash; not a recruiter, not a chatbot.
            </p>
            <h1 id="home-heading" className="home-hero-title">
              Stop applying for jobs.<br />
              <span className="home-hero-mark">Owtomate</span> does it <em>for</em> you, from your own account.
            </h1>
            <p className="home-hero-summary">
              Owtomate reads SEEK and Indeed listings against your résumé, writes a cover letter for each one and submits it through the session you are already signed in to. If it cannot answer something honestly, it stops and asks you. If it can, you do not see the form.
            </p>
            <div className="home-hero-actions">
              {start()}
              <p className="home-hero-note"><strong>{FREE_APPLICATIONS}</strong> applications on us. Job Search Pass is <strong>{aud(1999)}</strong> for 150 over 30 days. No subscription, no auto-renew, no card for the free plan.</p>
            </div>
            <p className="home-consent">By signing in you agree to the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>.</p>
            {error && <div className="home-error" role="alert">{error}</div>}
          </div>
        </section>

        <section className="home-demo" id="demo" aria-label="A real recorded run of Owtomate submitting a job application.">
          <div className="home-width home-demo-inner">
            <div className="home-demo-stage">
              <div className="home-demo-rec-top">
                <span className="home-demo-rec"><span className="home-demo-rec-dot" aria-hidden="true" />REC</span>
                <span className="home-demo-rec-name">seek · unedited recording</span>
                <span className="home-demo-rec-time">02:18</span>
              </div>
              <div className="home-demo-video">
                {LIVE_DEMO.available ? (
                  <video ref={video} controls playsInline preload="metadata" poster={LIVE_DEMO.poster} aria-label="Owtomate applying to a real job on SEEK" onError={() => setPlayError(true)}>
                    <source src={LIVE_DEMO.src} type="video/mp4" />
                    <track kind="captions" src={LIVE_DEMO.captions} srcLang="en" label="English" default />
                    Your browser does not support video. <a href={LIVE_DEMO.src}>Download the recording.</a>
                  </video>
                ) : (
                  <div className="home-recording-pending"><MascotLogo size={60} /><p>The live run is being recorded.</p><span>The finished recording will appear here.</span></div>
                )}
              </div>
              {playError && <p className="home-error" role="status">The video could not play. <a href={LIVE_DEMO.src}>Download the recording instead.</a></p>}
            </div>
            <aside className="home-demo-note" aria-label="A note about the recording above">
              <p className="home-demo-note-pin" aria-hidden="true">note</p>
              <p>
                This is the same recording used across the site: an unedited run of Owtomate opening a SEEK listing, drafting the cover letter and submitting the application. We blurred the account details and left the rest as it happened.
              </p>
              <p className="home-demo-note-tail">&mdash; no retakes.</p>
            </aside>
          </div>
        </section>

        <section className="home-difference" id="story" aria-label="What changes when Owtomate applies for you.">
          <div className="home-width home-difference-inner">
            <p className="home-difference-kicker">the difference</p>
            <h2 className="home-difference-title">Job hunting is a job. <em>Not anymore.</em></h2>
            <HeroStory />
            <p className="home-difference-tail">
              We are not trying to make it fun. We are trying to <em>remove</em> it from your week. Same number of applications, one of them could land you the job, and you did not have to write the cover letter for it.
            </p>
          </div>
        </section>

        <section className="home-how" id="how-it-works" aria-labelledby="how-heading">
          <div className="home-width home-how-inner">
            <header className="home-how-head">
              <p className="home-how-kicker">how it works</p>
              <h2 id="how-heading">Three steps. The <em>first</em> one is the only one that needs you.</h2>
              <p className="home-how-blurb">After that, Owtomate reads the listings, picks the right résumé and writes the cover letter. You come back for what it could not answer honestly.</p>
            </header>
            <ol className="home-how-list">
              {STEPS.map((step) => (
                <li key={step.code} className="home-how-step">
                  <span className="home-how-code" aria-hidden="true">{step.code}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="home-how-foot">
              <span className="home-how-foot-mark" aria-hidden="true">*</span>
              Owtomate will not invent qualifications, stretch your experience or guess your work rights. Your name is on the application. The facts should be yours too.
            </p>
          </div>
        </section>

        <section className="home-pricing" id="pricing" aria-labelledby="pricing-heading">
          <div className="home-width home-pricing-inner">
            <header className="home-pricing-head">
              <p className="home-pricing-kicker">pricing</p>
              <h2 id="pricing-heading">Three ways to pay for Owtomate.</h2>
              <p>One payment. Thirty days. No auto-renew. Prices in Australian dollars.</p>
            </header>
            <ol className="home-price-list">
              <li className="home-price-row">
                <span className="home-price-tier">Free</span>
                <span className="home-price-amount"><span className="home-price-currency">A$</span>{audPrice(0)}</span>
                <span className="home-price-desc">{PLAN_PRESENTATION.free.description}</span>
                <span className="home-price-notes">{PLAN_PRESENTATION.free.features.join(' · ')}.</span>
                <span className="home-price-cta">{start('Start free', 'light')}</span>
              </li>
              <li className="home-price-row home-price-row-feature">
                <span className="home-price-tier">Job Search Pass<span className="home-price-flag">most picked</span></span>
                <span className="home-price-amount"><span className="home-price-currency">A$</span>{audPrice(PAID_PLANS['job-search-pass'].priceCents)}</span>
                <span className="home-price-desc">{PLAN_PRESENTATION['job-search-pass'].description} 150 successful applications. Valid 30 days. One payment.</span>
                <span className="home-price-notes">{PLAN_PRESENTATION['job-search-pass'].features.join(' · ')}.</span>
                <span className="home-price-cta">{start('Buy a Job Search Pass', 'primary')}</span>
              </li>
              <li className="home-price-row">
                <span className="home-price-tier">Intensive Pass</span>
                <span className="home-price-amount"><span className="home-price-currency">A$</span>{audPrice(PAID_PLANS['intensive-pass'].priceCents)}</span>
                <span className="home-price-desc">{PLAN_PRESENTATION['intensive-pass'].description} 320 successful applications. Valid 30 days. One payment.</span>
                <span className="home-price-notes">{PLAN_PRESENTATION['intensive-pass'].features.join(' · ')}.</span>
                <span className="home-price-cta">{start('Buy an Intensive Pass', 'light')}</span>
              </li>
            </ol>
            <p className="home-price-foot">
              Already bought a pass and chewed through it? An Application Top-up is {aud(PAID_PLANS['application-top-up'].priceCents)} for 50 more successful applications, valid 30 days &mdash; ask in-app after you start. {HUMANIZER_NOTE}
            </p>
          </div>
        </section>

        <section className="home-questions" id="questions" aria-labelledby="questions-heading">
          <div className="home-width home-questions-inner">
            <header className="home-questions-head">
              <p className="home-questions-kicker">questions</p>
              <h2 id="questions-heading">Questions people have emailed us about.</h2>
              <p>If yours is not here, write to <a href="mailto:support@owtomate.com">support@owtomate.com</a>.</p>
            </header>
            <ol className="home-faq-list">
              {QUESTIONS.map((item, index) => (
                <li key={item.question}>
                  <details>
                    <summary>
                      <span className="home-faq-num" aria-hidden="true">Q.{String(index + 1).padStart(2, '0')}</span>
                      <span className="home-faq-q">{item.question}</span>
                      <span className="home-faq-toggle" aria-hidden="true">+</span>
                    </summary>
                    <p>{item.answer}</p>
                  </details>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="home-last" aria-label="Final nudge to try Owtomate.">
          <div className="home-width home-last-inner">
            <figure className="home-last-quote">
              <p className="home-last-eyebrow">our favourite goodbye</p>
              <blockquote>
                &ldquo;I got the job.&rdquo;
              </blockquote>
              <figcaption>Three words, and the reason we built this thing.</figcaption>
            </figure>
            <aside className="home-last-side">
              <div className="home-last-mascot" aria-hidden="true">
                <MascotLogo size={64} />
                <span className="home-last-bubble">Now go.</span>
              </div>
              <p className="home-last-copy">
                The sooner you leave us for your new role, the more we like our job. Five free applications. One sign-in. No card.
              </p>
              <div className="home-last-cta">{start('Start applying', 'white')}</div>
              <p className="home-last-tag">{FREE_APPLICATIONS} free applications &middot; no card needed.</p>
            </aside>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <div className="home-width home-footer-inner">
          <div className="home-footer-col">
            <a href="#top" className="home-brand" aria-label="owtomate home"><Wordmark /></a>
            <p className="home-footer-blurb">Owtomate is built and run from Sydney, Australia.</p>
          </div>
          <nav className="home-footer-col" aria-label="Site">
            <p className="home-footer-label">site</p>
            <a href="#how-it-works">how it works</a>
            <a href="#story">the difference</a>
            <a href="#pricing">pricing</a>
            <a href="#questions">questions</a>
          </nav>
          <nav className="home-footer-col" aria-label="Legal">
            <p className="home-footer-label">paperwork</p>
            <a href="/privacy">privacy</a>
            <a href="/terms">terms</a>
            <a href="mailto:support@owtomate.com">support@owtomate.com</a>
          </nav>
          <div className="home-footer-col home-footer-meta">
            <p className="home-footer-label">based</p>
            <p>Sydney, Australia</p>
            <p className="home-footer-copyright">&copy; 2026 Owtomate.</p>
          </div>
        </div>
        <a className="home-footer-top" href="#top">back to top &uarr;</a>
      </footer>
    </div>
  );
}
