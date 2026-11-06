import type { JobListing } from './types.js';

/** Owner-scoped immutable bytes, explicitly assigned a role by the applying agent. */
export interface ApplicationDocument {
  role: 'cover-letter' | 'supporting';
  fileId: string;
  name: string;
  sha256: string;
  bytes: number;
  text?: string;
  /** Text-derived cover letters authorize exact-text rendering, not new prose. */
  provenance?: 'text' | 'file';
  /** A candidate edit produced bytes not yet delivered to the employer. */
  requiresUpload?: boolean;
}

/** Attributed restoration of omitted document metadata; original run history
 * and source bytes remain unchanged. This is excluded from content consent. */
export interface ApplicationDocumentRestoration {
  id: string;
  actorUserId: string;
  restoredAt: string;
  sourceRunId: string;
  originalRevision: string;
  previousRevision: string;
  currentRevision: string;
  holdId: string;
  fileId: string;
  sha256: string;
  reason: string;
  evidence: { attemptId: string; step: number; nativeUploadCompletedAt: string; originalPreparedAt: string; traceSha256: string;
    nativeReadback: 'confirmed' | 'unavailable'; selectionCompleted: true; employerRetention: 'unverified' };
}

export interface PreparedApplication {
  /** Job/letter preparation precedes form filling; legacy drafts are completed forms. */
  preparation?: { version: 1; stage: 'job-and-letter'; access: 'no-login-required' | 'signed-in'; checkedAt: string; checkedUrl: string }
    | { version: 2; stage: 'job-and-letter'; access: 'not-checked'; listingUrl: string };
  id: string;
  revision: string;
  job: JobListing;
  preparedAt: string;
  formUrl: string;
  answers: Array<{ question: string; answer: string }>;
  coverLetter?: string;
  documents?: ApplicationDocument[];
  documentRestorations?: ApplicationDocumentRestoration[];
  resume?: string;
  resumeId?: string;
  resumeHash?: string;
  email?: { to: string; subject: string; attachCoverLetter?: boolean };
}
