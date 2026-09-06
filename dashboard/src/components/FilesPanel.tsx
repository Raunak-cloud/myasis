import { useEffect, useRef, useState } from 'react';
import { fmtDate } from '../format';
import { FilePreview } from './FilePreview';

export interface ResumeRecord {
  id: string;
  label: string;
  fileName: string;
  seekName?: string;
  uploadedAt: string;
  size: number;
  notes?: string;
  isDefault?: boolean;
}

export interface KnowledgeItem {
  id: string;
  label: string;
  kind: 'file' | 'note';
  fileName?: string;
  text?: string;
  addedAt: string;
  size?: number;
  enabled: boolean;
}

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
  const [stats, setStats] = useState<{ enabled: number; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ kind: 'resume' | 'knowledge'; id: string; label: string; fileName?: string } | null>(null);
  const [contextText, setContextText] = useState<string | null>(null);
  const [noteLabel, setNoteLabel] = useState('');
  const [noteText, setNoteText] = useState('');
  const resumeInput = useRef<HTMLInputElement>(null);
  const knowledgeInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    const [r, k] = await Promise.all([
      fetch('/api/resumes').then((x) => x.json()),
      fetch('/api/knowledge').then((x) => x.json()),
    ]);
    setResumes(Array.isArray(r) ? r : []);
    setItems(k.items ?? []);
    setStats(k.stats ?? null);
    onChanged?.();
  }

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  async function upload(kind: 'resume' | 'knowledge', file: File) {
    setBusy(true);
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
      else await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
    if (!confirm(`Delete résumé "${label}"? This removes the local copy only — it does not touch your SEEK profile.`)) return;
    await fetch('/api/resumes', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
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
    if (!confirm(`Delete "${label}" from the knowledge base?`)) return;
    await fetch('/api/knowledge', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    refresh();
  };

  async function addNote() {
    if (!noteText.trim()) return;
    setBusy(true);
    await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'note', label: noteLabel || 'Note', text: noteText }),
    });
    setNoteLabel('');
    setNoteText('');
    setBusy(false);
    refresh();
  }

  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(430px,1fr))' }}>
      {error && (
        <div className="banner" style={{ gridColumn: '1/-1', borderColor: 'var(--bad)', background: 'var(--bad-soft)' }}>
          {error}
        </div>
      )}

      {/* ---------------- résumés ---------------- */}
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-faint)' }}>
            Résumés
          </h3>
          <button className="btn" disabled={busy} onClick={() => resumeInput.current?.click()}>
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
        <p className="job-meta" style={{ marginTop: 0 }}>
          Pick which résumé a run should use. SEEK only offers documents already on your profile,
          so a résumé that isn't there yet needs <em>Allow upload</em> enabled on the run — which
          adds it to your SEEK account.
        </p>
        {resumes.length > 1 && (
          <p className="job-meta" style={{ marginTop: 0 }}>
            With more than one résumé on file, the AI picks the best match for each job from the
            notes below — describe what each one is for.
          </p>
        )}

        {resumes.length === 0 ? (
          <div className="empty" style={{ padding: '28px 10px' }}>
            <div className="big">No résumés yet</div>
            <div>Upload one to target different kinds of role.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {resumes.map((r) => (
              <div key={r.id} className="qa" style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <input
                      className="input"
                      style={{ minWidth: 0, width: '100%', padding: '3px 7px', fontWeight: 600 }}
                      value={r.label}
                      onChange={(e) => setResumes(resumes.map((x) => (x.id === r.id ? { ...x, label: e.target.value } : x)))}
                      onBlur={(e) => patchResume(r.id, { label: e.target.value })}
                    />
                    <div className="job-meta" style={{ marginTop: 4 }}>
                      {r.fileName} · {kb(r.size)} · {fmtDate(r.uploadedAt)}
                    </div>
                    <input
                      className="input"
                      style={{ minWidth: 0, width: '100%', padding: '3px 7px', marginTop: 6 }}
                      placeholder="What is this résumé for? e.g. React/frontend roles"
                      value={r.notes ?? ''}
                      onChange={(e) => setResumes(resumes.map((x) => (x.id === r.id ? { ...x, notes: e.target.value } : x)))}
                      onBlur={(e) => patchResume(r.id, { notes: e.target.value })}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      className="btn"
                      style={{ padding: '3px 8px', fontSize: 12 }}
                      onClick={() => { setContextText(null); setPreview({ kind: 'resume', id: r.id, label: r.label, fileName: r.fileName }); }}
                    >
                      View
                    </button>
                    {r.isDefault ? (
                      <span className="badge ok">default</span>
                    ) : (
                      <button className="btn" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => patchResume(r.id, { isDefault: true })}>
                        Make default
                      </button>
                    )}
                    <button
                      className="btn"
                      style={{ padding: '3px 8px', fontSize: 12, color: 'var(--bad)' }}
                      onClick={() => removeResume(r.id, r.label)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------------- knowledge base ---------------- */}
      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-faint)' }}>
            Personal details the application assistant can use
          </h3>
          <button className="btn" disabled={busy} onClick={() => knowledgeInput.current?.click()}>
            + Upload
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
        <p className="job-meta" style={{ marginTop: 0 }}>
          When a screening question cannot be answered from your details above, the run stops and asks you. Anything here gets consulted first — a full CV,
          certifications, visa paperwork, referee details. Text is extracted from PDF, DOCX, TXT and
          MD. These are treated as <strong>evidence, never instructions</strong>.
          {stats && (
            <>
              {' '}
              Currently <strong>{stats.enabled}</strong> enabled, ~{kb(stats.bytes)} of source
              material.
            </>
          )}
        </p>

        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
          {items.map((i) => (
            <div key={i.id} className="qa" style={{ marginBottom: 0, opacity: i.enabled ? 1 : 0.5 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {i.label} <span className="badge muted">{i.kind}</span>
                  </div>
                  <div className="job-meta" style={{ marginTop: 3 }}>
                    {i.kind === 'file' ? i.fileName : `${i.text?.slice(0, 90)}${(i.text?.length ?? 0) > 90 ? '…' : ''}`}
                    {' · '}
                    {kb(i.size)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn"
                    style={{ padding: '3px 8px', fontSize: 12 }}
                    onClick={() => { setContextText(null); setPreview({ kind: 'knowledge', id: i.id, label: i.label, fileName: i.fileName }); }}
                  >
                    View
                  </button>
                  <button
                    className="btn"
                    style={{ padding: '3px 8px', fontSize: 12 }}
                    onClick={() => patchItem(i.id, { enabled: !i.enabled })}
                  >
                    {i.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="btn"
                    style={{ padding: '3px 8px', fontSize: 12, color: 'var(--bad)' }}
                    onClick={() => removeItem(i.id, i.label)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
          {items.length === 0 && (
            <div className="job-meta">
              Nothing yet. Add a note below, or upload a document.
            </div>
          )}
        </div>

        <h3 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--text-faint)' }}>
          Add a note
        </h3>
        <div style={{ display: 'grid', gap: 8 }}>
          <input
            className="input"
            placeholder="Label — e.g. Visa & work rights"
            value={noteLabel}
            onChange={(e) => setNoteLabel(e.target.value)}
          />
          <textarea
            className="input"
            rows={4}
            placeholder={'Useful details for applications. e.g.\n"Full driver licence, own car. Available to start immediately. Happy with 3 days on-site."'}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            style={{ resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy || !noteText.trim()} onClick={addNote}>
              Add note
            </button>
            <button
              className="btn"
              onClick={async () => {
                setPreview(null);
                const r = await fetch('/api/knowledge/context').then((x) => x.json());
                setContextText(r.ok ? r.text || '(nothing enabled)' : `Error: ${r.error}`);
              }}
            >
              Preview application context
            </button>
          </div>
        </div>
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

      {contextText !== null && (
        <div className="overlay" onClick={() => setContextText(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <h2>Assembled context</h2>
                <div className="job-meta">
                  {contextText.length.toLocaleString()} chars — exactly what is appended to every
                  cover-letter and screening-answer prompt
                </div>
              </div>
              <button className="btn" onClick={() => setContextText(null)}>
                Close
              </button>
            </div>
            <div className="drawer-body">
              <div className="letter" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                {contextText}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
