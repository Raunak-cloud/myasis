import { useEffect, useState } from 'react';
import { api } from '../adminApi';
import type { RunDiagnostics as Diagnostics } from '../run-diagnostics';
import { TraceSteps } from './AttentionPanel';

const jobStatuses: Record<string, { label: string; tone: string }> = {
  applied: { label: 'Submitted', tone: 'ok' },
  prepared: { label: 'Prepared', tone: 'info' },
  skipped: { label: 'Skipped', tone: 'muted' },
  'already-applied': { label: 'Already applied', tone: 'info' },
  error: { label: 'Failed', tone: 'bad' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
  'needs-human': { label: 'Needs your input', tone: 'warn' },
  rehearsed: { label: 'Test completed', tone: 'info' },
};

/** Screenshots for operators. Raw diagnostics remain available to backend inspection. */
export function RunDiagnostics({ runId }: { runId: string }) {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api<Diagnostics>(`/runs/${runId}/diagnostics`)
      .then(value => { if (!cancelled) { setData(value); setError(''); } })
      .catch(() => { if (!cancelled) setError('Could not load screenshots. Please try again.'); });
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [runId]);
  return <section className="run-diagnostics" aria-label="Application screenshots">
    <h3>Application screenshots</h3>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p>Loading screenshots…</p>}
    {data && <>
      {data.attempts.length === 0 && <p>No application screenshots are available yet.</p>}
      {data.attempts.map(item => {
        const status = jobStatuses[item.outcome ?? ''] ?? {
          label: data.live ? 'In progress' : 'Status unavailable', tone: 'muted',
        };
        return <div className="run-attempt" key={item.attemptId}>
        <strong>{item.title}</strong> · {item.company}{' '}
        <span className={`badge ${status.tone}`} aria-label={`Application status: ${status.label}`}>{status.label}</span>{' '}
        <button className="btn btn-small" onClick={() => setAttempt(current => current === item.attemptId ? null : item.attemptId)}>View screenshots</button>
      </div>;})}
      {attempt && <><button className="btn btn-small" onClick={() => setAttempt(null)}>Close screenshots</button>
        <TraceSteps jobId="" endpoint={`/api/admin/runs/${runId}/attempts/${attempt}`} /></>}
    </>}
  </section>;
}
