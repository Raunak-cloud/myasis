import './Landing.css';
import { useEffect, useRef, useState } from 'react';
import { FREE_MONTHLY_APPLICATIONS, PAID_PLANS, PLAN_PRESENTATION, aud } from '../pricing';
import { LIVE_DEMO } from '../liveDemo';
import { MascotLogo } from './MascotLogo';

const QUESTIONS = [
  { question: 'Does it actually submit applications?', answer: 'Yes. Live mode submits applications on your behalf. Rehearsal mode fills in the forms and prepares the cover letter, then stops before the final submit. Start with a rehearsal to see exactly how it works.' },
  { question: 'What happens when it cannot answer a question?', answer: 'It pauses that application and puts the question in Needs attention. Myasis uses your profile and documents to answer screening questions; it does not invent work experience, qualifications or work rights.' },
  { question: 'Do I need to give Myasis my SEEK password?', answer: 'No. You sign in to SEEK yourself through your private browser session in Myasis. The application agent reuses that session without asking for your password.' },
  { question: 'Can I see what was sent?', answer: 'Yes. Your application history stores the role, cover letter and screening answers, so you can see what each employer received and keep track of your search.' },
  { question: 'Is there a subscription?', answer: 'No. The free plan resets monthly. Paid passes are one-off purchases, valid for one month, and do not automatically renew. Prices are in Australian dollars.' },
];

function Arrow() {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7" /></svg>;
}

