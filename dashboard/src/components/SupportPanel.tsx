export function SupportPanel() {
  return (
    <section className="support-page" aria-labelledby="support-heading">
      <article className="card support-card">
        <div className="support-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16v12H4z" />
            <path d="m4 7 8 6 8-6" />
          </svg>
        </div>
        <div className="support-copy">
          <h2 id="support-heading">Contact support</h2>
          <p>Need help with your account, applications, billing or a technical issue? Send us an email and we will help you sort it out.</p>
          <a className="btn primary support-email" href="mailto:support@owtomate.com?subject=Owtomate%20support">
            Email support@owtomate.com
          </a>
        </div>
      </article>
      <p className="job-meta support-note">Include the email address used for your Owtomate account and a short description of what happened. Never send your password or verification codes.</p>
    </section>
  );
}
