import { useEffect, useState } from 'react';
import { COVER_LETTER_INSTRUCTION_WORD_LIMIT, instructionWordCount } from '../../../seek-bot/src/cover-letter-policy.js';
interface Review {
  id: string; status: string; detail: string | null;
  application: {
    revision: string; job: { title: string; company: string; location: string; url: string };
    resume?: string; coverLetter?: string; answers: Array<{ question: string; answer: string }>;
    email?: { to: string; subject: string; attachCoverLetter?: boolean };
  };
}

export function PreparedApplications({ running, onStarted, onCountChange }: { running: boolean; onStarted: () => void; onCountChange: (count: number) => void }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string; revision: string; text: string } | null>(null);
  const [instructions, setInstructions] = useState('');
  const [savedInstructions, setSavedInstructions] = useState('');
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [notice, setNotice] = useState('');
  const words = instructionWordCount(instructions);
  useEffect(() => {
    let alive = true;
    void fetch('/api/settings').then(async response => {
      if (!response.ok) throw new Error('Could not load cover letter instructions.');
      const data = await response.json();
      if (alive) { setInstructions(data.COVER_LETTER_INSTRUCTIONS ?? ''); setSavedInstructions(data.COVER_LETTER_INSTRUCTIONS ?? ''); setPreferencesLoaded(true); }
    }).catch(reason => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, []);
  const load = async (signal?: AbortSignal) => {
    const response = await fetch('/api/application-reviews', { signal });
    if (!response.ok) throw new Error('Could not load prepared applications.');
    const data = await response.json();
    const applications: Review[] = Array.isArray(data.applications) ? data.applications : [];
    if (signal?.aborted) return;
    setReviews(applications);
    onCountChange(applications.filter(item => item.status === 'ready').length);
  };
  useEffect(() => {
    if (editing || busy) return;
    const controller = new AbortController();
    const refresh = () => { void load(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }); };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [running, onCountChange, Boolean(editing), busy]);
  const chosen = reviews.filter(item => item.status === 'ready' && selected.has(item.id));
  async function saveInstructions() {
    if (savingInstructions || !preferencesLoaded || words > COVER_LETTER_INSTRUCTION_WORD_LIMIT) return;
    setSavingInstructions(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { COVER_LETTER_INSTRUCTIONS: instructions } }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save cover letter instructions.');
      const saved = data.settings?.COVER_LETTER_INSTRUCTIONS ?? instructions.trim();
      setInstructions(saved); setSavedInstructions(saved); setNotice('Instructions saved for future cover letters.');
    } catch (reason) { setError((reason as Error).message); }
    finally { setSavingInstructions(false); }
  }
  async function saveLetter() {
    if (!editing || busy || running || !editing.text.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/application-reviews/cover-letter', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editing.id, revision: editing.revision, coverLetter: editing.text }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save the cover letter.');
      setReviews(previous => previous.map(item => item.id === editing.id ? { ...item, application: data.application } : item));
      setSelected(previous => { const next = new Set(previous); next.delete(editing.id); return next; });
      const ready = reviews.find(item => item.id === editing.id)?.status === 'ready';
      setEditing(null); setNotice(ready ? 'Cover letter saved. Select the application when you are ready to apply.' : 'Cover letter saved. The submission status is unchanged.');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function decide(action: 'submit' | 'dismiss', retry?: Review) {
    const applications = retry ? [{ id: retry.id, revision: retry.application.revision, retry: true }]
      : chosen.map(item => ({ id: item.id, revision: item.application.revision }));
    if (busy || running || editing || !applications.length || retry && (action !== 'submit' || retry.status !== 'failed')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/application-reviews/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: action === 'submit', applications }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save your choice.');
      setSelected(new Set());
      await load();
      if (action === 'submit') onStarted();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="card prepared-applications" aria-label="Prepared applications">
    <details className="prepared-letter-preferences"><summary>Cover letter instructions</summary>
      <form onSubmit={event => { event.preventDefault(); void saveInstructions(); }}>
        <label htmlFor="cover-letter-instructions">Instructions for all future cover letters</label>
        <textarea id="cover-letter-instructions" rows={3} maxLength={2000} value={instructions} disabled={!preferencesLoaded || savingInstructions}
          aria-describedby="cover-letter-instructions-count" aria-invalid={words > COVER_LETTER_INSTRUCTION_WORD_LIMIT}
          onChange={event => { setInstructions(event.target.value); setNotice(''); }}/>
        <div className="prepared-editor-actions"><span className="job-meta" id="cover-letter-instructions-count">{words} / {COVER_LETTER_INSTRUCTION_WORD_LIMIT} words</span>
          <button className="btn" type="submit" disabled={!preferencesLoaded || savingInstructions || instructions === savedInstructions || words > COVER_LETTER_INSTRUCTION_WORD_LIMIT}>{savingInstructions ? 'Saving…' : 'Save instructions'}</button></div>
      </form>
    </details>
    {reviews.length > 0 && <p className="job-meta prepared-intro">Review and select the jobs you want to apply to.</p>}
    {error && <div className="banner banner-bad" role="alert">{error}</div>}
    {notice && <p className="job-meta prepared-notice" role="status">{notice}</p>}
    {!reviews.length && <div className="prepared-empty"><p>No prepared applications yet.</p><a className="btn" href="/?tab=run">Apply page</a></div>}
    {reviews.map(item => {
      const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim();
      const coverLetter = normalizeText(item.application.coverLetter || '');
      const answers = item.application.answers.filter(answer => !coverLetter || normalizeText(answer.answer) !== coverLetter);
      return <article className={`prepared-application${item.status === 'ready' && selected.has(item.id) ? ' selected' : ''}`} key={item.id}>
      <label className="prepared-choice"><input type="checkbox" aria-label={`Select ${item.application.job.title} at ${item.application.job.company}`}
        disabled={item.status !== 'ready' || running || busy} checked={selected.has(item.id)}
        onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })}/>
        <span className="prepared-job"><strong>{item.application.job.title}</strong><span className="job-meta">{item.application.job.company} · {item.application.job.location}</span></span>
      </label>
      <span className={`prepared-status ${item.status}`}>{item.status === 'ready' ? 'Ready' : item.status === 'approved' ? 'Submitting' : item.status === 'applied' ? 'Submitted' : item.status === 'dismissed' ? 'Skipped' : 'Could not submit'}</span>
      {item.detail && <p className="job-meta prepared-detail">{item.detail}</p>}
      {item.status === 'failed' && <button type="button" className="btn prepared-retry" disabled={running || busy || Boolean(editing)}
        onClick={() => void decide('submit', item)}>Retry application</button>}
      <details><summary>Review application</summary>
        <div className="prepared-content">
        {item.application.email && <p className="job-meta">Email application<br/>To: {item.application.email.to}<br/>Subject: {item.application.email.subject}<br/>Attachments: resume{item.application.email.attachCoverLetter ? ' and cover letter' : ''}</p>}
        <p className="job-meta">Resume: {item.application.resume || 'No resume recorded'}</p>
        {/^https?:\/\//i.test(item.application.job.url) && <p><a href={item.application.job.url} target="_blank" rel="noreferrer">View job listing ↗</a></p>}
        <div className="prepared-letter-heading"><h3>Cover letter</h3>{['ready', 'failed'].includes(item.status) && editing?.id !== item.id && <button type="button" className="btn" disabled={running || busy || Boolean(editing)}
          onClick={() => { setEditing({ id: item.id, revision: item.application.revision, text: item.application.coverLetter ?? '' }); setNotice(''); }}>Edit cover letter</button>}</div>
        {editing?.id === item.id ? <div className="prepared-letter-editor">
          <textarea aria-label={`Cover letter for ${item.application.job.title} at ${item.application.job.company}`} rows={18} maxLength={20_000} value={editing.text}
            disabled={busy || running} onChange={event => setEditing({ ...editing, text: event.target.value })}/>
          <div className="prepared-editor-actions"><button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy || running || !editing.text.trim()} onClick={() => void saveLetter()}>{busy ? 'Saving…' : 'Save cover letter'}</button></div>
        </div> : item.application.coverLetter ? <p style={{ whiteSpace: 'pre-wrap' }}>{item.application.coverLetter}</p> : <p className="job-meta">No cover letter recorded.</p>}
        {answers.length > 0 && <><h3>Answers</h3>
        <dl>{answers.map((answer, index) => <div key={index}><dt>{answer.question}</dt><dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{answer.answer}</dd></div>)}</dl></>}
        </div>
      </details>
    </article>;
    })}
    {chosen.length > 0 && !editing && <div className="prepared-actions">
      <button type="button" className="btn" disabled={busy || running || Boolean(editing) || !chosen.length} onClick={() => void decide('dismiss')}>Skip selected</button>
      <button type="button" className="btn primary" disabled={busy || running || Boolean(editing) || !chosen.length} onClick={() => void decide('submit')}>{busy ? 'Saving…' : `Apply to ${chosen.length} job${chosen.length === 1 ? '' : 's'}`}</button>
    </div>}
  </section>;
}
