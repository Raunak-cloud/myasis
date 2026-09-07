import { useState } from 'react';

export function SearchTermsGenerator({
  currentTerms,
  targetRole,
  disabled = false,
  onGenerated,
}: {
  currentTerms: string;
  targetRole: string;
  disabled?: boolean;
  onGenerated: (value: string) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function generate() {
    if (generating || disabled) return;
    setGenerating(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await fetch('/api/search-terms/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentTerms, targetRole }),
      });
      const result = await response.json() as {
        terms?: unknown;
        resumeLabel?: unknown;
        error?: unknown;
      };
      if (!response.ok || !Array.isArray(result.terms)) {
        throw new Error(typeof result.error === 'string' ? result.error : 'Could not generate search terms.');
      }
      const terms = result.terms.filter((term): term is string => typeof term === 'string');
      onGenerated(terms.join(', '));
      const label = typeof result.resumeLabel === 'string' ? result.resumeLabel : 'your résumé';
      setMessage(`Generated and eligibility-checked ${terms.length} terms from ${label}. Review them before saving.`);
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
        className="btn search-terms-ai-button"
        disabled={disabled || generating}
        onClick={generate}
      >
        {generating ? 'Generating…' : '✨ Generate from résumé'}
      </button>
      {message && (
        <span className={`job-meta search-terms-ai-message ${failed ? 'bad' : ''}`} role={failed ? 'alert' : 'status'}>
          {message}
        </span>
      )}
    </div>
  );
}
