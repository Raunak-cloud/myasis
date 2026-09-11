import './Landing.css';
import { useEffect, useRef, useState } from 'react';
import { FREE_MONTHLY_APPLICATIONS, FREE_MONTHLY_REHEARSALS, PAID_PLANS, aud } from '../pricing';
import { LIVE_DEMO } from '../liveDemo';

const QUESTIONS = [
  { question: 'Does it actually submit applications?', answer: 'Yes. Live mode submits applications on your behalf. Rehearsal mode fills in the forms and prepares the cover letter, then stops before the final submit. Start with a rehearsal to see exactly how it works.' },
  { question: 'What happens when it cannot answer a question?', answer: 'It pauses that application and puts the question in Needs attention. Myasis uses your profile and documents to answer screening questions; it does not invent work experience, qualifications or work rights.' },
  { question: 'Do I need to give Myasis my SEEK password?', answer: 'No. You sign in to SEEK yourself through your private browser session in Myasis. The application agent reuses that session without asking for your password.' },
  { question: 'Can I see what was sent?', answer: 'Yes. Your application history stores the role, cover letter and screening answers, so you can see what each employer received and keep track of your search.' },
  { question: 'Is there a subscription?', answer: 'No. The free plan resets monthly. Paid passes are one-off purchases, valid for 30 days, and do not automatically renew. Prices are in Australian dollars.' },
];

function Arrow() {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7" /></svg>;
}

