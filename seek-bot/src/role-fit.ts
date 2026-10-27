import type { JobListing } from './types.js';

/** The model judges semantic alignment; code only checks its evidence contract. */
export interface RoleFitCheck {
  alignment: 'aligned' | 'mismatch' | 'uncertain';
  employerEvidence: string;
  candidateEvidence: string;
  explanation: string;
}

const canonical = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function roleFitError(value: unknown, job?: JobListing, candidateText?: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'roleFitCheck must compare primary duties with candidate evidence';
  const check = value as Record<string, unknown>;
  if (!['aligned', 'mismatch', 'uncertain'].includes(String(check.alignment))) return 'roleFitCheck.alignment must be aligned, mismatch or uncertain';
  for (const key of ['employerEvidence', 'candidateEvidence', 'explanation']) {
    if (typeof check[key] !== 'string') return `roleFitCheck.${key} must be a string`;
  }
  const employer = canonical(check.employerEvidence as string);
  const candidate = canonical(check.candidateEvidence as string);
  if (!employer || !(check.explanation as string).trim()) return 'roleFitCheck needs employer evidence and an explanation of the primary work';
  if (job && !canonical([job.title, job.description ?? job.teaser ?? ''].join('\n')).includes(employer)) return 'roleFitCheck.employerEvidence must quote the supplied listing verbatim';
  if (check.alignment === 'aligned' && !candidate) return 'An aligned roleFitCheck needs supporting candidate evidence';
  if (candidate && candidateText !== undefined && !canonical(candidateText).includes(candidate)) return 'roleFitCheck.candidateEvidence must quote the supplied profile, CV or saved answers verbatim';
  return null;
}
