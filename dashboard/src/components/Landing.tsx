import './Landing.css';
import { useEffect, useRef, useState } from 'react';
import { FREE_APPLICATIONS, HUMANIZER_NOTE, PAID_PLANS, PLAN_PRESENTATION, aud } from '../pricing';
import { LIVE_DEMO } from '../liveDemo';
import { MascotLogo } from './MascotLogo';
import { Wordmark } from './Wordmark';
import { HeroStory } from './HeroStory';

const QUESTIONS = [
  { question: 'Does it actually submit applications?', answer: 'Yes. Owtomate submits applications on your behalf, using your résumé, your preferences and a cover letter written for each job. Every application is saved, so you can see exactly what was sent.' },
  { question: 'What happens when it cannot answer a question?', answer: 'It pauses that application and puts the question in Needs attention. Owtomate uses your profile and documents to answer screening questions; it does not invent work experience, qualifications or work rights.' },
  { question: 'Do I need to give Owtomate my SEEK password?', answer: 'No. You sign in to SEEK yourself through your private browser session in Owtomate. The application agent reuses that session without asking for your password.' },
  { question: 'Can I see what was sent?', answer: 'Yes. Your application history stores the role, cover letter and screening answers, so you can see what each employer received and keep track of your search.' },
  { question: 'Is there a subscription?', answer: 'No. The free plan is a one-time allowance. Paid passes are one-off purchases, valid for 30 days, and do not automatically renew. Prices are in Australian dollars.' },
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

  function start(label = 'Try Owtomate for free', subtle = false) {
    return googleConfigured ? <a className={`home-button${subtle ? ' home-button-light' : ''}`} href="/api/auth/google">{label}<Arrow /></a> : <span className="home-unavailable">Sign-in is temporarily unavailable.</span>;
  }

  return <div className="landing" id="top">
    <header className="home-header home-width">
      <a href="#top" className="home-brand" aria-label="owtomate home"><Wordmark /></a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a><a href="#questions">Questions?</a></nav>
      {googleConfigured && <a className="home-login" href="/api/auth/google">Sign in <span aria-hidden="true">↗</span></a>}
    </header>

    <main className="home-width">
      {/* The offer and the proof of it. How it works comes after, so the page opens on the point. */}
      <section className="home-intro" aria-labelledby="home-heading">
        <div className="home-intro-heading">
          <h1 id="home-heading">Job hunting is a job.<em>Not anymore 😌</em></h1>
          <p className="home-hero-summary">Owtomate finds suitable roles, prepares tailored cover letters and handles the repetitive parts of applying.</p>
          {error && <div className="home-error" role="alert">{error}</div>}
          <div className="home-hero-actions">{start()}</div>
          <p className="home-small">{FREE_APPLICATIONS} free applications. No card needed.</p>
        </div>
        <div className="home-hero-demo" id="demo">
          <div className="home-hero-video-top"><span>Real application run</span></div>
          <div className="home-video-wrap">{LIVE_DEMO.available ? <video ref={video} controls playsInline preload="metadata" poster={LIVE_DEMO.poster} aria-label="Owtomate applying to a real job on SEEK" onError={() => setPlayError(true)}><source src={LIVE_DEMO.src} type="video/mp4" /><track kind="captions" src={LIVE_DEMO.captions} srcLang="en" label="English" default />Your browser does not support video. <a href={LIVE_DEMO.src}>Download the recording.</a></video> : <div className="home-recording-pending"><MascotLogo size={60} /><p>The live run is being recorded.</p><span>The finished recording will appear here.</span></div>}</div>
          {playError && <p className="home-error" role="status">The video could not play. <a href={LIVE_DEMO.src}>Download the recording instead.</a></p>}
        </div>
      </section>

      <section className="home-story"><HeroStory /></section>

      <section className="home-explainer" id="how-it-works"><div className="home-process"><article><span className="home-step-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/></svg></span><div><h3>Your résumé. Your preferences.</h3><p>Add your documents and tell Owtomate the roles, locations and pay you would accept. It checks jobs against those details before applying.</p></div></article><article><span className="home-step-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span><div><h3>Written for every job.</h3><p>Owtomate chooses the right résumé, writes a job-specific cover letter and fills in each form from your profile.</p></div></article><article><span className="home-step-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg></span><div><h3>Let it apply. Keep the record.</h3><p>Owtomate submits each application and saves what was sent. Anything it cannot answer comes back to you.</p></div></article></div></section>


      <aside className="home-promise"><MascotLogo size={54} /><div><h2>A helpful assistant. An honest application.</h2><p>Owtomate won’t invent qualifications, stretch your experience or guess your work rights. Your name is on the application. The facts should be yours, too.</p></div></aside>

      <section className="home-pricing" id="pricing">
        <div className="home-pricing-title">
          <h2>Choose a Owtomate pass.<br /><em>Pay once. No recurring charges.</em></h2>
        </div>
        <div className="home-price-grid">
          <article className="home-price-card">
            <span className="home-price-mode">{PLAN_PRESENTATION.free.label}</span>
            <h3>Free</h3>
            <p className="home-price-copy">{PLAN_PRESENTATION.free.description}</p>
            <p className="home-price">A$0<span>no card needed</span></p>
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
              <p className="home-price">{aud(plan.priceCents)}<span>one-time payment · valid 30 days</span></p>
              {start('Get started', key !== 'job-search-pass')}
              <ul>{presentation.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
            </article>;
          })}
        </div>
        <p className="home-price-note">Only successful submissions use your application allowance. Paid passes do not renew automatically. {HUMANIZER_NOTE}</p>
      </section>

      <section className="home-questions" id="questions"><div className="home-faq-list">{QUESTIONS.map(item => <details key={item.question}><summary>{item.question}<span aria-hidden="true">+</span></summary><p>{item.answer}</p></details>)}</div></section>
      <section className="home-last"><div className="home-last-message"><span className="home-goodbye-lead">Our favourite goodbye</span><p className="home-goodbye">“I got the job.”</p><p className="home-goodbye-detail">The sooner you leave us for your new role, the happier we are.</p></div><div className="home-last-action">{start()}<p className="home-small">{FREE_APPLICATIONS} free applications.<br />No card needed.</p></div></section>
    </main>
    <footer className="home-footer home-width"><a href="#top" className="home-brand" aria-label="owtomate home"><Wordmark /></a><span>Job applications, with a little help.</span><a href="#top">Back to top ↑</a></footer>
  </div>;
}
