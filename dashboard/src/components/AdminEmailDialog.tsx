import { useEffect, useState } from 'react';
import { api } from '../adminApi';

/**
 * A personal email to one account, drafted by the server from the setup steps
 * that account still has open. The operator reads it, edits it, and sends it
 * from here — or opens it in their own mail app instead.
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

  useEffect(() => {
    api<Draft>(`/users/${userId}/email`)
      .then((next) => { setDraft(next); setSubject(next.subject); setBody(next.body); })
      .catch((reason) => setError((reason as Error).message));
  }, [userId]);

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
            <label className="field">
              <span className="field-label">Subject</span>
              <input className="input" value={subject} maxLength={200} onChange={(event) => setSubject(event.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Message</span>
              <textarea className="input admin-email-body" value={body} maxLength={10_000} onChange={(event) => setBody(event.target.value)} />
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
