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
}

export type LogStatus =
  | 'applied'
  | 'skipped'
  | 'off-platform'
  | 'needs-human'
  | 'rehearsed'
  | 'error';

export interface LogEntry {
  ts: string;
  status: LogStatus;
  jobId: string;
  title?: string;
  company?: string;
  reason?: string;
  redirectedTo?: string;
  url?: string;
  error?: string;
}

export const STATUS_META: Record<LogStatus, { label: string; tone: string }> = {
  applied: { label: 'Applied', tone: 'ok' },
  skipped: { label: 'Skipped', tone: 'muted' },
  'off-platform': { label: 'Off-platform', tone: 'info' },
  'needs-human': { label: 'Needs you', tone: 'warn' },
  rehearsed: { label: 'Rehearsed', tone: 'info' },
  error: { label: 'Error', tone: 'bad' },
};
