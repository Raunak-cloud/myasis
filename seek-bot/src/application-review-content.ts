import { createHash } from 'node:crypto';
import { applicationKeys, applicationFormKey } from './application-identity.js';
import type { PreparedApplication } from './application-review-types.js';
import type { JobListing } from './types.js';
import { cleanCoverLetter } from './cover-letter-policy.js';

const normal = (text: string) => text.replace(/\s+/g, ' ').trim();
export function applicationContent(application: Pick<PreparedApplication, 'job' | 'formUrl' | 'answers' | 'coverLetter' | 'resumeHash' | 'resume'>): string {
  const answers = application.answers.map(item => [normal(item.question), normal(item.answer)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const posting = Object.fromEntries(['title', 'company', 'location', 'description', 'salary'].map(key => [key, normal(String(application.job[key as keyof JobListing] ?? ''))]));
  return JSON.stringify({ target: applicationKeys(application.job), posting, form: applicationFormKey(application.job, application.formUrl), answers, coverLetter: normal(application.coverLetter ?? ''), resume: application.resume ?? '', resumeHash: application.resumeHash ?? '' });
}

export const applicationRevision = (application: Parameters<typeof applicationContent>[0]) => createHash('sha256').update(applicationContent(application)).digest('hex');

export function withCoverLetter(current: PreparedApplication, text: string): PreparedApplication {
  const coverLetter = cleanCoverLetter(text);
  const previous = normal(current.coverLetter ?? '');
  const application: PreparedApplication = { ...current, coverLetter,
    answers: current.answers.map(answer => previous && normal(answer.answer) === previous ? { ...answer, answer: coverLetter } : answer) };
  application.revision = applicationRevision(application);
  return application;
}
