import type { ResumeSearchSuggestion } from '../src/resume-search.js';
import { MAX_SEARCH_TERMS } from '../src/search-limits.js';

export interface SearchResume { id: string; label: string; text: string }
export interface GroundedSearch extends ResumeSearchSuggestion {
  id: string;
  credentialRequired: string;
  credentialEvidence: { resumeId: string; resumeLabel: string; quote: string } | null;
}
export const MAX_SEARCH_CANDIDATES = MAX_SEARCH_TERMS * 2;
export const MAX_RESUME_CHARS = 40_000;
export const MAX_COMBINED_RESUME_CHARS = 60_000;

function searchTermKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
}

export function normalizeSearchTerms(input: unknown, limit = MAX_SEARCH_TERMS): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const term = value.replace(/[\r\n,;|]+/g, ' ').replace(/^[\s\d.)-]+/, '').replace(/\s+/g, ' ').trim();
    const key = searchTermKey(term);
    if (term.length < 3 || term.length > 70 || !key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : '';
}

/** Permit PDF line wrapping and typography changes, never paraphrased evidence. */
function quoteKey(value: string): string {
  return value.normalize('NFKC').replace(/\u00ad/g, '').replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

function sourceEvidence(value: unknown, resumes: readonly SearchResume[]): ResumeSearchSuggestion['evidence'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const source = resumes.find(resume => resume.id === record.resumeId);
  const quote = text(record.quote, 600);
  if (!source || quote.length < 8 || !quoteKey(source.text).includes(quoteKey(quote))) return null;
  return { resumeId: source.id, resumeLabel: source.label, quote };
}

/** Check against exactly the account-owned documents sent to the model. */
export function groundGeneratedSearches(input: unknown, resumes: readonly SearchResume[], excluded: readonly string[] = []): GroundedSearch[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set(excluded.map(searchTermKey));
  const out: GroundedSearch[] = [];
  for (const item of input.slice(0, MAX_SEARCH_CANDIDATES)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const query = normalizeSearchTerms([record.query], 1)[0];
    const key = query ? searchTermKey(query) : '';
    const reason = text(record.reason, 400);
    if (!query || !reason || seen.has(key) || !['direct', 'transferable'].includes(String(record.matchType))) continue;
    if (!Array.isArray(record.resumeEvidence) || !record.resumeEvidence.length || record.resumeEvidence.length > 4) continue;
    const evidence = record.resumeEvidence.map(value => sourceEvidence(value, resumes));
    // Reject the whole candidate if even one of its citations is invented.
    if (evidence.some(value => !value)) continue;
    if (typeof record.australianCredentialRequired !== 'string') continue;
    const credentialRequired = text(record.australianCredentialRequired, 200);
    if (record.australianCredentialRequired.trim() && !credentialRequired) continue;
    const credentialEvidence = sourceEvidence(record.australianCredentialEvidence, resumes);
    if (credentialRequired && !credentialEvidence) continue;
    seen.add(key);
    out.push({ id: `s${out.length + 1}`, query, reason, matchType: record.matchType as GroundedSearch['matchType'],
      evidence: evidence as ResumeSearchSuggestion['evidence'], credentialRequired, credentialEvidence });
  }
  return out;
}

/** A reviewer can only accept existing candidates, never add or rewrite a role. */
export function reviewedSearches(candidates: readonly GroundedSearch[], input: unknown): ResumeSearchSuggestion[] {
  if (!Array.isArray(input)) return [];
  const accepted = candidates.filter(candidate => {
    const decisions = input.filter(item => item && typeof item === 'object' && item.id === candidate.id);
    if (decisions.length !== 1) return false;
    const decision = decisions[0] as Record<string, unknown>;
    return decision.supported === true && decision.senioritySupported === true
      && decision.credentialsSupported === true && decision.distinct === true
      && decision.matchType === candidate.matchType;
  });
  // Direct experience wins over an adjacent role even when generation order differs.
  return [...accepted.filter(c => c.matchType === 'direct'), ...accepted.filter(c => c.matchType === 'transferable')]
    .slice(0, MAX_SEARCH_TERMS).map(({ query, matchType, reason, evidence }) => ({ query, matchType, reason, evidence }));
}

export function resumeContextError(resumes: readonly SearchResume[]): string | null {
  const long = resumes.find(resume => resume.text.length > MAX_RESUME_CHARS);
  if (long) return `“${long.label}” is too long to assess completely. Use a shorter resume so its experience and qualifications can all be checked.`;
  if (resumes.reduce((sum, resume) => sum + resume.text.length, 0) > MAX_COMBINED_RESUME_CHARS) {
    return 'The selected resumes are too long to assess together. Select fewer resumes so all their evidence can be checked.';
  }
  return null;
}
