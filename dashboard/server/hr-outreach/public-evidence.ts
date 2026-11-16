import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applicationUrlKey } from '../../../seek-bot/src/application-identity.js';
import { crawlUrl } from '../job-index/network.js';
import { userDir } from '../userdata.js';
import type { HrJob } from './store.js';

export interface PublicVacancyEvidence {
  description: string;
  location?: string;
  sourceUrl: string;
  observedAt: string;
  sourceKind: 'stored_vacancy';
}
type EvidenceJob = Pick<HrJob, 'user_id' | 'job_id' | 'platform' | 'company' | 'title' | 'url' | 'source_run_id' | 'applied_at' | 'location'>;
interface EvidenceOptions { directory?: string; now?: () => Date }
const MAX_DESCRIPTION = 120_000;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_LINES = 100_000;
const ID = /^[1-9]\d{0,18}$/;
const normal = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

function listingUrl(raw: unknown, platform: string): { key: string; source: string } | null {
  if (typeof raw !== 'string' || raw.length > 10_000) return null;
  try {
    const url = crawlUrl(raw);
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (platform === 'seek' && /(?:^|\.)(?:seek\.com\.au|seek\.com)$/.test(host)) {
      const id = /^\/job\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
      if (!id) return null;
      return { key: `seek:${id}`, source: `https://www.seek.com.au/job/${id}` };
    }
    if (platform === 'indeed' && /(?:^|\.)(?:indeed\.com|indeed\.com\.au)$/.test(host)) {
      const id = url.searchParams.get('jk') ?? url.searchParams.get('vjk');
      if (!id || !/^[a-f0-9]{16}$/i.test(id)) return null;
      return { key: `indeed:${id.toLowerCase()}`, source: `https://au.indeed.com/viewjob?jk=${id.toLowerCase()}` };
    }
    const canonical = applicationUrlKey(raw);
    return canonical ? { key: canonical, source: canonical } : null;
  } catch { return null; }
}

function previousMonth(now: Date): number {
  const result = new Date(now), day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.getTime();
}

/** Read only a bounded tail; never accumulate an unbounded JSONL line. */
async function scanFile(path: string, accept: (row: unknown) => void): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size) return;
    const start = Math.max(0, stat.size - MAX_SCAN_BYTES);
    const stream = handle.createReadStream({ start, end: stat.size - 1, autoClose: false, highWaterMark: 64 * 1024 });
    let pending = Buffer.alloc(0), discard = start > 0, oversized = false, lines = 0;
    const deadline = performance.now() + 2_000;
    const consume = (segment: Buffer, ended: boolean) => {
      if (!discard && !oversized) {
        if (pending.length + segment.length > MAX_LINE_BYTES) { pending = Buffer.alloc(0); oversized = true; }
        else pending = pending.length ? Buffer.concat([pending, segment]) : Buffer.from(segment);
      }
      if (!ended) return;
      if (++lines > MAX_LINES || performance.now() > deadline) throw Error('Public snapshot scan limit.');
      if (!discard && !oversized && pending.length) {
        try { accept(JSON.parse(pending.toString('utf8'))); } catch { /* A partial/malformed record is not evidence. */ }
      }
      pending = Buffer.alloc(0); discard = false; oversized = false;
    };
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        let offset = 0, newline;
        while ((newline = chunk.indexOf(10, offset)) >= 0) { consume(chunk.subarray(offset, newline), true); offset = newline + 1; }
        if (offset < chunk.length) consume(chunk.subarray(offset), false);
      }
      if (pending.length || oversized || discard) consume(Buffer.alloc(0), true);
    } finally { stream.destroy(); }
  } finally { await handle?.close(); }
}

/** A previously read public listing is context, not a fresh page check or send
 * permission. Private candidate fields are never projected from the journal. */
export async function loadPublicVacancyEvidence(job: EvidenceJob, options: EvidenceOptions = {}): Promise<PublicVacancyEvidence | null> {
  // Validate before resolving or opening anything in an account directory.
  if (typeof job?.user_id !== 'string' || !ID.test(job.user_id) || typeof job.source_run_id !== 'string' || !ID.test(job.source_run_id)) return null;
  if (![job.job_id, job.platform, job.company, job.title, job.url].every(value => typeof value === 'string' && value.trim() && value.length <= 10_000)) return null;
  const identity = listingUrl(job.url, job.platform);
  if (!identity) return null;
  if ((identity.key.startsWith('seek:') || identity.key.startsWith('indeed:')) && identity.key !== `${job.platform}:${job.job_id.toLowerCase()}`) return null;
  try {
    const now = (options.now ?? (() => new Date()))(), nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) return null;
    const oldest = previousMonth(now), appliedAt = job.applied_at instanceof Date ? job.applied_at.getTime() : Date.parse(job.applied_at ?? '');
    const directory = options.directory ?? userDir(job.user_id);
    for (const [file, current] of [['run-log.jsonl', true], ['application-outcomes.jsonl', false]] as const) {
      let latest: PublicVacancyEvidence | null = null, latestAt = -Infinity;
      const accept = (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        const row = value as Record<string, any>, snapshot = row.technicalAttempt?.job;
        if (row.status !== 'applied' || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
        if ([row.user_id, row.userId, row.technicalAttempt?.user_id, row.technicalAttempt?.userId, snapshot.user_id, snapshot.userId]
          .some(owner => owner !== undefined && String(owner) !== job.user_id)) return;
        if (snapshot.id !== job.job_id || snapshot.platform !== job.platform || row.jobId !== job.job_id
          || typeof snapshot.company !== 'string' || normal(snapshot.company) !== normal(job.company)
          || typeof snapshot.title !== 'string' || normal(snapshot.title) !== normal(job.title)) return;
        const source = listingUrl(snapshot.url, job.platform);
        if (!source || source.key !== identity.key || typeof row.ts !== 'string') return;
        const at = Date.parse(row.ts);
        if (!Number.isFinite(at) || at < oldest || at > nowMs || at <= latestAt) return;
        const runId = row.technicalAttempt?.runId;
        if (current ? String(runId) !== job.source_run_id : runId !== undefined && String(runId) !== job.source_run_id) return;
        if (!current && runId === undefined && (!Number.isFinite(appliedAt) || appliedAt > nowMs || at < appliedAt - 24 * 60 * 60_000 || at > appliedAt + 5 * 60_000)) return;
        if (typeof snapshot.description !== 'string') return;
        const description = snapshot.description.slice(0, MAX_DESCRIPTION).trim();
        if (!description) return;
        latest = { description, ...(typeof snapshot.location === 'string' && snapshot.location.trim() ? { location: snapshot.location.slice(0, 2_000).trim() } : {}),
          sourceUrl: source.source, observedAt: new Date(at).toISOString(), sourceKind: 'stored_vacancy' };
        latestAt = at;
      };
      try { await scanFile(resolve(directory, file), accept); }
      catch { latest = null; }
      if (latest) return latest;
    }
    return null;
  } catch { return null; }
}
