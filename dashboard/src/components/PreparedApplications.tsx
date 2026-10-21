import { useEffect, useState } from 'react';
interface Review {
  id: string; status: string; detail: string | null;
  application: {
    revision: string; job: { title: string; company: string; location: string; url: string };
    resume?: string; coverLetter?: string; answers: Array<{ question: string; answer: string }>;
  };
}

export function PreparedApplications({ running, onStarted, onCountChange }: { running: boolean; onStarted: () => void; onCountChange: (count: number) => void }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    const response = await fetch('/api/application-reviews');
    if (!response.ok) throw new Error('Could not load prepared applications.');
    const data = await response.json();
    const applications: Review[] = Array.isArray(data.applications) ? data.applications : [];
    setReviews(applications);
    onCountChange(applications.filter(item => item.status === 'ready').length);
  };
  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive) void load().catch(reason => { if (alive) setError(reason.message); }); };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [running, onCountChange]);
  const chosen = reviews.filter(item => item.status === 'ready' && selected.has(item.id));
  async function decide(action: 'submit' | 'dismiss') {
    if (busy || running || !chosen.length) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/application-reviews/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: action === 'submit', applications: chosen.map(item => ({ id: item.id, revision: item.application.revision })) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save your choice.');
      setSelected(new Set());
      await load();
      if (action === 'submit') onStarted();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="card prepared-applications" aria-label="Prepared applications">
    <p className="job-meta">Semi auto fills the forms for you. Review the answers and documents, then confirm the jobs you want Owtomate to apply to. Unselected jobs stay here.</p>
    {error && <div className="banner banner-bad" role="alert">{error}</div>}
    {!reviews.length && <p>No prepared applications yet. Choose Semi auto on the <a href="/?tab=run">Apply page</a> and start a run to curate jobs and fill their forms.</p>}
    {reviews.map(item => {
      const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim();
      const coverLetter = normalizeText(item.application.coverLetter || '');
      const answers = item.application.answers.filter(answer => !coverLetter || normalizeText(answer.answer) !== coverLetter);
      return <article className="prepared-application" key={item.id}>
      <label className="prepared-choice"><input type="checkbox" aria-label={`Select ${item.application.job.title} at ${item.application.job.company}`}
        disabled={item.status !== 'ready' || running || busy} checked={selected.has(item.id)}
        onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })}/>
        <span><strong>{item.application.job.title}</strong><br/>{item.application.job.company} · {item.application.job.location}</span>
      </label>
      <p className="job-meta">{item.status === 'ready' ? 'Ready for your confirmation' : item.status === 'approved' ? 'Confirmed · submission in progress' : item.status === 'applied' ? 'Applied' : item.status === 'dismissed' ? 'Skipped by you' : 'Could not submit'}{item.detail ? ` · ${item.detail}` : ''}</p>
      <p className="job-meta">Resume: {item.application.resume || 'No resume recorded'}</p>
      <details><summary>Review application</summary>
        {/^https?:\/\//i.test(item.application.job.url) && <p><a href={item.application.job.url} target="_blank" rel="noreferrer">View job listing ↗</a></p>}
        {item.application.coverLetter && <><h3>Cover letter</h3><p style={{ whiteSpace: 'pre-wrap' }}>{item.application.coverLetter}</p></>}
        {answers.length > 0 && <><h3>Answers</h3>
        <dl>{answers.map((answer, index) => <div key={index}><dt>{answer.question}</dt><dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{answer.answer}</dd></div>)}</dl></>}
      </details>
    </article>;
    })}
    {reviews.some(item => item.status === 'ready') && <div className="confirm-actions">
      <button type="button" className="btn" disabled={busy || running || !chosen.length} onClick={() => void decide('dismiss')}>Skip selected</button>
      <button type="button" className="btn primary" disabled={busy || running || !chosen.length} onClick={() => void decide('submit')}>{busy ? 'Saving…' : !chosen.length ? 'Confirm selected jobs' : `Confirm and apply to ${chosen.length} job${chosen.length === 1 ? '' : 's'}`}</button>
    </div>}
    {reviews.length > 0 && <p className="job-meta">Owtomate rechecks each confirmed job. Changed forms return for review; closed jobs and other issues are reported here. Each prepared application uses one application credit. Confirming it uses no additional credit.</p>}
  </section>;
}
