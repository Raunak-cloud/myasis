import { useEffect, useState } from 'react';

function EmailPreferenceToggle({ endpoint, title, description }: { endpoint: string; title: string; description: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const response = await fetch(endpoint);
      const value = await response.json();
      if (!response.ok || typeof value.enabled !== 'boolean') throw new Error();
      setEnabled(value.enabled);
    } catch { setError('Could not load this email preference. Please retry.'); }
  }
  useEffect(() => { void load(); }, [endpoint]);

  async function toggle() {
    setSaving(true); setError('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) });
      const value = await response.json();
      if (!response.ok || typeof value.enabled !== 'boolean') throw new Error();
      setEnabled(value.enabled);
    } catch { setError('Could not save this email preference. Please retry.'); }
    finally { setSaving(false); }
  }

  return <div className="card email-alerts">
    <div>
      <h3 className="step-title">{title}</h3>
      <p className="job-meta step-blurb">{description}</p>
      {error && <p role="alert" className="job-meta">{error} {enabled === null && <button type="button" className="btn" onClick={() => void load()}>Retry</button>}</p>}
    </div>
    <button type="button" role="switch" aria-checked={enabled === true} aria-label={title}
      className={`auto-switch${enabled ? ' on' : ''}`} disabled={enabled === null || saving} onClick={() => void toggle()}>
      <span className="auto-switch-knob" aria-hidden="true" />
    </button>
  </div>;
}

export function EmailAlertsToggle() {
  return <EmailPreferenceToggle endpoint="/api/email-alerts" title="Email me when something needs my attention"
    description="When your applications are nearly used up or gone, when a job board signs you out, or when your runs keep failing. One email per problem, never a reminder." />;
}

export function DailySummaryToggle() {
  return <EmailPreferenceToggle endpoint="/api/daily-summary" title="Email me my daily summary"
    description="A summary of your applications and anything needing your attention, sent at 9 p.m. Sydney time on days with activity. This is separate from attention alerts." />;
}
