/** Public listing facts and private candidate matches are different records. */
export interface EvidenceTag { value: string; evidence: string; basis: 'source' | 'inferred' }
export interface IndexedJob {
  id: string; url: string; source: string; sourceId: string; title: string; company: string;
  description: string; locations: string[]; applicantLocations: string[];
  postedAt: string | null; expiresAt: string | null;
  workArrangement: 'remote' | 'hybrid' | 'onsite' | 'not-mentioned';
  pay: { status: 'disclosed' | 'unpaid' | 'not-mentioned'; min: number | null; max: number | null; currency: string | null; period: string | null; text: string };
  tags: Record<'categories' | 'employmentTypes' | 'seniority' | 'suitableFor' | 'skills' | 'requirements', EvidenceTag[]>;
  evidence: Record<string, string>;
}
export interface SearchProfile {
  userId: string; fingerprint: string; sourceRevision?: string; keywords: string[]; skills: string[]; location: string;
  arrangements: string[]; excludedCompanies: string[]; sources: Record<string, string>;
}
export interface MatchResult {
  keywords: string[]; skills: string[]; reasons: string[];
  preferences: { arrangement: 'compatible' | 'different' | 'unknown'; location: 'mentioned' | 'unknown' };
  /** Discovery is preliminary; this never grants fit, approval or submission. */
  status: 'potential';
}
