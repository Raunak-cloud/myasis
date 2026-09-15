import { useEffect, useState } from 'react';

interface ResumeOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

export function SearchTermsGenerator({
  currentTerms,
  disabled = false,
  refreshKey = 0,
  onGenerated,
}: {
  currentTerms: string;
  disabled?: boolean;
  refreshKey?: number;
  onGenerated: (value: string) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [resumes, setResumes] = useState<ResumeOption[]>([]);
  const [selectedResumeIds, setSelectedResumeIds] = useState<string[]>([]);

  useEffect(() => {
    fetch('/api/resumes')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load résumés.');
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        const next = Array.isArray(value)
          ? value.filter((item): item is ResumeOption => (
              Boolean(item)
              && typeof item === 'object'
              && typeof (item as ResumeOption).id === 'string'
              && typeof (item as ResumeOption).label === 'string'
            ))
          : [];
        setResumes(next);
        setSelectedResumeIds(next.map((resume) => resume.id));
      })
      .catch((error) => {
        setFailed(true);
        setMessage((error as Error).message);
      });
  }, [refreshKey]);

  function toggleResume(id: string) {
    setSelectedResumeIds((current) => (
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    ));
  }

  async function generate() {
    if (generating || disabled) return;
    if (!selectedResumeIds.length) {
      setFailed(true);
      setMessage('Select at least one résumé.');
      return;
    }
    setGenerating(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await fetch('/api/search-terms/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentTerms, resumeIds: selectedResumeIds }),
      });
      const result = await response.json() as {
        terms?: unknown;
        resumeLabel?: unknown;
        resumeLabels?: unknown;
        error?: unknown;
      };
      if (!response.ok || !Array.isArray(result.terms)) {
        throw new Error(typeof result.error === 'string' ? result.error : 'Could not generate search terms.');
      }
      const terms = result.terms.filter((term): term is string => typeof term === 'string');
      onGenerated(terms.join(', '));
      const label = typeof result.resumeLabel === 'string' ? result.resumeLabel : 'your selected résumés';
      setMessage(`Suggested ${terms.length} job titles from ${label}. Review them, then save.`);
    } catch (error) {
      setFailed(true);
      setMessage((error as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="search-terms-ai">
      <button
        type="button"
        className="btn btn-small search-terms-ai-button"
        disabled={disabled || generating || !resumes.length}
        onClick={generate}
      >
        {generating ? 'Suggesting…' : '✨ Suggest from my résumés'}
      </button>
      {resumes.length > 1 && (
        <details className="search-terms-resumes">
          <summary>
            {selectedResumeIds.length === resumes.length
              ? `Using all ${resumes.length} résumés`
              : `Using ${selectedResumeIds.length} of ${resumes.length} résumés`}
          </summary>
          <div className="search-terms-resume-list">
            {resumes.map((resume) => (
              <label key={resume.id}>
                <input
                  type="checkbox"
                  checked={selectedResumeIds.includes(resume.id)}
                  disabled={disabled || generating}
                  onChange={() => toggleResume(resume.id)}
                />
                <span>{resume.label}{resume.isDefault ? ' (default)' : ''}</span>
              </label>
            ))}
            <div className="search-terms-resume-actions">
              <button type="button" className="btn" onClick={() => setSelectedResumeIds(resumes.map((resume) => resume.id))}>
                Select all
              </button>
              <button type="button" className="btn" onClick={() => setSelectedResumeIds([])}>
                Clear
              </button>
            </div>
          </div>
        </details>
      )}
      {message && (
        <span className={`job-meta search-terms-ai-message ${failed ? 'bad' : ''}`} role={failed ? 'alert' : 'status'}>
          {message}
        </span>
      )}
    </div>
  );
}
