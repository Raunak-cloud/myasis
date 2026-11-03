import { useState } from 'react';
import { SECURITY_RETRY_DELAY_MS, securityRetryAt } from '../securityRetry';
import { SecurityRetryControl } from './SecurityRetryControl';

/** Fictional data and local state only: no account, API request, approval or send. */
export function SecurityRetrySimulation() {
  const [blockedAt] = useState(Date.now);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState('');
  return <section className="card admin-section security-retry-simulation" aria-label="Security retry simulation">
    <h3>Security retry cooldown</h3>
    <p className="job-meta">Customer preview · fictional application. Nothing is sent.</p>
    <div className="security-retry-preview-controls" role="group" aria-label="Preview elapsed time">
      {[{label:'Just blocked',ms:0},{label:'4 hours later',ms:4 * 60 * 60_000},{label:'8 hours later',ms:SECURITY_RETRY_DELAY_MS}].map(step =>
        <button type="button" className={`chip${elapsed === step.ms ? ' on' : ''}`} aria-pressed={elapsed === step.ms}
          key={step.ms} onClick={() => { setElapsed(step.ms); setNotice(''); }}>{step.label}</button>)}
    </div>
    <article className="prepared-application security-retry-preview">
      <span className="prepared-job"><strong>Data Analyst</strong><span className="job-meta">Example employer · Sydney</span></span>
      <span className="prepared-status failed">Not completed</span>
      <p className="job-meta prepared-detail">The site's security check could not be completed.</p>
      <SecurityRetryControl retry={{reason:'site-security',retryAt:securityRetryAt(new Date(blockedAt))!}} now={blockedAt + elapsed}
        onRetry={() => setNotice('Preview only. No application was started or submitted.')} />
    </article>
    {notice && <p className="job-meta" role="status">{notice}</p>}
  </section>;
}
