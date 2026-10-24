import { useEffect, useRef, useState } from 'react';
import { useEntitlements } from '../entitlements';
import { MAX_SEARCH_TERMS } from '../search-limits';
import type { ResumeSearchSuggestion } from '../resume-search';

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
  const [suggestions, setSuggestions] = useState<ResumeSearchSuggestion[]>([]);
  const requestContext = useRef({ cancelled: false });
  /** Suggestions already shown in this session must not cycle back later. */
  const [priorSuggestedTerms, setPriorSuggestedTerms] = useState<string[]>([]);
  const entitlements = useEntitlements();
  /** Null until known and when unlimited; a number on the free plan. */
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => setLeft(entitlements?.searchTermSuggestionsLeft ?? null), [entitlements]);
  const exhausted = left !== null && left <= 0;

  useEffect(() => {
    const request = { cancelled: false };
    requestContext.current = request;
    fetch('/api/resumes')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load resumes.');
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        if (request.cancelled) return;
        const next = Array.isArray(value)
          ? value.filter((item): item is ResumeOption => (
              Boolean(item)
              && typeof item === 'object'
              && typeof (item as ResumeOption).id === 'string'
              && typeof (item as ResumeOption).label === 'string'
            ))
          : [];
        setResumes(next);
        setGenerating(false);
        setSuggestions([]);
        setSelectedResumeIds(next.map((resume) => resume.id));
        setPriorSuggestedTerms([]);
      })
      .catch((error) => {
        if (request.cancelled) return;
        setGenerating(false);
        setFailed(true);
        setMessage((error as Error).message);
      });
    return () => { request.cancelled = true; };
  }, [refreshKey]);

  function clearSuggestions() {
    setSuggestions([]);
    setPriorSuggestedTerms([]);
    setMessage(null);
    setFailed(false);
  }

  function toggleResume(id: string) {
    clearSuggestions();
    setSelectedResumeIds((current) => (
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    ));
  }

  async function generate(alternatives = false) {
    if (generating || disabled) return;
    if (!selectedResumeIds.length) {
      setFailed(true);
      setMessage('Select at least one resume.');
      return;
    }
    setGenerating(true);
    setMessage(null);
    setFailed(false);
    const request = requestContext.current;
    try {
      const response = await fetch('/api/search-terms/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentTerms,
          resumeIds: selectedResumeIds,
          alternatives,
          ...(alternatives ? { excludeTerms: priorSuggestedTerms } : {}),
        }),
      });
      const result = await response.json() as {
        terms?: unknown;
        resumeLabel?: unknown;
        resumeLabels?: unknown;
        suggestions?: ResumeSearchSuggestion[];
        error?: unknown;
      };
      if (request.cancelled) return;
      if (!response.ok || !Array.isArray(result.terms)) {
        throw new Error(typeof result.error === 'string' ? result.error : 'Could not generate search terms.');
      }
      const terms = result.terms.filter((term): term is string => typeof term === 'string').slice(0, MAX_SEARCH_TERMS);
      if (!terms.length) throw new Error('No supported job titles were returned. Your existing searches have been kept.');
      setSuggestions(Array.isArray(result.suggestions)
        ? result.suggestions.filter(suggestion => suggestion && terms.includes(suggestion.query)
          && typeof suggestion.reason === 'string' && ['direct', 'transferable'].includes(suggestion.matchType)
          && Array.isArray(suggestion.evidence) && suggestion.evidence.every(item =>
            item && typeof item.resumeLabel === 'string' && typeof item.quote === 'string')).slice(0, MAX_SEARCH_TERMS)
        : []);
      const current = currentTerms.split(/[,;|\r\n]+/).map((term) => term.trim()).filter(Boolean);
      setPriorSuggestedTerms((previous) => (
        [...new Set([...previous, ...current, ...terms].map((term) => term.toLowerCase()))]
      ));
      onGenerated(terms.join(', '));
      if (left !== null) setLeft(left - 1);
      const label = typeof result.resumeLabel === 'string' ? result.resumeLabel : 'your selected resumes';
      setMessage(`Suggested ${terms.length} job titles from ${label}. Review them, then save.`);
    } catch (error) {
      if (request.cancelled) return;
      setFailed(true);
      setMessage((error as Error).message);
    } finally {
      if (!request.cancelled) setGenerating(false);
    }
  }

  return (
    <div className="search-terms-ai">
      <button
        type="button"
        className="btn btn-small search-terms-ai-button"
        disabled={disabled || generating || !resumes.length || exhausted}
        title={exhausted ? 'Your free suggestion has been used. Passes include unlimited suggestions.' : undefined}
        onClick={() => void generate()}
      >
        {generating ? 'Suggesting…' : exhausted ? '✨ Suggestion used' : '✨ Suggest from my resumes'}
      </button>
      {priorSuggestedTerms.length > 0 && !exhausted && (
        <button type="button" className="btn btn-small" disabled={disabled || generating || !selectedResumeIds.length}
          onClick={() => void generate(true)}>
          Find alternatives
        </button>
      )}
      {left !== null && !exhausted && !generating && (
        <span className="job-meta search-terms-ai-note">{left === 1 ? 'One free suggestion on your plan.' : `${left} free suggestions on your plan.`}</span>
      )}
      {exhausted && !message && (
        <span className="job-meta search-terms-ai-note">Your free suggestion has been used. Paid passes include unlimited suggestions.</span>
      )}
      {resumes.length > 1 && (
        <details className="search-terms-resumes">
          <summary>
            {selectedResumeIds.length === resumes.length
              ? `Using all ${resumes.length} resumes`
              : `Using ${selectedResumeIds.length} of ${resumes.length} resumes`}
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
              <button type="button" className="btn" disabled={disabled || generating} onClick={() => { clearSuggestions(); setSelectedResumeIds(resumes.map((resume) => resume.id)); }}>
                Select all
              </button>
              <button type="button" className="btn" disabled={disabled || generating} onClick={() => { clearSuggestions(); setSelectedResumeIds([]); }}>
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
      {suggestions.length > 0 && suggestions.every(suggestion => currentTerms.split(/[,;|\r\n]+/).some(term => term.trim() === suggestion.query)) && (
        <details className="search-terms-evidence">
          <summary>Why these suggestions?</summary>
          <div className="search-terms-evidence-list">
            {suggestions.map(suggestion => (
              <article key={suggestion.query}>
                <strong>{suggestion.query}</strong>
                <span className="search-terms-match-type">{suggestion.matchType === 'direct' ? 'Direct experience' : 'Transferable experience'}</span>
                <p>{suggestion.reason}</p>
                {suggestion.evidence.map((item, index) => (
                  <blockquote key={index}>
                    <p>{item.quote}</p>
                    <cite>{item.resumeLabel}</cite>
                  </blockquote>
                ))}
              </article>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
