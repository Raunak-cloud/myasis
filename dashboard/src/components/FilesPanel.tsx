import { useCallback, useEffect, useRef, useState } from 'react';
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

async function writeFileChange(endpoint: string, method: string, body: unknown): Promise<void> {
  const response = await fetch(endpoint, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error || 'Could not save this change. Please retry.');
  }
}

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
  const [resumeDrafts, setResumeDrafts] = useState<Record<string, Partial<ResumeRecord>>>({});
  const resumeDraftVersions = useRef<Record<string, Partial<Record<keyof ResumeRecord, number>>>>({});
  const [resumeErrors, setResumeErrors] = useState<Record<string, { generation: number; message: string }>>({});
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [preview, setPreview] = useState<{ kind: 'resume' | 'knowledge'; id: string; label: string; fileName?: string } | null>(null);
  const [noteText, setNoteText] = useState('');
  const resumeInput = useRef<HTMLInputElement>(null);
  const knowledgeInput = useRef<HTMLInputElement>(null);
  /**
   * What reading the resume put into the details form. Worth saying out loud:
   * a form that fills itself silently looks broken, and the candidate needs
   * to know which fields to check.
   */
  const [autofilled, setAutofilled] = useState<string[] | null>(null);
  /** What the upload set up besides the details, for the one summary line. */
  const [setUp, setSetUp] = useState<{ terms: number; city: string | null } | null>(null);
  const [reading, setReading] = useState(false);
  const [autofillError, setAutofillError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [r, k] = await Promise.all([
      fetch('/api/resumes', { signal }).then(async response => {
        if (!response.ok) throw new Error('Could not load resumes.');
        return response.json();
      }),
      fetch('/api/knowledge', { signal }).then(async response => {
        if (!response.ok) throw new Error('Could not load extra details.');
        return response.json();
      }),
    ]);
    if (signal?.aborted) return;
    setResumes(Array.isArray(r) ? r : []);
    setItems(k.items ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try { await refresh(controller.signal); }
      catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    })();
    return () => controller.abort();
  }, [refresh]);

  async function queueChange(work: () => Promise<void>, onError?: (message: string) => void): Promise<boolean> {
    setBusy(true);
    const pending = changeQueue.current.then(async () => {
      setError(null);
      try { await work(); return true; }
      catch (reason) {
        const message = reason instanceof Error ? reason.message : 'Could not save this change. Please retry.';
        if (onError) onError(message); else setError(message);
        return false;
      }
    });
    changeQueue.current = pending;
    const saved = await pending;
    if (changeQueue.current === pending) setBusy(false);
    return saved;
  }

  async function upload(kind: 'resume' | 'knowledge', file: File) {
    setReading(kind === 'resume');
    await queueChange(async () => {
      const base64 = await toBase64(file);
      const res = await fetch(kind === 'resume' ? '/api/resumes' : '/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, base64 }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) throw new Error(json?.error ?? 'Upload failed.');
      setAutofilled(Array.isArray(json.autofilled) && json.autofilled.length ? json.autofilled : null);
      setAutofillError(kind === 'resume' && typeof json.autofillError === 'string' ? json.autofillError : null);
      if (kind === 'resume') setSetUp({ terms: Array.isArray(json.terms) ? json.terms.length : 0, city: typeof json.city === 'string' ? json.city : null });
      await refresh();
      if (kind === 'resume') onChanged?.();
    });
    setReading(false);
  }

  async function changeFile(endpoint: string, method: string, body: unknown, notify = false, onError?: (message: string) => void) {
    return queueChange(async () => {
      await writeFileChange(endpoint, method, body);
      await refresh();
      if (notify) onChanged?.();
    }, onError);
  }
  const patchResume = async (id: string, patch: Partial<ResumeRecord>) => {
    const submittedVersions = { ...resumeDraftVersions.current[id] };
    const keys = Object.keys(patch) as Array<keyof ResumeRecord>;
    if (await changeFile('/api/resumes', 'PATCH', { id, patch }, false, message => {
      setResumeErrors(current => {
        const next = { ...current };
        for (const key of keys) {
          const errorKey = `${id}:${key}`, generation = submittedVersions[key] ?? 0;
          if (!next[errorKey] || next[errorKey].generation <= generation) next[errorKey] = { generation, message };
        }
        return next;
      });
    })) {
      setResumeDrafts(current => {
        const next = { ...current[id] };
        for (const key of keys) {
          if (resumeDraftVersions.current[id]?.[key] === submittedVersions[key]) delete next[key];
        }
        return { ...current, [id]: next };
      });
      setResumeErrors(current => {
        const next = { ...current };
        for (const key of keys) {
          const errorKey = `${id}:${key}`;
          if (next[errorKey] && next[errorKey].generation <= (submittedVersions[key] ?? 0)) delete next[errorKey];
        }
        return next;
      });
    }
  };
  const editResume = (id: string, key: 'label' | 'notes', value: string) => {
    const versions = resumeDraftVersions.current[id] ?? {};
    resumeDraftVersions.current[id] = { ...versions, [key]: (versions[key] ?? 0) + 1 };
    setResumeDrafts(current => ({ ...current, [id]: { ...current[id], [key]: value } }));
  };

  const removeResume = async (id: string, label: string) => {
    if (!confirm(`Delete "${label}"? Your SEEK profile is not changed.`)) return;
    if (await changeFile('/api/resumes', 'DELETE', { id }, true)) {
      setResumeErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${id}:`))));
      setResumeDrafts(current => { const next = { ...current }; delete next[id]; return next; });
      delete resumeDraftVersions.current[id];
    }
  };

  const patchItem = (id: string, patch: Partial<KnowledgeItem>) => {
    return changeFile('/api/knowledge', 'PATCH', { id, patch });
  };

  const removeItem = async (id: string, label: string) => {
    if (!confirm(`Delete "${label}"?`)) return;
    await changeFile('/api/knowledge', 'DELETE', { id });
  };

  async function addNote() {
    const text = noteText.trim();
    if (!text || busy) return;
    // The note names itself: its opening words are all a list needs to tell notes apart.
    const label = text.split(/\s+/).slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '') || 'Note';
    await queueChange(async () => {
      await writeFileChange('/api/knowledge', 'POST', { kind: 'note', label, text });
      setNoteText(current => current.trim() === text ? '' : current);
      await refresh();
    });
  }

  const atLimit = resumes.length >= MAX_RESUMES;
  const visibleError = error || Object.values(resumeErrors)[0]?.message;

  return (
    <div className="files-grid">
      {visibleError && <div role="alert" className="banner banner-bad" style={{ gridColumn: '1/-1' }}>{visibleError}</div>}

      {reading && (
        <div className="banner" style={{ gridColumn: '1/-1' }}>
          Reading your resume and setting things up… this takes a few seconds.
        </div>
      )}

      {!reading && (autofilled || (setUp && (setUp.terms || setUp.city))) && (
        <div className="banner banner-ok" style={{ gridColumn: '1/-1' }}>
          Set up from your resume:{' '}
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

      {/* ---------------- resumes ---------------- */}
      <div className="card files-card">
        <div className="files-card-head">
          <h3>Resumes <span className="files-count">{resumes.length} of {MAX_RESUMES}</span></h3>
          <button
            className="btn"
            disabled={busy || atLimit}
            title={atLimit ? `Up to ${MAX_RESUMES} resumes. Delete one to add another.` : undefined}
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
            <strong>Upload your resume</strong>
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
                      aria-label="Resume name"
                      value={resumeDrafts[r.id]?.label ?? r.label}
                      onChange={(e) => editResume(r.id, 'label', e.target.value)}
                      onBlur={(e) => patchResume(r.id, { label: e.target.value })}
                    />
                    <div className="job-meta files-row-meta">{r.fileName} · {kb(r.size)}</div>
                    {resumes.length > 1 && (
                      <input
                        className="input file-item-notes"
                        aria-label="Which roles this resume is for"
                        placeholder="Which roles is it for?"
                        value={resumeDrafts[r.id]?.notes ?? r.notes ?? ''}
                        onChange={(e) => editResume(r.id, 'notes', e.target.value)}
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
        <p className="files-card-hint">Anything your resume doesn't say. We use it to answer application questions.</p>

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
