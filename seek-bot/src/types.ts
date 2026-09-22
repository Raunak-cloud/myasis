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
};

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
  /** Submitted on an employer's own site rather than the job board. Counted against the daily employer-site allowance. */
  external?: boolean;
  /** That employer site's host. */
  site?: string;
  /** Accounts created, sign-ins and other side effects of this application. */
  actions?: ApplicationAction[];
  /** False when the record was only discovered on the job board for duplicate protection. */
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

export interface FieldAnswer {
  ref: string;
  value: string;
  /** False when the observed control is page chrome or a misread heading, not part of the application. */
  applicationQuestion?: boolean;
  /** false when nothing supports an answer — triggers the human handoff. */
  grounded: boolean;
  /**
   * Where a filled answer came from, recorded so an application can be
   * audited afterwards:
   *  - 'profile'  drawn from the candidate's own material
   *  - 'composed' written by the model, asserting no checkable claim
   *  - 'none'     not answerable; the candidate is asked
   */
  basis?: 'profile' | 'composed' | 'none';
  rationale?: string;
  /** What to ask the candidate when this answer cannot be grounded. */
  candidatePrompt?: string;
  /**
   * The model's reading of which identity detail on file the field asks for:
   * name, firstName, lastName, email or phone — or none. Such values are
   * copied from the profile exactly, so a typo cannot reach an employer.
   */
  profileField?: string;
}
