import { useState } from 'react';

const SUPPORT_EMAIL = 'support@owtomate.com';

export function SupportPanel() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyEmail = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(SUPPORT_EMAIL);
      } else {
        const field = document.createElement('textarea');
        field.value = SUPPORT_EMAIL;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('Copy command was refused');
      }
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

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
          <button type="button" className="btn primary support-email" onClick={copyEmail}>
            {copyState === 'copied' ? 'Copied support@owtomate.com' : 'Email support@owtomate.com'}
          </button>
          <span className={`support-copy-status ${copyState}`} role="status" aria-live="polite">
            {copyState === 'copied' && 'Email address copied to your clipboard.'}
            {copyState === 'failed' && 'Could not copy automatically. The address is support@owtomate.com.'}
          </span>
        </div>
      </article>
      <p className="job-meta support-note">Include the email address used for your Owtomate account and a short description of what happened. Never send your password or verification codes.</p>
    </section>
  );
}