export function Landing({ googleConfigured }: { googleConfigured: boolean }) {
  const [error] = useState(() => new URLSearchParams(location.search).get('auth_error'));
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

  function start(label = 'Start free', subtle = false) {
    return googleConfigured ? <a className={`home-button${subtle ? ' home-button-light' : ''}`} href="/api/auth/google">{label}<Arrow /></a> : <span className="home-unavailable">Sign-in is temporarily unavailable.</span>;
  }

  return <div className="landing" id="top">
    <header className="home-header home-width">
      <a href="#top" className="home-brand" aria-label="Myasis home"><MascotLogo size={40} /><span>Myasis</span></a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a><a href="#questions">Questions?</a></nav>
      {googleConfigured && <div className="home-account-actions"><a className="home-login" href="/api/auth/google">Sign in</a><a className="home-header-cta" href="/api/auth/google">Start free</a></div>}
    </header>

    <main className="home-width">
      <section className="home-intro">
        <div className="home-intro-heading"><span className="home-product-label">Job application assistant</span><h1>Apply for the right jobs.<br /><em>Skip the repetitive forms.</em></h1><p>Myasis checks roles against your experience, chooses the right résumé, writes a tailored cover letter and completes the application.</p></div>
        <div className="home-intro-copy"><div className="home-intro-message"><p className="home-intro-lead">You decide what gets submitted.</p><p className="home-intro-detail">Start in rehearsal mode and review everything at the final button. Switch to live applications only when you are comfortable.</p></div>{error && <div className="home-error" role="alert">{error}</div>}<div className="home-intro-actions">{start()}<a href="#demo">Watch a real application <span aria-hidden="true">↓</span></a></div><p className="home-small">{FREE_MONTHLY_APPLICATIONS} successful applications each month. No card required.</p></div>
      </section>

      <div className="home-source-strip" aria-label="Supported job sources">
        <span>Where Myasis can apply</span>
        <strong>SEEK</strong>
        <strong>Indeed</strong>
        <strong>Employer application sites</strong>
        <small>Availability varies by plan</small>
      </div>

      <section className="home-demo" id="demo" aria-labelledby="demo-heading">
        <div className="home-demo-aside"><span className="home-proof-label">Recorded on SEEK</span><h2 id="demo-heading">Watch a real application run.</h2><p>This is the product working in a real browser—not a dashboard assembled for the homepage.</p><ol className="home-demo-checks"><li>Checks the role against your preferences</li><li>Selects a résumé and writes the cover letter</li><li>Completes the employer’s questions</li><li>Stops before submit in rehearsal mode</li></ol></div>
        <div className="home-demo-main"><div className="home-video-wrap"><div className="home-video-bar"><span>Myasis / application run</span><span>Rehearsal mode</span></div>{LIVE_DEMO.available ? <video ref={video} controls playsInline preload="metadata" poster={LIVE_DEMO.poster} aria-label="Myasis applying to a real job on SEEK" onError={() => setPlayError(true)}><source src={LIVE_DEMO.src} type="video/mp4" /><track kind="captions" src={LIVE_DEMO.captions} srcLang="en" label="English" default />Your browser does not support video. <a href={LIVE_DEMO.src}>Download the recording.</a></video> : <div className="home-recording-pending"><MascotLogo size={60} /><p>The live run is being recorded.</p><span>The finished recording will appear here.</span></div>}</div>{playError && <p className="home-error" role="status">The video could not play. <a href={LIVE_DEMO.src}>Download the recording instead.</a></p>}</div>
      </section>

      <section className="home-explainer" id="how-it-works"><div className="home-section-lead"><span>From your profile to Applications</span><h2>What happens after you press Run</h2><p>The same sequence runs every time. You can watch it, stop it and check the application record afterwards.</p></div><div className="home-process"><article><span>1</span><div><h3>Set the jobs worth applying for</h3><p>Add your documents, target roles, locations, salary range and deal-breakers. Myasis checks every role against those details before opening the form.</p></div></article><article><span>2</span><div><h3>Check the work in rehearsal mode</h3><p>Watch Myasis choose a résumé, draft a job-specific cover letter and complete the questions. It stops at the submit button.</p></div></article><article><span>3</span><div><h3>Submit when you are comfortable</h3><p>Switch to live mode when you are ready. The role, cover letter and screening answers are saved together in your application history.</p></div></article></div></section>

      <aside className="home-promise"><MascotLogo size={54} /><div><span>When the answer is not in your profile</span><h2>Myasis stops and asks.</h2><p>It will not invent qualifications, stretch your experience or guess your work rights. The unanswered item appears in Needs attention for you to resolve.</p></div></aside>

      <section className="home-pricing" id="pricing">
        <div className="home-pricing-title">
          <div><span>Plans &amp; pricing</span><h2>Match the allowance to this month’s job search.</h2></div>
          <p>Every plan includes personalised cover letters and an application record. Only successful submissions use the allowance.</p>
        </div>
        <div className="home-price-grid">
          <article className="home-price-card">
            <span className="home-price-mode">{PLAN_PRESENTATION.free.label}</span>
            <h3>Free</h3>
            <p className="home-price-copy">{PLAN_PRESENTATION.free.description}</p>
            <p className="home-price">A$0<span>monthly allowance</span></p>
            {start('Start free', true)}
            <ul>{PLAN_PRESENTATION.free.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
          </article>
          {(['job-search-pass', 'intensive-pass'] as const).map(key => {
            const plan = PAID_PLANS[key];
            const presentation = PLAN_PRESENTATION[key];
            return <article className={`home-price-card${key === 'job-search-pass' ? ' featured' : ''}`} key={key}>
              {key === 'job-search-pass' && <span className="home-price-popular">Most often chosen</span>}
              <span className="home-price-mode">{presentation.label}</span>
              <h3>{plan.name}</h3>
              <p className="home-price-copy">{presentation.description}</p>
              <p className="home-price">{aud(plan.priceCents)}<span>one payment · one month</span></p>
              {start(key === 'job-search-pass' ? 'Choose Job Search Pass' : 'Choose Intensive Pass', key !== 'job-search-pass')}
              <ul>{presentation.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
            </article>;
          })}
        </div>
        <p className="home-price-note">Only successful submissions use your application allowance. Paid passes do not renew automatically.</p>
      </section>

      <section className="home-questions" id="questions"><div><span>Before the first run</span><h2>Questions people usually ask</h2><p>Especially the ones about control, passwords and what gets sent.</p></div><div className="home-faq-list">{QUESTIONS.map(item => <details key={item.question}><summary>{item.question}<span aria-hidden="true">+</span></summary><p>{item.answer}</p></details>)}</div></section>
      <section className="home-last"><div className="home-last-message"><span className="home-goodbye-lead">What success looks like</span><p className="home-goodbye">“I got the job.”</p><p className="home-goodbye-detail">The sooner you leave Myasis for a new role, the happier we are.</p></div><div className="home-last-action">{start()}<p className="home-small">{FREE_MONTHLY_APPLICATIONS} submitted applications each month.<br />No card needed.</p></div></section>
    </main>
    <footer className="home-footer home-width"><a href="#top" className="home-brand"><MascotLogo size={32} /><span>Myasis</span></a><span>Job applications, with a little help.</span><a href="#top">Back to top ↑</a></footer>
  </div>;
}
