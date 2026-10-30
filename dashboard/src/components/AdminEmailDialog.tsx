import { useEffect, useRef, useState } from 'react';
import { api } from '../adminApi';
import { AdminEmailHistory } from './AdminEmailHistory';

/**
 * A personal email to one account. The standard draft (built from the setup
 * steps still open) loads without a model request. Only the explicit rewrite
 * button asks Celeris Magnus for another version. The operator can edit freely,
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

export function AdminEmailDialog({ userId, onClose, onSent }: { userId: string; onClose: () => void; onSent: (to: string) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [tailoring, setTailoring] = useState(false);
  const [tailorError, setTailorError] = useState<string | null>(null);
  /** Magnus's version, held back because the operator had already started editing. */
  const [waiting, setWaiting] = useState<{ subject: string; body: string } | null>(null);
  const edited = useRef(false);
  const request = useRef(0);

  const tailor = (focus: string) => {
    if (tailoring || sending || sent) return;
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
  };

  useEffect(() => {
    let closed = false;
    // This counter belongs to the request lifecycle, rather than a DOM node.
    const pendingRequest = request;
    api<Draft>(`/users/${userId}/email`)
      .then((next) => {
        if (closed) return;
        setDraft(next); setSubject(next.subject); setBody(next.body);
      })
      .catch((reason) => { if (!closed) setError((reason as Error).message); });
    return () => { closed = true; pendingRequest.current++; };
  }, [userId]);

  const send = async () => {
    if (!draft || sending || sent) return;
    setSending(true);
    setError(null);
    try {
      await api(`/users/${userId}/email`, { method: 'POST', json: { subject, body } });
      setSent(true);
      setSending(false);
      onSent(draft.to);
    } catch (reason) {
      setError((reason as Error).message);
      setSending(false);
    }
  };

  const mailto = draft ? `mailto:${draft.to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : '';

  return (
    <div className="overlay center">
      <div className="card confirm admin-email" role="dialog" aria-modal="true" aria-labelledby="admin-email-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="admin-email-title">Email {draft?.to ?? '…'}</h2>
        <AdminEmailHistory key={`${userId}:${sent}`} userId={userId} />
        {sent && <div className="banner" role="status">Email sent to {draft?.to}.</div>}
        {error && <div className="banner banner-bad" role="alert">{error}</div>}
        {!draft ? (
          !error && <p className="job-meta">Drafting…</p>
        ) : (
          <>
            {draft.missing.length > 0 && <p className="job-meta">Still to do: {draft.missing.join(', ')}.</p>}
            {draft.optedOut && <div className="banner" role="status">They switched off automatic emails. Only send this if it will help them.</div>}
            <div className="admin-email-tailor">
              <input
                className="input"
                value={instruction}
                maxLength={500}
                placeholder="Tell Magnus what to focus on (optional), e.g. they are a nurse, keep it very short"
                onChange={(event) => setInstruction(event.target.value)}
              />
              <button type="button" className="btn" onClick={() => tailor(instruction)} disabled={tailoring || sending || sent}>{tailoring ? 'Writing…' : 'Rewrite with Magnus'}</button>
            </div>
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
          <button type="button" className="btn" onClick={onClose} disabled={sending}>Close</button>
          {draft && <a className="btn" href={mailto}>Open in mail app</a>}
          {draft && (
            <button type="button" className="btn primary" onClick={send} disabled={sending || sent || !draft.canSend || !subject.trim() || !body.trim()} title={draft.canSend ? undefined : 'Email sending is not configured on this server.'}>
              {sent ? 'Sent' : sending ? 'Sending…' : 'Send'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