export function Landing({ googleConfigured }: { googleConfigured: boolean }) {
  const [error] = useState(() => new URLSearchParams(location.search).get('auth_error'));
  const [playError, setPlayError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!error) return;
    const url = new URL(location.href);
    url.searchParams.delete('auth_error');
    history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [error]);

  function start(label = 'Try Myasis for free', subtle = false) {
    return googleConfigured ? <a className={`home-button${subtle ? ' home-button-light' : ''}`} href="/api/auth/google">{label}<Arrow /></a> : <span className="home-unavailable">Sign-in is temporarily unavailable.</span>;
  }

  async function playDemo() {
    if (!video.current) return;
    setPlayError(false);
    try { await video.current.play(); } catch { setPlayError(true); }
  }

  return <div className="landing" id="top">
    <header className="home-header home-width">
      <a href="#top" className="home-brand" aria-label="Myasis home"><img src="/favicon.svg" width="40" height="40" alt="" /><span>Myasis</span></a>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#pricing">Pricing</a><a href="#questions">Questions?</a></nav>
      {googleConfigured && <a className="home-login" href="/api/auth/google">Sign in <span aria-hidden="true">↗</span></a>}
    </header>

    <main className="home-width">
      <section className="home-intro">
        <div className="home-intro-heading"><p className="home-overline">A job application assistant for SEEK</p><h1>Job hunting<br />is a job.<br /><em>Let’s share<br className="home-title-break" /> the workload.</em></h1></div>
        <div className="home-intro-copy"><p>You’ve found a role you like. Now there’s another form, another cover letter, another set of questions you’ve answered before.</p><p>Myasis takes care of that part. It finds roles that fit your experience, prepares the paperwork and applies on your behalf.</p>{error && <div className="home-error" role="alert">{error}</div>}{start()}<p className="home-small">{FREE_MONTHLY_APPLICATIONS} free applications a month. No card needed.</p><a href="#demo" className="home-demo-link" onClick={() => { void playDemo(); }}><span aria-hidden="true">↙</span> See a real application, below</a></div>
      </section>

      <section className="home-demo" id="demo" aria-labelledby="demo-heading">
        <div className="home-demo-aside"><span className="home-section-number">01 / SEE IT WORK</span><h2 id="demo-heading">The proof is<br />in the applying.</h2><p>This is Myasis working in a real browser, on a real job application.</p><p className="home-small">Edited for length.<br />Personal details hidden.</p><div className="home-handnote" aria-hidden="true">No mock-ups.<br />Just the actual run.<svg width="76" height="58" viewBox="0 0 76 58" fill="none"><path d="M5 3c5 39 39 12 62 41m-21-1 23 4-1-22" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></div></div>
        <div className="home-demo-main"><div className="home-video-top"><span><i /> MYASIS / LIVE RECORDING</span><span>SEEK</span></div><div className="home-video-wrap">{LIVE_DEMO.available ? <video ref={video} controls playsInline preload="metadata" poster={LIVE_DEMO.poster} aria-label="Myasis applying to a real job on SEEK" aria-describedby="demo-description" onError={() => setPlayError(true)}><source src={LIVE_DEMO.src} type="video/mp4" /><track kind="captions" src={LIVE_DEMO.captions} srcLang="en" label="English" default />Your browser does not support video. <a href={LIVE_DEMO.src}>Download the recording.</a></video> : <div className="home-recording-pending"><img src="/favicon.svg" width="60" height="60" alt="" /><p>The live run is being recorded.</p><span>The finished recording will appear here.</span></div>}</div><div className="home-video-caption" id="demo-description"><span>{LIVE_DEMO.available ? LIVE_DEMO.description : 'Live recording in progress.'}</span>{LIVE_DEMO.available && <a href={LIVE_DEMO.src} download>Download film ↗</a>}</div>{playError && <p className="home-error" role="status">The video could not play. <a href={LIVE_DEMO.src}>Download the recording instead.</a></p>}{LIVE_DEMO.available && <details className="home-transcript"><summary>Video transcript</summary><p>{LIVE_DEMO.transcript}</p></details>}</div>
      </section>

      <section className="home-explainer" id="how-it-works"><div className="home-section-lead"><span className="home-section-number">02 / HOW IT WORKS</span><h2>You know what<br />you’re looking for.<br /><em>Start there.</em></h2><p>You choose the direction.<br />Myasis handles the repetition.</p></div><div className="home-process"><article><span>1.</span><div><h3>Your résumé. Your preferences.</h3><p>Add your documents and tell Myasis the roles, locations and pay you would accept. It checks jobs against those details before applying.</p></div></article><article><span>2.</span><div><h3>Give it a rehearsal.</h3><p>Watch it choose a résumé, write a job-specific cover letter and fill in the forms. Rehearsal mode stops at the submit button for your review.</p></div></article><article><span>3.</span><div><h3>Let it apply. Keep the record.</h3><p>When you’re ready, start a live run. Every application is saved, and anything Myasis cannot answer comes back to you.</p></div></article></div></section>

      <aside className="home-promise"><img src="/favicon.svg" width="54" height="54" alt="" /><div><h2>A helpful assistant. An honest application.</h2><p>Myasis won’t invent qualifications, stretch your experience or guess your work rights. Your name is on the application. The facts should be yours, too.</p></div></aside>

      <section className="home-pricing" id="pricing"><div className="home-pricing-title"><span className="home-section-number">03 / WHAT IT COSTS</span><h2>A fair price.<br /><em>No ongoing commitment.</em></h2><p>Start free. Buy a pass if you need more.<br />All prices in AUD. Nothing auto-renews.</p></div><div className="home-price-list"><article className="home-price-row"><div><h3>Free</h3><p>For getting started</p></div><ul><li>{FREE_MONTHLY_APPLICATIONS} applications / month</li><li>{FREE_MONTHLY_REHEARSALS} rehearsals / month</li></ul><p className="home-price">A$0<span>per month</span></p>{start('Start free', true)}</article>{(['job-search-pass', 'intensive-pass'] as const).map(key => { const plan = PAID_PLANS[key]; return <article className="home-price-row" key={key}><div><h3>{plan.name}</h3><p>{key === 'job-search-pass' ? 'For an active search' : 'For a broader search'}</p></div><ul><li>{plan.applications} applications / {plan.validDays} days</li><li>Unlimited rehearsals while active</li>{key === 'intensive-pass' && <li>Supported employer-site applications</li>}</ul><p className="home-price">{aud(plan.priceCents)}<span>one-off</span></p>{start('Get started', true)}</article>; })}<p className="home-price-note">Every plan includes personalised cover letters and a record of your applications.</p></div></section>

      <section className="home-questions" id="questions"><div><span className="home-section-number">04 / A FEW THINGS TO KNOW</span><h2>Good questions.</h2></div><div className="home-faq-list">{QUESTIONS.map(item => <details key={item.question}><summary>{item.question}<span aria-hidden="true">+</span></summary><p>{item.answer}</p></details>)}</div></section>
      <section className="home-last"><h2>One less thing<br />between you and<br /><em>your next job.</em></h2><div>{start()}<p className="home-small">Start with a free rehearsal.<br />See what Myasis can do with your experience.</p></div></section>
    </main>
    <footer className="home-footer home-width"><a href="#top" className="home-brand"><img src="/favicon.svg" width="32" height="32" alt="" /><span>Myasis</span></a><span>Job applications, with a little help.</span><a href="#top">Back to top ↑</a></footer>
  </div>;
}
