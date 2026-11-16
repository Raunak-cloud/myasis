import { useEffect, useState } from 'react';

export interface HrOutreachProgress {
  active: boolean;
  phase: string | null;
  title: string | null;
  company: string | null;
  queued: number;
  sent: number;
  skipped: number;
  failed: number;
  runId: string | null;
}

export function hrPhaseLabel(phase: string | null | undefined): string {
  return ({ queued: 'Queued', researching: 'Finding contact', writing: 'Writing email', sending: 'Sending email', checking: 'Checking delivery', waiting: 'Waiting for run', 'waiting-for-run': 'Waiting for run', finished: 'Finished' } as Record<string, string>)[phase ?? ''] ?? 'Working';
}

export function HrOutreachActivity({ progress, error = false, link = false }: {
  progress: HrOutreachProgress | null; error?: boolean; link?: boolean;
}) {
  if (!progress || (!progress.active && progress.phase !== 'waiting' && !progress.queued && !progress.sent && !progress.skipped && !progress.failed)) {
    return error ? <p className="job-meta" role="status">HR email status is temporarily unavailable.</p> : null;
  }
  const waiting = ['waiting', 'waiting-for-run'].includes(progress.phase ?? '');
  const phase = waiting ? 'Waiting for run' : progress.phase === 'queued' ? 'Queued' : progress.active ? hrPhaseLabel(progress.phase) : 'Finished';
  return <section className="card hr-outreach-activity" role="status" aria-live="polite" aria-atomic="true">
    <div className="hr-email-heading"><strong>HR emails</strong><span className={`badge ${progress.active ? 'info' : 'muted'}`}>{phase}</span></div>
    {waiting ? <p className="job-meta">Your application run is still finishing. HR emails will start afterwards.</p>
      : progress.active && (progress.title || progress.company) ? <p className="job-meta">{[progress.title, progress.company].filter(Boolean).join(' · ')}</p> : null}
    <p className="hr-outreach-counts">{progress.sent} sent · {progress.queued} waiting · {progress.skipped} not sent · {progress.failed} need attention</p>
    {error && <p className="job-meta">Could not refresh the status. Showing the last update.</p>}
    {link && <a href="/?tab=applications">Open Submitted Applications</a>}
  </section>;
}

/** Mounted only for administrators. Status requests never start outreach. */
export function LiveHrOutreachActivity({ enabled }: { enabled: boolean }) {
  const [progress, setProgress] = useState<HrOutreachProgress | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) { setProgress(null); setError(false); return; }
    let active = true;
    let pending = false;
    const controller = new AbortController();
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch('/api/hr-outreach?activity=1', { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.progress || typeof result.progress.active !== 'boolean') throw new Error();
        if (active) { setProgress(result.progress); setError(false); }
      } catch { if (active) setError(true); }
      finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [enabled]);
  return enabled ? <HrOutreachActivity progress={progress} error={error} link /> : null;
}
