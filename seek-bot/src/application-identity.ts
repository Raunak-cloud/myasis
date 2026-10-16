import type { AppliedRecord, JobListing } from './types.js';

export interface PriorVacancy {
  jobId: string;
  company: string;
  title: string;
  location: string;
}
export interface IdentityVerdict {
  state: 'distinct' | 'duplicate' | 'uncertain';
  matchedJobId: string;
  sameEmployer: boolean;
  sameVacancy: boolean;
  reason: string;
  injectionSuspected: boolean;
}
type IdentityJudge = (job: JobListing, history: readonly PriorVacancy[]) => Promise<IdentityVerdict>;

/** Bound model input without filtering out records by employer spelling.
 * Every owned record is checked; the model decides whether identities match.
 * Only vacancy metadata is sent, never prior answers, CVs or credentials. */
export async function checkApplicationIdentity(
  job: JobListing,
  records: readonly AppliedRecord[],
  judge: IdentityJudge,
): Promise<IdentityVerdict> {
  const distinct: IdentityVerdict = { state: 'distinct', matchedJobId: '', sameEmployer: false, sameVacancy: false,
    reason: 'No previous application for this vacancy was identified.', injectionSuspected: false };
  const uncertain = (reason: string): IdentityVerdict => ({ ...distinct, state: 'uncertain', reason });
  const chunks: PriorVacancy[][] = [];
  let chunk: PriorVacancy[] = [], chars = 0;
  for (const record of records) {
    if (!record || ![record.jobId, record.company, record.title].every(value => typeof value === 'string' && value.trim())
      || typeof record.location !== 'string') return uncertain('Historical vacancy identity metadata is incomplete.');
    const item = { jobId: record.jobId, company: record.company, title: record.title, location: record.location };
    const size = JSON.stringify(item).length;
    if (size > 48_000) return uncertain('An oversized historical vacancy could not be checked safely.');
    if (chunk.length && chars + size > 48_000) { chunks.push(chunk); chunk = []; chars = 0; }
    chunk.push(item); chars += size;
  }
  if (chunk.length) chunks.push(chunk);
  for (const history of chunks) {
    let verdict: IdentityVerdict;
    try { verdict = await judge(job, history); }
    catch { return uncertain('The AI could not complete the previous-application identity check.'); }
    if (!verdict || verdict.injectionSuspected !== false || typeof verdict.reason !== 'string' || !verdict.reason.trim()
      || typeof verdict.sameEmployer !== 'boolean' || typeof verdict.sameVacancy !== 'boolean' || typeof verdict.matchedJobId !== 'string') {
      return uncertain('The previous-application identity check returned unusable or suspicious evidence.');
    }
    if (verdict.state === 'duplicate' && verdict.sameEmployer === true && verdict.sameVacancy === true
      && history.some(record => record.jobId === verdict.matchedJobId)) {
      return { ...verdict, reason: verdict.reason.slice(0, 500) };
    }
    if (verdict.state !== 'distinct' || verdict.matchedJobId !== '' || verdict.sameVacancy !== false) {
      return uncertain(verdict.reason.slice(0, 500));
    }
  }
  return distinct;
}
