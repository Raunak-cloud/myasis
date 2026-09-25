export interface Answer {
  question: string;
  answer: string;
}

/** User-recorded result of an application. */
export type Outcome = 'interview' | 'rejected' | 'closed';

export interface Application {
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  appliedAt: string;
  score: number;
  platform: string;
  salary?: string;
  workArrangement?: string;
  ageDaysAtApply?: number;
  coverLetter?: string;
  answers?: Answer[];
  scoreReasons?: string[];
  outcome?: Outcome | null;
  /** Submitted on the employer's own site rather than through the job board. */
  external?: boolean;
  /** That employer site's host. */
  site?: string;
  /** What Myasis did on the candidate's behalf while applying. */
  actions?: ApplicationAction[];
}

export interface ApplicationAction {
  kind: 'account-created' | 'signed-in' | 'password-reset' | 'authentication-prepared' | 'resume-uploaded' | 'email-code';
  site: string;
  email?: string;
  detail: string;
  at: string;
}

export interface SiteAccount {
  site: string;
  email: string;
  createdByMyasis: boolean;
  jobTitle: string | null;
  company: string | null;
  firstUsedAt: string;
  lastUsedAt: string;
}
