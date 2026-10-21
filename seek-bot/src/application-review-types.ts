import type { JobListing } from './types.js';

export interface PreparedApplication {
  id: string;
  revision: string;
  job: JobListing;
  preparedAt: string;
  formUrl: string;
  answers: Array<{ question: string; answer: string }>;
  coverLetter?: string;
  resume?: string;
  resumeId?: string;
  resumeHash?: string;
}
