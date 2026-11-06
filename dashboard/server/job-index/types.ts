/** Public listing facts and private candidate matches are different records. */
export const MATCH_POLICY='resume-fit-v1';
// Reconsider cached decisions made before discovery metadata was distinguished
// from mandatory candidate qualifications. Existing valid matches stay valid.
export const FIT_CACHE_POLICY=`${MATCH_POLICY}:discovery-metadata-v2`;
export interface EvidenceTag { value: string; evidence: string; basis: 'source' | 'inferred' }
export interface IndexedJob {
  id: string; url: string; source: string; sourceId: string; title: string; company: string;
  description: string; locations: string[]; applicantLocations: string[];
  /** Publisher-declared countries, retained independently of display labels. */
  locationCountries?: string[]; applicantLocationCountries?: string[];
  postedAt: string | null; expiresAt: string | null;
  workArrangement: 'remote' | 'hybrid' | 'onsite' | 'not-mentioned';
  pay: { status: 'disclosed' | 'unpaid' | 'not-mentioned'; min: number | null; max: number | null; currency: string | null; period: string | null; text: string };
  tags: Record<'categories' | 'employmentTypes' | 'seniority' | 'suitableFor' | 'skills' | 'requirements', EvidenceTag[]>;
  evidence: Record<string, string>;
}
export interface SearchProfile {
  userId: string; fingerprint: string; sourceRevision?: string; keywords: string[]; skills: string[]; location: string;
  arrangements: string[]; excludedCompanies: string[]; sources: Record<string, string>;
  /** Derived from explicit allowed titles in standing instructions; not a saved-setting override. */
  searchRoles?:string[];
  criteria?: {minScore:number;minSalary:number;minHourlyRate:number;maxAgeDays:number;radiusKm?:number;jobTypes:string[]};
}
export interface PreliminaryMatch {
  keywords: string[]; skills: string[]; reasons: string[];
  preferences: { arrangement: 'compatible' | 'different' | 'unknown'; location: 'mentioned' | 'unknown' };
  /** Discovery is preliminary; this never grants fit, approval or submission. */
  status: 'potential';
}
export interface MatchResult extends Omit<PreliminaryMatch,'status'> {
  status:'matched';
  review:{policy:string;model:string;score:number;reason:string};
}
/** In-memory only; never serialised to the external catalog or search provider. */
export interface FitEvidence {resume:string;instructions:string}
