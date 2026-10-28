import type { PlatformId } from './platforms.js';

export interface CandidateProfile {
  name: string;
  dob?: string;
  nationality: string;
  /** Candidate-declared work permission, separate from nationality. */
  workRights?: string;
  /** Jurisdiction of the declared work permission; never inferred from address. */
  workRightsCountry?: string;
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

export interface FitRejection {
  /** Only listing facts can be revalidated from the next run's listing. */
  source: 'listing' | 'form';
  /** Exact employer quote supporting the suitability conflict. */
  evidence: string;
}

export interface JobFitReview {
  score: number;
  reason: string;
  evidence: string[];
  roleFitCheck?: import('./role-fit.js').RoleFitCheck;
  workArrangementCheck?: { offered: Array<'onsite' | 'hybrid' | 'remote'>; evidence: string };
  contentFingerprint: string;
  contextFingerprint: string;
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
  /** Where review found it; 'chosen' is a skipped job the candidate said they would have applied to. */
  source?: 'recommended' | 'search' | 'chosen';
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
  /** Search-card identity retained when the detail page enriches fields. */
  discoveryFingerprint?: string;
  /** Trusted review handoff, usable only while listing and candidate context match. */
  fitReview?: JobFitReview;
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

/**
 * Something Myasis did while applying that the candidate has to know about.
 *
 * An account created on an employer's site, a sign-in, a document added to a
 * job-board profile, a code read from their inbox: each changes something the
 * candidate owns or will be asked about later, so it is recorded where it
 * happened and shown with the application. A password is never recorded; the
 * dashboard derives the site's password again when its owner asks for it.
 */
export interface ApplicationAction {
  kind: 'account-created' | 'signed-in' | 'password-reset' | 'authentication-prepared' | 'resume-uploaded' | 'email-code';
  /** Host where it happened, e.g. "anglicare.wd105.myworkdayjobs.com". */
  site: string;
  /** The email the site account uses, for account actions. */
  email?: string;
  /** For authentication-prepared: what the page was doing with the credential. */
  purpose?: 'create_account' | 'sign_in' | 'reset_password';
  /** One plain sentence for the candidate. */
  detail: string;
  at: string;
}

export type ApplyOutcome = (
  | {
      status: 'applied';
      jobId: string;
      at: string;
      /** The employer site the application was submitted on, when it was not the job board. */
      site?: string;
      note?: string;
      /** Exactly what was sent, kept for the dashboard and for auditing. */
      coverLetter?: string;
      answers?: Array<{ question: string; answer: string }>;
      /** The resume file that went out with the application. */
      resume?: string;
    }
  /** Dry run: form was completed but the final submit was withheld. */
  | {
      status: 'rehearsed';
      jobId: string;
      resume?: string;
      coverLetter?: string;
      answers: Array<{ question: string; answer: string }>;
      stoppedAt: string;
    }
  | { status: 'prepared'; jobId: string; draft: import('./application-review-types.js').PreparedApplication }
  | { status: 'skipped'; jobId: string; reason: string; fitRejection?: FitRejection }
  | { status: 'already-applied'; jobId: string; reason: string }
  | { status: 'off-platform'; jobId: string; redirectedTo: string }
  | {
      status: 'needs-human';
      jobId: string;
      reason: string;
      url: string;
      /** Employer questions the profile could not answer — the dashboard asks the candidate. */
      questions?: BlockedQuestion[];
    }
  | { status: 'error'; jobId: string; error: string }
) & {
  /** What this attempt changed or used on the candidate's behalf, whatever its result. */
  actions?: ApplicationAction[];
  /**
   * The application's own submit control was pressed. Whatever the recorded
   * status, the employer may have received it, so the job is never retried
   * automatically — a second copy to a real employer is worse than a miss.
   */
  submitPressed?: boolean;
  /** Known entry address retained separately from the original board advert. */
  applicationUrl?: string;
};

export interface AppliedRecord {
  /** Unconfirmed historical sends are retained for audit/duplicate protection. */
  confirmationStatus?: 'unconfirmed';
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  applicationUrl?: string;
  appliedAt: string;
  score: number;
  platform: PlatformId;
  salary?: string;
  workArrangement?: string;
  ageDaysAtApply?: number;
  /** The letter actually submitted, verbatim. */
  coverLetter?: string;
  /** The resume file sent, as the board or employer received it. */
  resume?: string;
  /** Screening questions and the answers that were submitted. */
  answers?: Array<{ question: string; answer: string }>;
  /** Why this job scored as it did — the rubric's own reasoning. */
  scoreReasons?: string[];
  /** Submitted on an employer's own site rather than the job board. Counted against the daily employer-site allowance. */
  external?: boolean;
  /** That employer site's host. */
  site?: string;
  /** Accounts created, sign-ins and other side effects of this application. */
  actions?: ApplicationAction[];
  /** False for observed history or unconfirmed sends retained for duplicate protection. */
  submittedByMyasis?: boolean;
}

/** A single interactive field the apply form is asking about. */
export interface FormField {
  ref: string;
  label: string;
  /** Explanatory copy the form associates with this field. */
  description?: string;
  /**
   * Where the field sits: the nearest heading above it and any named group
   * around it, outermost first ("Work Experience 1 › From"). A label alone is
   * ambiguous — "Job Title" in a work-history entry is a job the candidate
   * held, not the one being applied for.
   */
  section?: string;
  kind: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox';
  /** The field's own markup names (name, id, autocomplete, placeholder), to check the caption against. */
  hints?: string;
  required: boolean;
  options?: string[];
  currentValue?: string;
  /** Current browser/ARIA validation failure, observed rather than inferred. */
  validationError?: string;
  /** True for custom ATS inputs that require choosing a suggestion. */
  autocomplete?: boolean;
  /**
   * The input's own type — "date", "number", "email", "tel".
   *
   * A native date input silently refuses anything that is not YYYY-MM-DD, so
   * an answerer told only that this is a "text" field writes "Immediate" and
   * the field stays empty. The browser's own constraint is a fact the
   * answerer needs, not a rule to be guessed at from the label.
   */
  inputType?: string;
  /** Native/ARIA interaction state, observed without choosing an interaction. */
  readOnly?: boolean;
  disabled?: boolean;
  /** A credential the candidate must set, not a question about them. Never stored or asked for. */
  sensitive?: boolean;
}

/**
 * A question a run could not answer, carrying the choices the form offered.
 *
 * The dashboard turns these into a form for the candidate. Shown a dropdown's
 * question as a free-text box, people typed "yes" where the form wanted
 * "Yes - full time", and the saved answer then matched nothing on retry.
 */
export interface BlockedQuestion {
  question: string;
  /** Complete candidate-facing request; `question` stays the exact form label used on retry. */
  prompt?: string;
  kind?: FormField['kind'];
  options?: string[];
}
