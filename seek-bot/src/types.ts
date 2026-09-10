import type { PlatformId } from './platforms.js';

export interface CandidateProfile {
  name: string;
  dob?: string;
  nationality: string;
  driving?: string;
  phone: string;
  email: string;
  streetAddress?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  qualification?: string;
  expectedSalary: string;
  noticePeriod: string;
  willingToRelocate: boolean;
  willingToTravel?: string;
  pronouns?: string;
  gender?: string;
  disability?: string;
  referralSource?: string;
  /** Free-text career summary used to ground cover letters. Never invented by the model. */
  experienceSummary: string;
  skills: string[];
  /** Domains/stacks to exclude outright, e.g. ".NET/C# as core stack" */
  excludedDomains: string[];
  securityClearance: string;
}

export interface JobListing {
  id: string;
  title: string;
  company: string;
  location: string;
  workArrangement?: string;
  salary?: string;
  listedAt?: string;
  ageDays?: number;
  url: string;
  teaser?: string;
  /** Where this candidate came from. Recommended jobs are evaluated first. */
  source?: 'recommended' | 'search';
  /**
   * Which job board this listing came from. Optional so existing SEEK-only
   * code (fixtures, older records) still type-checks; every discovery module
   * sets it explicitly on everything it returns.
   */
  platform?: PlatformId;
  /**
   * Indeed only: true when Indeed hosts its own Easy Apply/Indeed Apply flow
   * for this job; false means the listing hands off to the employer's own
   * site or ATS. Read straight off Indeed's search payload so off-platform
   * jobs can be classified before a page is even opened.
   */
  indeedApplyable?: boolean;
  /** Known before AI fit review when the job board exposes its apply route. */
  applicationMode?: 'hosted' | 'external' | 'unknown';
  /** Apply destination when the listing exposes one without opening it. */
  applicationUrl?: string;
  /** Populated once the detail page is opened. */
  description?: string;
  /**
   * Annual minimum parsed from SEEK's structured payload, present even when the
   * advertiser hid the range. Used for filtering only — never quoted back as a
   * disclosed salary.
   */
  inferredMinSalary?: number;
  /**
   * SEEK's own "You applied on …" marker from the detail page — authoritative,
   * and the only thing that knows about applications made outside this tool.
   */
  alreadyApplied?: boolean;
  appliedNote?: string;
  /**
   * SEEK's own "you'd be a strong applicant" signal from the detail page —
   * its assessment of profile-to-ad fit, not this tool's scoring. Treated as
   * an override on the soft (score/AI-fit) gates, never on hard exclusions.
   */
  strongApplicant?: boolean;
  strongApplicantNote?: string;
}

export interface ScoreBreakdown {
  skills: number;
  title: number;
  recency: number;
  salary: number;
  credibility: number;
  location: number;
  total: number;
  reasons: string[];
}

export type ApplyOutcome =
  | {
      status: 'applied';
      jobId: string;
      at: string;
      note?: string;
      /** Exactly what was sent, kept for the dashboard and for auditing. */
      coverLetter?: string;
      answers?: Array<{ question: string; answer: string }>;
    }
  /** Dry run: form was completed but the final submit was withheld. */
  | {
      status: 'rehearsed';
      jobId: string;
      coverLetter?: string;
      answers: Array<{ question: string; answer: string }>;
      stoppedAt: string;
    }
  | { status: 'skipped'; jobId: string; reason: string }
  | { status: 'off-platform'; jobId: string; redirectedTo: string }
  | {
      status: 'needs-human';
      jobId: string;
      reason: string;
      url: string;
      /** Employer questions the profile could not answer — the dashboard asks the candidate. */
      questions?: string[];
    }
  | { status: 'error'; jobId: string; error: string };

export interface AppliedRecord {
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  appliedAt: string;
  score: number;
  platform: PlatformId;
  salary?: string;
  workArrangement?: string;
  ageDaysAtApply?: number;
  /** The letter actually submitted, verbatim. */
  coverLetter?: string;
  /** Screening questions and the answers that were submitted. */
  answers?: Array<{ question: string; answer: string }>;
  /** Why this job scored as it did — the rubric's own reasoning. */
  scoreReasons?: string[];
}

/** A single interactive field the apply form is asking about. */
export interface FormField {
  ref: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox';
  required: boolean;
  options?: string[];
  currentValue?: string;
  /** True for custom ATS inputs that require choosing a suggestion. */
  autocomplete?: boolean;
}

export interface FieldAnswer {
  ref: string;
  value: string;
  /** false when the model had no grounded basis in the profile — triggers human handoff. */
  grounded: boolean;
  rationale?: string;
}
