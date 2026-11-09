import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { applicationKeys } from './application-identity.js';
import type { JobListing } from './types.js';
import type { SavedFitAssessment } from './fit-assessment-types.js';

export const COMPLETED_REVIEWS_FILE = 'completed-job-reviews.jsonl';
export interface CompletedReview {
  key: string;
  keys: string[];
  jobId: string;
  platform: string;
  title: string;
  company: string;
  reviewedAt: string;
  assessment: SavedFitAssessment;
}

export function completedReviewKeys(job: JobListing): string[] {
  // A shared /apply template or a similar title is not a vacancy identity.
  return applicationKeys(job).filter(key => key.startsWith('listing:') || key.startsWith('url:'));
}

export function validCompletedReview(value: unknown): value is CompletedReview {
  if (!value || typeof value !== 'object') return false;
  const row = value as CompletedReview;
  const fit = row.assessment as SavedFitAssessment & {companyExclusionCheck?:{decision?:unknown};duplicateReview?:unknown};
  return typeof row.jobId === 'string' && Boolean(row.jobId) && typeof row.platform === 'string'
    && row.key === `listing:${row.platform}:${row.jobId}` && Array.isArray(row.keys)
    && row.keys.includes(row.key) && row.keys.every(key => typeof key === 'string' && /^(listing:|url:)/.test(key))
    && Number.isFinite(Date.parse(row.reviewedAt)) && Boolean(fit)
    && ['apply', 'skip', 'uncertain'].includes(fit.decision) && fit.shouldApply === (fit.decision === 'apply')
    && Number.isInteger(fit.matchScore) && fit.matchScore >= 0 && fit.matchScore <= 100
    && typeof fit.reason === 'string' && Array.isArray(fit.evidence) && fit.evidence.every(s => typeof s === 'string')
    && typeof fit.injectionSuspected === 'boolean' && !fit.duplicateReview
    && (!fit.companyExclusionCheck || (fit.companyExclusionCheck.decision === 'excluded' && fit.decision === 'skip'));
}

export function readCompletedReviews(path: string): CompletedReview[] {
  if (!existsSync(path)) return [];
  const rows: CompletedReview[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const row: unknown = JSON.parse(line); if (validCompletedReview(row)) rows.push(row); } catch { /* Retain the other completed decisions. */ }
  }
  return rows;
}

const snapshots = new Map<string, { size: number; mtime: number; reviews: Map<string, CompletedReview> }>();
function snapshot() {
  const path = resolve(config.dataDir, COMPLETED_REVIEWS_FILE);
  const info = existsSync(path) ? statSync(path) : null;
  let saved = snapshots.get(path);
  if (!saved || saved.size !== (info?.size ?? 0) || saved.mtime !== (info?.mtimeMs ?? 0)) {
    const reviews = new Map<string, CompletedReview>();
    for (const row of readCompletedReviews(path).sort((a,b) => Date.parse(a.reviewedAt)-Date.parse(b.reviewedAt))) {
      for (const key of row.keys) if (!reviews.has(key)) reviews.set(key,row);
    }
    saved = { size: info?.size ?? 0, mtime: info?.mtimeMs ?? 0, reviews };
    snapshots.set(path,saved);
  }
  return { path, saved };
}

export function completedReview(job: JobListing): CompletedReview | undefined {
  const {saved} = snapshot();
  return completedReviewKeys(job).map(key => saved.reviews.get(key)).find(Boolean);
}

export function rememberCompletedReview(job: JobListing, assessment: SavedFitAssessment): void {
  const {path,saved} = snapshot(), keys = completedReviewKeys(job);
  if (keys.some(key => saved.reviews.has(key))) return;
  const {reviewReused: _, ...fit} = assessment;
  const row: CompletedReview = {key:keys[0],keys,jobId:job.id,platform:job.platform ?? 'seek',
    title:job.title,company:job.company,reviewedAt:new Date().toISOString(),assessment:fit};
  // An unresolved employer check, duplicate check or failed response is not a completed fit review.
  if (!validCompletedReview(row)) return;
  mkdirSync(config.dataDir,{recursive:true});
  // A prior crash can leave a partial final line; keep the new record separate.
  appendFileSync(path,'\n'+JSON.stringify(row)+'\n',{mode:0o600});
  const info=statSync(path);saved.size=info.size;saved.mtime=info.mtimeMs;
  for (const key of keys) saved.reviews.set(key,row);
}

const inFlight = new Map<string,Promise<SavedFitAssessment>>();
export async function reuseCompletedReview(job: JobListing, compute: () => Promise<SavedFitAssessment>): Promise<SavedFitAssessment> {
  const prior = completedReview(job);
  if (prior) return {...prior.assessment,reviewReused:true};
  const keys=completedReviewKeys(job).map(key=>JSON.stringify([resolve(config.dataDir),key]));
  const pending=keys.map(key=>inFlight.get(key)).find(Boolean);
  if (pending) return {...await pending,reviewReused:true};
  const task=(async()=>{const fit=await compute();rememberCompletedReview(job,fit);return fit;})();
  for(const key of keys)inFlight.set(key,task);
  try{return await task;}finally{for(const key of keys)if(inFlight.get(key)===task)inFlight.delete(key);}
}
