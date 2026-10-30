import { useEffect, useState } from 'react';
import { api } from '../adminApi';
import type { RunDiagnostics as Diagnostics } from '../run-diagnostics';
import { TraceSteps } from './AttentionPanel';

/** Operator-only detail; ordinary applicant activity keeps its simple wording. */
export function RunDiagnostics({ runId }: { runId: string }) {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api<Diagnostics>(`/runs/${runId}/diagnostics`)
      .then(value => { if (!cancelled) { setData(value); setError(''); } })
      .catch(reason => { if (!cancelled) setError(String(reason.message)); });
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [runId]);
  return <section className="run-diagnostics" aria-label="Run errors and attempts">
    <h3>Errors and recovery · Run #{runId}</h3>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p>Loading diagnostics…</p>}
    {data && <>
      <p>{data.issues.length} recorded error/warning {data.issues.length === 1 ? 'event' : 'events'} · {data.attempts.length} application {data.attempts.length === 1 ? 'attempt' : 'attempts'}</p>
      <p className="job-meta">{data.note} Detailed traces are retained for {data.retentionDays} days.</p>
      <a href={`/api/admin/runs/${runId}/diagnostics`} target="_blank" rel="noreferrer">Open diagnostic report</a>
      {data.issues.map(issue => <details key={issue.id} className="run-issue">
        <summary><span className={`badge ${issue.severity === 'error' ? 'bad' : 'warn'}`}>{issue.category}</span>{' '}
          {issue.tool ?? issue.stage}{issue.step !== undefined ? ` · step ${issue.step}` : ''}
          {issue.batchIndex !== undefined ? ` · batch action ${issue.batchIndex + 1}` : ''}{' · '}{issue.message.slice(0, 160)}
        </summary>
        <p className="job-meta">{issue.at} · {issue.title ?? 'Run-level event'}{issue.attemptId ? ` · attempt ${issue.attemptId}` : ''}</p>
        <pre>{issue.message}{issue.stack?.length ? '\n' + issue.stack.join('\n') : ''}</pre>
        {issue.attemptId && <button className="btn btn-small" onClick={() => setAttempt(issue.attemptId!)}>View this attempt’s steps</button>}
      </details>)}
      {data.attempts.map(item => <div className="run-attempt" key={item.attemptId}>
        <strong>{item.title}</strong> · {item.company} · {item.mode} · {item.outcome ?? 'No final outcome recorded'}{' '}
        <button className="btn btn-small" onClick={() => setAttempt(current => current === item.attemptId ? null : item.attemptId)}>View steps</button>
      </div>)}
      {attempt && <><button className="btn btn-small" onClick={() => setAttempt(null)}>Close steps</button>
        <TraceSteps jobId="" endpoint={`/api/admin/runs/${runId}/attempts/${attempt}`} /></>}
    </>}
  </section>;
}
