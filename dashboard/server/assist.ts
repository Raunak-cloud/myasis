import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureUserDataDir } from './userdata.js';
import { loadProfile } from './profile.js';
import { fullContext } from './files.js';
import type { CandidateProfile } from './candidate-profile.js';

/**
 * Backend for the browser extension.
 *
 * The extension sends the fields it found on the page; this returns answers.
 * It never touches the user's SEEK session — the extension is already running
 * inside it — so there is nothing here to store, leak, or get flagged for.
 *
 * Both the review queue and the profile/knowledge grounding used to come from
 * the single shared `seek-bot/data/` folder and `seek-bot/.env` regardless of
 * who was signed in. The queue now lives in that account's own directory
 * (there is no `queue_items` table — see `userdata.ts` for why that is fine);
 * the profile and knowledge context now come from this account's Postgres
 * rows, never from seek-bot's own process-wide `config`/`loadProfile()`
 * singleton (which this module runs alongside, in the same long-lived
 * dashboard process, and which is only ever correct for ONE account for the
 * life of that process).
 */

export interface QueueItem {
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  applyUrl: string;
  salary?: string;
  workArrangement?: string;
  ageDays?: number;
  score: number;
  scoreReasons: string[];
  fitReason: string;
  coverLetter: string;
  status: 'pending' | 'applied' | 'skipped';
  addedAt: string;
  decidedAt?: string;
  skipReason?: string;
}

function queuePath(userId: string): string {
  return resolve(ensureUserDataDir(userId), 'queue.json');
}

export function loadQueue(userId: string): QueueItem[] {
  const p = queuePath(userId);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as QueueItem[];
  } catch {
    return [];
  }
}

export function saveQueue(userId: string, items: QueueItem[]) {
  writeFileSync(queuePath(userId), JSON.stringify(items, null, 2));
}

export function updateQueueItem(userId: string, jobId: string, patch: Partial<QueueItem>): QueueItem[] {
  const items = loadQueue(userId).map((i) =>
    i.jobId === jobId ? { ...i, ...patch, decidedAt: patch.status ? new Date().toISOString() : i.decidedAt } : i,
  );
  saveQueue(userId, items);
  return items;
}

/** Loads the bot's compiled modules so answering reuses one implementation. */
async function bot() {
  const url = (f: string) => new URL(`../../seek-bot/dist/${f}`, import.meta.url).href;
  const [gemini, cfg] = await Promise.all([
    import(/* @vite-ignore */ url('gemini.js')),
    import(/* @vite-ignore */ url('config.js')),
  ]);
  return { gemini, cfg };
}

/**
 * Maps the dashboard's own `CandidateProfile` (Postgres `profiles` row) onto
 * the shape seek-bot's `answerFields`/`writeCoverLetter` expect. A few of
 * seek-bot's fields (excluded stacks, security clearance) are not collected
 * anywhere in the dashboard's profile form — those stay generic, per-account
 * defaults rather than pulling from the single shared `.env` (which would
 * reintroduce exactly the cross-account leak this module exists to remove).
 */
function toBotProfile(p: CandidateProfile) {
  return {
    name: p.fullName || 'Unknown',
    nationality: p.workRights || 'Not stated',
    driving: p.hasDriverLicence ? 'Yes' : undefined,
    phone: p.phone,
    email: p.email,
    suburb: p.suburb,
    state: p.state,
    postcode: p.postcode,
    linkedin: p.linkedin || undefined,
    github: p.portfolio || undefined,
    qualification: p.highestQualification || undefined,
    expectedSalary: p.expectedSalary || 'Negotiable',
    noticePeriod: p.noticePeriod || '2 weeks',
    willingToRelocate: p.willingToRelocate,
    willingToTravel: p.willingToTravel || undefined,
    pronouns: p.pronouns || undefined,
    gender: p.gender || undefined,
    disability: p.disability || undefined,
    referralSource: p.referralSource || 'Not stated',
    experienceSummary: p.experienceSummary || 'Not provided.',
    skills: p.skills.split(',').map((s) => s.trim()).filter(Boolean),
    excludedDomains: [] as string[],
    securityClearance: 'None held',
  };
}

export interface AssistField {
  ref: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox';
  required: boolean;
  options?: string[];
  currentValue?: string;
}

/**
 * Answers a form the extension scraped.
 *
 * Anything the model cannot ground in the profile or the user's own documents
 * comes back `grounded: false`. The extension leaves those blank and flags them
 * rather than filling a guess into a real employer's form.
 */
export async function answerForm(
  userId: string,
  input: {
    jobId?: string;
    title?: string;
    company?: string;
    description?: string;
    fields: AssistField[];
  },
): Promise<{
  ok: boolean;
  answers?: Array<{ ref: string; value: string; grounded: boolean; rationale?: string }>;
  coverLetter?: string;
  injectionSuspected?: boolean;
  error?: string;
}> {
  try {
    const { gemini, cfg } = await bot();
    if (!cfg.config.gemini.apiKey) return { ok: false, error: 'The matching service is not configured.' };
    const profile = toBotProfile(await loadProfile(userId));

    // Prefer the queue's own record — richer than what the page exposes.
    const queued = input.jobId ? loadQueue(userId).find((q) => q.jobId === input.jobId) : undefined;
    const job = {
      id: input.jobId ?? 'unknown',
      title: input.title ?? queued?.title ?? 'Role',
      company: input.company ?? queued?.company ?? 'the company',
      location: queued?.location ?? '',
      url: queued?.url ?? '',
      description: input.description ?? queued?.fitReason ?? '',
    };

    const context = await fullContext(userId);
    const knowledge = context.ok ? (context.text ?? '') : '';

    const wantsLetter = input.fields.some((f) => /cover letter/i.test(f.label));
    const [answered, letter] = await Promise.all([
      input.fields.length
        ? gemini.answerFields(input.fields, job, profile, knowledge)
        : Promise.resolve({ answers: [], injectionSuspected: false }),
      queued?.coverLetter
        ? Promise.resolve(queued.coverLetter)
        : wantsLetter
          ? gemini.writeCoverLetter(job, profile, knowledge)
          : Promise.resolve(undefined),
    ]);

    return {
      ok: true,
      answers: answered.answers,
      coverLetter: letter,
      injectionSuspected: answered.injectionSuspected,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
