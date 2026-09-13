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

  function start(label = 'Try Myasis for free', subtle = false) {
    return googleConfigured ? <a className={`home-button${subtle ? ' home-button-light' : ''}`} href="/api/auth/google">{label}<Arrow /></a> : <span className="home-unavailable">Sign-in is temporarily unavailable.</span>;
  }

  async function playDemo() {
    if (!video.current) return;
    autoPlayed.current = true;
    setPlayError(false);
    try { await video.current.play(); } catch { setPlayError(true); }
  }

  return <div className="landing" id="top">
    <header className="home-header home-width">
      <a href="#top" className="home-brand" aria-label="Myasis home"><MascotLogo size={40} /><span>Myasis</span></a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a><a href="#questions">Questions?</a></nav>
      {googleConfigured && <a className="home-login" href="/api/auth/google">Sign in <span aria-hidden="true">↗</span></a>}
    </header>

    <main className="home-width">
      <section className="home-intro">
        <div className="home-intro-heading"><h1>Job hunting<br />is a job.<br /><em>Let’s share<br className="home-title-break" /> the workload.</em></h1></div>
        <div className="home-intro-copy"><div className="home-intro-message"><p className="home-intro-lead">Finding the right job is hard enough.<span>Applying shouldn’t be.</span></p><p className="home-intro-detail">Myasis finds roles that fit your experience, handles the forms and cover letters, and applies for you.</p></div>{error && <div className="home-error" role="alert">{error}</div>}{start()}<p className="home-small">{FREE_MONTHLY_APPLICATIONS} free applications a month. No card needed.</p><a href="#demo" className="home-demo-link" onClick={() => { void playDemo(); }}><span aria-hidden="true">↙</span> See a real application, below</a></div>
      </section>

      <section className="home-demo" id="demo" aria-labelledby="demo-heading">
        <div className="home-demo-aside"><span className="home-section-number">01 / SEE IT WORK</span><h2 id="demo-heading">The proof is<br />in the applying.</h2><p>This is Myasis working in a real browser, on a real job application.</p><div className="home-handnote" aria-hidden="true">No mock-ups.<br />Just the actual run.<svg width="76" height="58" viewBox="0 0 76 58" fill="none"><path d="M5 3c5 39 39 12 62 41m-21-1 23 4-1-22" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></div></div>
        <div className="home-demo-main"><div className="home-video-wrap">{LIVE_DEMO.available ? <video ref={video} controls playsInline preload="metadata" poster={LIVE_DEMO.poster} aria-label="Myasis applying to a real job on SEEK" onError={() => setPlayError(true)}><source src={LIVE_DEMO.src} type="video/mp4" /><track kind="captions" src={LIVE_DEMO.captions} srcLang="en" label="English" default />Your browser does not support video. <a href={LIVE_DEMO.src}>Download the recording.</a></video> : <div className="home-recording-pending"><MascotLogo size={60} /><p>The live run is being recorded.</p><span>The finished recording will appear here.</span></div>}</div>{playError && <p className="home-error" role="status">The video could not play. <a href={LIVE_DEMO.src}>Download the recording instead.</a></p>}</div>
      </section>

      <section className="home-explainer" id="how-it-works"><div className="home-section-lead"><span className="home-section-number">02 / HOW IT WORKS</span></div><div className="home-process"><article><span>1.</span><div><h3>Your résumé. Your preferences.</h3><p>Add your documents and tell Myasis the roles, locations and pay you would accept. It checks jobs against those details before applying.</p></div></article><article><span>2.</span><div><h3>Give it a rehearsal.</h3><p>Watch it choose a résumé, write a job-specific cover letter and fill in the forms. Rehearsal mode stops at the submit button for your review.</p></div></article><article><span>3.</span><div><h3>Let it apply. Keep the record.</h3><p>When you’re ready, start a live run. Every application is saved, and anything Myasis cannot answer comes back to you.</p></div></article></div></section>

      <aside className="home-promise"><MascotLogo size={54} /><div><h2>A helpful assistant. An honest application.</h2><p>Myasis won’t invent qualifications, stretch your experience or guess your work rights. Your name is on the application. The facts should be yours, too.</p></div></aside>

      <section className="home-pricing" id="pricing">
        <div className="home-pricing-title">
          <span className="home-section-number">03 / PLANS &amp; PRICING</span>
          <h2>Choose how you want<br /><em>Myasis to run.</em></h2>
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
              {key === 'job-search-pass' && <span className="home-price-popular">Most popular</span>}
              <span className="home-price-mode">{presentation.label}</span>
              <h3>{plan.name}</h3>
              <p className="home-price-copy">{presentation.description}</p>
              <p className="home-price">{aud(plan.priceCents)}<span>one payment · one month</span></p>
              {start('Get started', key !== 'job-search-pass')}
              <ul>{presentation.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
            </article>;
          })}
        </div>
        <p className="home-price-note">Only successful submissions use your application allowance. Paid passes do not renew automatically.</p>
      </section>

      <section className="home-questions" id="questions"><div><span className="home-section-number">04 / A FEW THINGS TO KNOW</span><h2>FAQ.</h2></div><div className="home-faq-list">{QUESTIONS.map(item => <details key={item.question}><summary>{item.question}<span aria-hidden="true">+</span></summary><p>{item.answer}</p></details>)}</div></section>
      <section className="home-last"><div className="home-last-message"><h2>One less thing<br />between you and<br /><em>your next job.</em></h2><p className="home-goodbye">Our favourite goodbye is “I got the job.”<br />The sooner you leave us for your new role, the happier we are.</p></div><div>{start()}<p className="home-small">10 free applications each month.<br />No card needed.</p></div></section>
    </main>
    <footer className="home-footer home-width"><a href="#top" className="home-brand"><MascotLogo size={32} /><span>Myasis</span></a><span>Job applications, with a little help.</span><a href="#top">Back to top ↑</a></footer>
  </div>;
}
