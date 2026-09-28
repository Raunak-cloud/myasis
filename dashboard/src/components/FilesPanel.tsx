import { useEffect, useRef, useState } from 'react';
import { FilePreview } from './FilePreview';

interface ResumeRecord {
  id: string;
  label: string;
  fileName: string;
  seekName?: string;
  uploadedAt: string;
  size: number;
  notes?: string;
  isDefault?: boolean;
}

interface KnowledgeItem {
  id: string;
  label: string;
  kind: 'file' | 'note';
  fileName?: string;
  text?: string;
  addedAt: string;
  size?: number;
  enabled: boolean;
}

/** Mirrors the server's MAX_RESUMES (server/files.ts), which is the actual limit. */
const MAX_RESUMES = 4;

const kb = (n = 0) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KB`);

function toBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}


export function FilesPanel({ onChanged }: { onChanged?: () => void }) {
  const [resumes, setResumes] = useState<ResumeRecord[]>([]);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ kind: 'resume' | 'knowledge'; id: string; label: string; fileName?: string } | null>(null);
  const [noteText, setNoteText] = useState('');
  const resumeInput = useRef<HTMLInputElement>(null);
  const knowledgeInput = useRef<HTMLInputElement>(null);
  /**
   * What reading the résumé put into the details form. Worth saying out loud:
   * a form that fills itself silently looks broken, and the candidate needs
   * to know which fields to check.
   */
  const [autofilled, setAutofilled] = useState<string[] | null>(null);
  /** What the upload set up besides the details, for the one summary line. */
  const [setUp, setSetUp] = useState<{ terms: number; city: string | null } | null>(null);
  const [reading, setReading] = useState(false);
  const [autofillError, setAutofillError] = useState<string | null>(null);

  async function refresh(notify = false) {
    const [r, k] = await Promise.all([
      fetch('/api/resumes').then((x) => x.json()),
      fetch('/api/knowledge').then((x) => x.json()),
    ]);
    setResumes(Array.isArray(r) ? r : []);
    setItems(k.items ?? []);
    if (notify) onChanged?.();
  }

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  async function upload(kind: 'resume' | 'knowledge', file: File) {
    setBusy(true);
    setReading(kind === 'resume');
    setError(null);
    try {
      const base64 = await toBase64(file);
      const res = await fetch(kind === 'resume' ? '/api/resumes' : '/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, base64 }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? 'Upload failed.');
      else {
        setAutofilled(Array.isArray(json.autofilled) && json.autofilled.length ? json.autofilled : null);
        setAutofillError(kind === 'resume' && typeof json.autofillError === 'string' ? json.autofillError : null);
        if (kind === 'resume') setSetUp({ terms: Array.isArray(json.terms) ? json.terms.length : 0, city: typeof json.city === 'string' ? json.city : null });
        await refresh(kind === 'resume');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setReading(false);
    }
  }

  const patchResume = async (id: string, patch: Partial<ResumeRecord>) => {
    await fetch('/api/resumes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, patch }),
    });
    refresh();
  };

  const removeResume = async (id: string, label: string) => {
    if (!confirm(`Delete "${label}"? Your SEEK profile is not changed.`)) return;
    await fetch('/api/resumes', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh(true);
  };

  const patchItem = async (id: string, patch: Partial<KnowledgeItem>) => {
    await fetch('/api/knowledge', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, patch }),
    });
    refresh();
  };

  const removeItem = async (id: string, label: string) => {
    if (!confirm(`Delete "${label}"?`)) return;
    await fetch('/api/knowledge', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
  };

  async function addNote() {
    const text = noteText.trim();
    if (!text) return;
    setBusy(true);
    // The note names itself: its opening words are all a list needs to tell notes apart.
    const label = text.split(/\s+/).slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '') || 'Note';
    await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'note', label, text }),
    });
    setNoteText('');
    setBusy(false);
    refresh();
  }

  const atLimit = resumes.length >= MAX_RESUMES;

  return (
    <div className="files-grid">
      {error && <div className="banner banner-bad" style={{ gridColumn: '1/-1' }}>{error}</div>}

      {reading && (
        <div className="banner" style={{ gridColumn: '1/-1' }}>
          Reading your résumé and setting things up… this takes a few seconds.
        </div>
      )}

      {!reading && (autofilled || (setUp && (setUp.terms || setUp.city))) && (
        <div className="banner banner-ok" style={{ gridColumn: '1/-1' }}>
          Set up from your résumé:{' '}
          {[
            autofilled?.length ? 'your details' : '',
            setUp?.terms ? `${setUp.terms} job titles` : '',
            setUp?.city ? `city ${setUp.city}` : '',
          ].filter(Boolean).join(', ')}. Give them a quick check below.
        </div>
      )}

      {autofillError && (
        <div className="banner" style={{ gridColumn: '1/-1' }}>
          Saved, but we couldn't read it to fill step 2 ({autofillError}). Please fill step 2 in yourself.
        </div>
      )}

      {/* ---------------- résumés ---------------- */}
      <div className="card files-card">
        <div className="files-card-head">
          <h3>Résumés <span className="files-count">{resumes.length} of {MAX_RESUMES}</span></h3>
          <button
            className="btn"
            disabled={busy || atLimit}
            title={atLimit ? `Up to ${MAX_RESUMES} résumés. Delete one to add another.` : undefined}
            onClick={() => resumeInput.current?.click()}
          >
            + Upload
          </button>
          <input
            ref={resumeInput}
            type="file"
            hidden
            accept=".pdf,.doc,.docx,.rtf,.txt"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload('resume', f);
              e.target.value = '';
            }}
          />
        </div>
        <p className="files-card-hint">We pick the best one for each job.</p>

        {resumes.length === 0 ? (
          <button className="files-empty" disabled={busy} onClick={() => resumeInput.current?.click()}>
            <strong>Upload your résumé</strong>
            <span>PDF or Word</span>
          </button>
        ) : (
          <div className="files-list">
            {resumes.map((r) => (
              <div key={r.id} className="qa files-row">
                <div className="file-item-head">
                  <div className="file-item-main">
                    <input
                      className="input file-item-title"
                      aria-label="Résumé name"
                      value={r.label}
                      onChange={(e) => setResumes(resumes.map((x) => (x.id === r.id ? { ...x, label: e.target.value } : x)))}
                      onBlur={(e) => patchResume(r.id, { label: e.target.value })}
                    />
                    <div className="job-meta files-row-meta">{r.fileName} · {kb(r.size)}</div>
                    {resumes.length > 1 && (
                      <input
                        className="input file-item-notes"
                        aria-label="Which roles this résumé is for"
                        placeholder="Which roles is it for?"
                        value={r.notes ?? ''}
                        onChange={(e) => setResumes(resumes.map((x) => (x.id === r.id ? { ...x, notes: e.target.value } : x)))}
                        onBlur={(e) => patchResume(r.id, { notes: e.target.value })}
                      />
                    )}
                  </div>
                  <div className="file-item-actions">
                    <button className="btn" onClick={() => setPreview({ kind: 'resume', id: r.id, label: r.label, fileName: r.fileName })}>
                      View
                    </button>
                    {resumes.length > 1 && (r.isDefault
                      ? <span className="badge ok">default</span>
                      : <button className="btn" onClick={() => patchResume(r.id, { isDefault: true })}>Make default</button>)}
                    <button className="btn" aria-label={`Delete ${r.label}`} style={{ color: 'var(--bad)' }} onClick={() => removeResume(r.id, r.label)}>
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------------- extra details ---------------- */}
      <div className="card files-card">
        <div className="files-card-head">
          <h3>Extra details <span className="files-count">optional</span></h3>
          <button className="btn" disabled={busy} onClick={() => knowledgeInput.current?.click()}>
            + Upload file
          </button>
          <input
            ref={knowledgeInput}
            type="file"
            hidden
            accept=".pdf,.doc,.docx,.txt,.md,.json,.csv,.rtf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload('knowledge', f);
              e.target.value = '';
            }}
          />
        </div>
        <p className="files-card-hint">Anything your résumé doesn't say. We use it to answer application questions.</p>

        <div className="files-note">
          <textarea
            className="input"
            rows={2}
            aria-label="Add a detail"
            placeholder="e.g. Full driver licence. Can start next week."
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void addNote(); }}
          />
          <button className="btn primary" disabled={busy || !noteText.trim()} onClick={addNote}>Save</button>
        </div>

        {items.length > 0 && (
          <ul className="files-details">
            {items.map((i) => (
              <li key={i.id} className={i.enabled ? '' : 'off'}>
                <span className="files-detail-text">
                  {i.kind === 'file' ? <><span className="badge muted">file</span> {i.fileName ?? i.label}</> : i.text ?? i.label}
                </span>
                <span className="file-item-actions">
                  {i.kind === 'file' && (
                    <button className="btn" onClick={() => setPreview({ kind: 'knowledge', id: i.id, label: i.label, fileName: i.fileName })}>View</button>
                  )}
                  {!i.enabled && <button className="btn" onClick={() => patchItem(i.id, { enabled: true })}>Turn on</button>}
                  <button className="btn" aria-label={`Delete ${i.label}`} style={{ color: 'var(--bad)' }} onClick={() => removeItem(i.id, i.label)}>✕</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {preview && (
        <FilePreview
          kind={preview.kind}
          id={preview.id}
          label={preview.label}
          fileName={preview.fileName}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
