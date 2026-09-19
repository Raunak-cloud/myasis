import { useEffect, useState } from 'react';

/**
 * Whether Owtomate emails this account when something stops it working:
 * applications running out, a job board signing the account out, runs failing.
 * On unless switched off — here, or from the link at the foot of any of them.
 */
export function EmailAlertsToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/email-alerts')
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => value && typeof value.enabled === 'boolean' && setEnabled(value.enabled))
      .catch(() => {});
  }, []);

  if (enabled === null) return null;

  async function toggle() {
    setSaving(true);
    try {
      const response = await fetch('/api/email-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const value = await response.json();
      if (response.ok && typeof value.enabled === 'boolean') setEnabled(value.enabled);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card email-alerts">
      <div>
        <h3 className="step-title">Email me when something needs my attention</h3>
        <p className="job-meta step-blurb">
          When your applications are nearly used up or gone, when a job board signs you out, or when your runs keep failing.
          One email per problem, never a reminder.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Email me when something needs my attention"
        className={`auto-switch${enabled ? ' on' : ''}`}
        disabled={saving}
        onClick={() => void toggle()}
      >
        <span className="auto-switch-knob" aria-hidden="true" />
      </button>
    </div>
  );
}
