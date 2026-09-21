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

      <section className="card support-faq" aria-labelledby="support-faq-heading">
        <h2 id="support-faq-heading">Frequently asked questions</h2>
        <div className="support-faq-list">
          <details>
            <summary>What counts toward my application allowance?</summary>
            <p>Only applications that are successfully submitted count. Jobs that are skipped, rejected as a poor match or fail before submission do not reduce your allowance.</p>
          </details>
          <details>
            <summary>Why did a run finish without submitting anything?</summary>
            <p>The jobs found may have already been seen, fallen outside your preferences or scored below your minimum match. Check the run activity for the reason each job was skipped.</p>
          </details>
          <details>
            <summary>What happens when Owtomate cannot answer a question?</summary>
            <p>It does not guess. The application is paused and placed in Needs attention so you can provide the missing answer.</p>
          </details>
          <details>
            <summary>How do I update my résumé or job preferences?</summary>
            <p>Open Settings to replace your documents, update your profile and change what you are looking for. Your saved changes apply to future runs.</p>
          </details>
          <details>
            <summary>What should I do if SEEK or Indeed is signed out?</summary>
            <p>Open Job boards from the account section of the sidebar and sign in again. Owtomate will reuse that private session for later applications.</p>
          </details>
          <details>
            <summary>Do paid passes renew automatically?</summary>
            <p>No. Paid passes are one-off purchases and do not auto-renew. You can buy another pass or a top-up from Plans &amp; pricing when needed.</p>
          </details>
          <details>
            <summary>Where can I see what was submitted?</summary>
            <p>Open Applications to see each role, its status and the information sent with the application.</p>
          </details>
        </div>
      </section>
    </section>
  );
}
