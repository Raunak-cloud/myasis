import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../adminApi';

/**
 * A personal email to one account. The standard draft (built from the setup
 * steps still open) shows at once; Celeris Magnus then rewrites it around
 * this person's situation. The operator can steer a rewrite, edit freely,
 * and send from here or from their own mail app. Magnus never overwrites
 * text the operator has started editing: its version waits to be taken.
 */

interface Draft {
  to: string;
  replyTo: string;
  subject: string;
  body: string;
  missing: string[];
  optedOut: boolean;
  canSend: boolean;
  lastSent: { at: string; subject: string } | null;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function AdminEmailDialog({ userId, onClose, onSent }: { userId: string; onClose: () => void; onSent: (to: string) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [tailoring, setTailoring] = useState(false);
  const [tailorError, setTailorError] = useState<string | null>(null);
  /** Magnus's version, held back because the operator had already started editing. */
  const [waiting, setWaiting] = useState<{ subject: string; body: string } | null>(null);
  const edited = useRef(false);
  const request = useRef(0);

  const tailor = useCallback((focus: string) => {
    const id = ++request.current;
    setTailoring(true);
    setTailorError(null);
    setWaiting(null);
    edited.current = false;
    api<{ subject: string; body: string }>(`/users/${userId}/email-draft`, { method: 'POST', json: { instruction: focus } })
      .then((next) => {
        if (id !== request.current) return;
        if (edited.current) setWaiting(next);
        else { setSubject(next.subject); setBody(next.body); }
      })
      .catch((reason) => { if (id === request.current) setTailorError((reason as Error).message); })
      .finally(() => { if (id === request.current) setTailoring(false); });
  }, [userId]);

  useEffect(() => {
    let closed = false;
    api<Draft>(`/users/${userId}/email`)
      .then((next) => {
        if (closed) return;
        setDraft(next); setSubject(next.subject); setBody(next.body);
        tailor('');
      })
      .catch((reason) => { if (!closed) setError((reason as Error).message); });
    return () => { closed = true; request.current++; };
  }, [userId, tailor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, sending]);

  const send = async () => {
    if (!draft) return;
    setSending(true);
    setError(null);
    try {
      await api(`/users/${userId}/email`, { method: 'POST', json: { subject, body } });
      onSent(draft.to);
    } catch (reason) {
      setError((reason as Error).message);
      setSending(false);
    }
  };

  const mailto = draft ? `mailto:${draft.to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : '';

  return (
    <div className="overlay center" onClick={() => !sending && onClose()}>
      <div className="card confirm admin-email" role="dialog" aria-modal="true" aria-labelledby="admin-email-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="admin-email-title">Email {draft?.to ?? '…'}</h2>
        {error && <div className="banner banner-bad" role="alert">{error}</div>}
        {!draft ? (
          !error && <p className="job-meta">Drafting…</p>
        ) : (
          <>
            {draft.missing.length > 0 && <p className="job-meta">Still to do: {draft.missing.join(', ')}.</p>}
            {draft.lastSent && <div className="banner" role="status">Already emailed {ago(draft.lastSent.at)}: “{draft.lastSent.subject}”.</div>}
            {draft.optedOut && <div className="banner" role="status">They switched off automatic emails. Only send this if it will help them.</div>}
            <form className="admin-email-tailor" onSubmit={(event) => { event.preventDefault(); tailor(instruction); }}>
              <input
                className="input"
                value={instruction}
                maxLength={500}
                placeholder="Tell Magnus what to focus on (optional), e.g. they are a nurse, keep it very short"
                onChange={(event) => setInstruction(event.target.value)}
              />
              <button type="submit" className="btn" disabled={tailoring}>{tailoring ? 'Writing…' : 'Rewrite with Magnus'}</button>
            </form>
            {tailoring && <p className="job-meta" role="status">Magnus is tailoring this to them. You can edit meanwhile; it will not overwrite your changes.</p>}
            {tailorError && <div className="banner banner-bad" role="alert">{tailorError} The standard draft is below.</div>}
            {waiting && (
              <div className="banner" role="status">
                Magnus's version is ready.{' '}
                <button type="button" className="btn btn-small" onClick={() => { setSubject(waiting.subject); setBody(waiting.body); setWaiting(null); edited.current = false; }}>Use it</button>{' '}
                <button type="button" className="btn btn-small" onClick={() => setWaiting(null)}>Keep mine</button>
              </div>
            )}
            <label className="field">
              <span className="field-label">Subject</span>
              <input className="input" value={subject} maxLength={200} onChange={(event) => { edited.current = true; setSubject(event.target.value); }} />
            </label>
            <label className="field">
              <span className="field-label">Message</span>
              <textarea className="input admin-email-body" value={body} maxLength={10_000} onChange={(event) => { edited.current = true; setBody(event.target.value); }} />
            </label>
            <p className="job-meta">Replies go to {draft.replyTo}.</p>
          </>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onClose} disabled={sending}>Cancel</button>
          {draft && <a className="btn" href={mailto}>Open in mail app</a>}
          {draft && (
            <button type="button" className="btn primary" onClick={send} disabled={sending || !draft.canSend || !subject.trim() || !body.trim()} title={draft.canSend ? undefined : 'Email sending is not configured on this server.'}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
