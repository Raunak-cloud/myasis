import { createHash } from 'node:crypto';
import { applicationKeys, applicationFormKey } from './application-identity.js';
import type { PreparedApplication } from './application-review-types.js';
import type { JobListing } from './types.js';
import { cleanCoverLetter } from './cover-letter-policy.js';

const normal = (text: string) => text.replace(/\s+/g, ' ').trim();
export function applicationContent(application: Pick<PreparedApplication, 'job' | 'formUrl' | 'answers' | 'coverLetter' | 'documents' | 'resumeHash' | 'resume' | 'email' | 'preparation'>): string {
  const answers = application.answers.map(item => [normal(item.question), normal(item.answer)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const posting = Object.fromEntries(['title', 'company', 'location', 'description', 'salary'].map(key => [key, normal(String(application.job[key as keyof JobListing] ?? ''))]));
  const opaqueDocuments = application.documents?.filter(document => document.role !== 'cover-letter' || document.provenance !== 'text' || document.text !== application.coverLetter);
  // PostgreSQL JSONB reorders object keys. Preserve the original worker field
  // order so persisted drafts retain their exact existing approval revision.
  const p=application.preparation;
  const preparation=p?{version:p.version,stage:p.stage,access:p.access,checkedAt:p.checkedAt,checkedUrl:p.checkedUrl}:undefined;
  return JSON.stringify({ target: applicationKeys(application.job), posting, form: applicationFormKey(application.job, application.formUrl), answers, coverLetter: normal(application.coverLetter ?? ''), resume: application.resume ?? '', resumeHash: application.resumeHash ?? '',
    ...(opaqueDocuments?.length ? {
      documents: opaqueDocuments.sort((a,b) => a.fileId.localeCompare(b.fileId)).map(document => ({
        role: document.role, provenance: document.provenance ?? 'file', fileId: document.fileId,
        name: document.name, sha256: document.sha256, bytes: document.bytes, text: document.text ?? '',
      })),
    } : {}),
    ...(application.email ? { email: application.email } : {}),
    ...(preparation ? { preparation } : {}) });
}

export const applicationRevision = (application: Parameters<typeof applicationContent>[0]) => createHash('sha256').update(applicationContent(application)).digest('hex');

export function withCoverLetter(current: PreparedApplication, text: string): PreparedApplication {
  const coverLetter = cleanCoverLetter(text);
  const previous = normal(current.coverLetter ?? '');
  if (current.documents?.some(document => document.role === 'cover-letter') && coverLetter !== current.coverLetter)
    throw Error('Use the attached-letter revision operation to render a new immutable artifact before saving changed text.');
  const application: PreparedApplication = { ...current, coverLetter,
    answers: current.answers.map(answer => previous && normal(answer.answer) === previous ? { ...answer, answer: coverLetter } : answer) };
  application.revision = applicationRevision(application);
  return application;
}
