import { useState } from 'react';

export function AdminScreenshotTest({ enabled, disabled, onSaved, onSavingChange }: {
  enabled: boolean;
  disabled: boolean;
  onSaved: (settings: Record<string, string>) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    if (disabled || saving) return;
    setSaving(true);
    onSavingChange(true);
    setError(null);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { APPLICATION_AGENT_SCREENSHOTS_EVERY_TURN: enabled ? 'false' : 'true' } }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not save screenshot testing.');
      onSaved(body.settings);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save screenshot testing.');
    } finally { setSaving(false); onSavingChange(false); }
  }
  return <section className="card" aria-labelledby="screenshot-test-title">
    <div className="panel-body">
      <h2 id="screenshot-test-title">Admin screenshot test</h2>
      <div className="run-admin-mode-control">
        <span id="screenshot-each-step-label">Screenshots each step</span>
        <button type="button" role="switch" aria-checked={enabled} aria-labelledby="screenshot-each-step-label"
          className={`auto-switch${enabled ? ' on' : ''}`} disabled={disabled || saving} onClick={() => void toggle()}>
          <span className="auto-switch-knob" aria-hidden="true" />
        </button>
        <span className="job-meta" role="status">{saving ? 'Saving…' : enabled ? 'On' : 'Off'}</span>
      </div>
      <p className="job-meta">Gives Magnus a fresh screenshot before each decision, keeping only the latest picture. May increase cost and time. Saves immediately for your next run.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  </section>;
}
