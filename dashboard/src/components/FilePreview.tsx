import { useEffect, useState } from 'react';

interface Props {
  kind: 'resume' | 'knowledge';
  id: string;
  label: string;
  /** Present for uploaded files, absent for typed notes. */
  fileName?: string;
  onClose: () => void;
}

/**
 * Shows the *extracted text* rather than the raw document.
 *
 * That is deliberately the default view: what matters is what the model
 * actually receives. A DOCX that renders fine but extracts to nothing would
 * look healthy in a normal file viewer and be invisible to the bot.
 */
export function FilePreview({ kind, id, label, fileName, onClose }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setText(null);
    setError(null);
    fetch(`/api/preview?kind=${kind}&id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((r) => (r.ok ? setText(r.text ?? '') : setError(r.error ?? 'Could not load.')))
      .catch((e) => setError(e.message));
  }, [kind, id]);

  const chars = text?.length ?? 0;
  const words = text ? text.trim().split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2>{label}</h2>
            <div className="job-meta">
              {fileName ? `${fileName} · ` : 'typed note · '}
              {text === null ? 'reading…' : `${chars.toLocaleString()} chars · ${words.toLocaleString()} words extracted`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {fileName && (
              <>
                <a
                  className="btn"
                  href={`/api/file?kind=${kind}&id=${encodeURIComponent(id)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: 'none' }}
                >
                  Open ↗
                </a>
                <a
                  className="btn"
                  href={`/api/file?kind=${kind}&id=${encodeURIComponent(id)}&download=1`}
                  style={{ textDecoration: 'none' }}
                >
                  Download
                </a>
              </>
            )}
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="drawer-body">
          {error && (
            <div className="banner" style={{ borderColor: 'var(--bad)', background: 'var(--bad-soft)' }}>
              {error}
            </div>
          )}

          <div className="section">
            <h3>Text available to the application assistant</h3>
            {text === null && !error ? (
              <div className="job-meta">Extracting…</div>
            ) : (
              <div className="letter" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                {text}
              </div>
            )}
          </div>

          {fileName && (
            <div className="section">
              <h3>Original file</h3>
              <p className="job-meta" style={{ marginTop: 0 }}>
                "Open" renders the file in a new tab where the browser can display it (PDF, TXT).
                DOCX will download instead — browsers cannot render it inline.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
