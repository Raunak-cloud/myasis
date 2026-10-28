import type { JobListing } from './types.js';

/** The model judges semantic alignment; code only checks its evidence contract. */
export interface RoleFitCheck {
  alignment: 'aligned' | 'mismatch' | 'uncertain';
  employerEvidence: string;
  candidateEvidence: string;
  explanation: string;
}

// Compare source words, not the layout of extracted PDFs or employer bullets.
// Keep contractions, numbers/decimals and meaningful technical/numeric symbols:
// C++ is not C, 3.5 is not 35, and "can't" is not "can".
const canonical = (text: string) => (text.normalize('NFKC').replace(/[‘’]/g, "'").toLowerCase()
  .match(/[-−]?\p{N}+(?:[.,]\p{N}+)*(?:[+%])?|\p{L}[\p{L}\p{N}]*(?:'[\p{L}\p{N}]+)*(?:[.,]\p{N}+)*(?:[+#]+)?|[+#%/<>=]|\p{Sc}/gu) ?? []).join(' ');

/** Formatting and explicit omissions are presentation, not invented facts.
 * Every quoted passage's words must still occur, in order, in the source. */
function containsQuotation(source: string, quote: string): boolean {
  const passages = quote.split(/\s*(?:\[?(?:\.{3}|…)\]?)\s*/).map(canonical).filter(Boolean);
  const text = ` ${canonical(source)} `;
  let offset = 0;
  return passages.length > 0 && passages.every(passage => {
    const index = text.indexOf(` ${passage} `, offset);
    if (index < 0) return false;
    offset = index + passage.length + 1; return true;
  });
}

export function roleFitError(value: unknown, job?: JobListing, candidateText?: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'roleFitCheck must compare primary duties with candidate evidence';
  const check = value as Record<string, unknown>;
  if (!['aligned', 'mismatch', 'uncertain'].includes(String(check.alignment))) return 'roleFitCheck.alignment must be aligned, mismatch or uncertain';
  for (const key of ['employerEvidence', 'candidateEvidence', 'explanation']) {
    if (typeof check[key] !== 'string') return `roleFitCheck.${key} must be a string`;
  }
  const employer = (check.employerEvidence as string).trim();
  const candidate = (check.candidateEvidence as string).trim();
  if (!employer || !(check.explanation as string).trim()) return 'roleFitCheck needs employer evidence and an explanation of the primary work';
  if (job && !containsQuotation([job.title, job.description ?? job.teaser ?? ''].join('\n'), employer)) return 'roleFitCheck.employerEvidence must quote the supplied listing verbatim';
  if (check.alignment === 'aligned' && !candidate) return 'An aligned roleFitCheck needs supporting candidate evidence';
  if (candidate && candidateText !== undefined && !containsQuotation(candidateText, candidate)) return 'roleFitCheck.candidateEvidence must quote the supplied profile, CV or saved answers verbatim';
  return null;
}
