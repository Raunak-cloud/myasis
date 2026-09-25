import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, basename, dirname, extname } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { extractText } from './knowledge.js';
import { relevantEvidence } from './pipeline.js';
import { chooseResume } from './llm.js';
import type { CandidateProfile, JobListing } from './types.js';

interface ResumeRecord {
  id: string;
  label: string;
  /** File name as stored on disk, inside data/resumes/. */
  fileName: string;
  /** Name it appears as in SEEK's document list, once uploaded there. */
  seekName?: string;
  uploadedAt: string;
  size: number;
  notes?: string;
  isDefault?: boolean;
}

const MANIFEST = resolve(config.dataDir, 'resumes.json');
export const RESUME_DIR = resolve(config.dataDir, 'resumes');

export function loadResumes(): ResumeRecord[] {
  if (!existsSync(MANIFEST)) return [];
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8')) as ResumeRecord[];
  } catch {
    return [];
  }
}

/** Document formats a résumé can be sent as, with the MIME types an `accept` may name instead. */
const RESUME_FORMATS: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.doc': ['application/msword'],
  '.rtf': ['application/rtf', 'text/rtf'],
  '.txt': ['text/plain'],
};

/** Whether a file input's `accept` attribute allows this extension; empty means anything. */
export function acceptsFormat(accept: string, ext: string): boolean {
  const tokens = accept.toLowerCase().split(',').map((token) => token.trim()).filter(Boolean);
  if (!tokens.length || tokens.includes('*') || tokens.includes('*/*')) return true;
  const mimes = RESUME_FORMATS[ext] ?? [];
  return tokens.some((token) => token === ext || mimes.includes(token) || mimes.some((mime) => token.endsWith('/*') && mime.startsWith(token.slice(0, -1))));
}

/**
 * A document (résumé, cover letter) in a format this upload accepts.
 *
 * Employer forms restrict uploads ("PDF only" is common) while candidates
 * keep whatever they wrote in. The same document is converted once, with
 * LibreOffice so the layout survives, and kept beside the original for every
 * later form. Null when no accepted format can be produced.
 */
export async function documentFor(file: string, accept: string): Promise<string | null> {
  const ext = extname(file).toLowerCase();
  if (acceptsFormat(accept, ext)) return file;
  const target = ['.pdf', '.docx', '.doc', '.rtf', '.txt'].find((candidate) => candidate !== ext && acceptsFormat(accept, candidate));
  if (!target) return null;
  const converted = resolve(dirname(file), `${basename(file, extname(file))}${target}`);
  if (existsSync(converted)) return converted;
  const profile = resolve(tmpdir(), `owtomate-lo-${process.getuid?.() ?? 'user'}`);
  const run = promisify(execFile);
  await run('soffice', [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', target.slice(1), '--outdir', dirname(file), file], { timeout: 90_000 })
    .catch((error) => console.warn(`  ! could not convert the document to ${target}: ${(error as Error).message.split('\n')[0]}`));
  return existsSync(converted) ? converted : null;
}

export function resolveResume(idOrLabel?: string): ResumeRecord | null {
  const all = loadResumes();
  if (!all.length) return null;
  if (!idOrLabel) return all.find((r) => r.isDefault) ?? null;
  const needle = idOrLabel.toLowerCase();
  return (
    all.find((r) => r.id.toLowerCase() === needle) ??
    all.find((r) => r.label.toLowerCase() === needle) ??
    all.find((r) => r.fileName.toLowerCase() === needle) ??
    null
  );
}

/**
 * Chooses which résumé a specific job application should use.
 *
 * An explicit run-level override (`config.resume.select`) always wins — a
 * deliberate manual choice is never second-guessed. With zero or one résumé
 * on file there is nothing to choose between either. Only with more than one
 * does this ask the model to pick, based on each résumé's own label/notes —
 * never on the job's fit for the candidate, which is decided separately.
 * Falls back to the default résumé on any failure or an unrecognised answer,
 * so a flaky model call can never block an application outright.
 */
async function pickResumeUncached(
  job: JobListing,
  profile: CandidateProfile,
): Promise<ResumeRecord | null> {
  if (config.resume.select) return resolveResume(config.resume.select);

  const all = loadResumes();
  if (all.length <= 1 || !config.celeris.apiKey) return resolveResume();

  try {
    const { resumeId, reason } = await chooseResume(
      job,
      profile,
      await Promise.all(all.map(async r => ({ id: r.id, label: r.label, notes: r.notes, evidence: relevantEvidence(await extractText(resolve(RESUME_DIR, r.fileName)).catch(() => ''), job.title + ' ' + (job.description ?? ''), 6000) }))),
    );
    const chosen = all.find((r) => r.id === resumeId);
    if (chosen) {
      console.log(`  🎯 résumé: "${chosen.label}" — ${reason}`);
      return chosen;
    }
    console.warn(`  ! résumé choice "${resumeId}" matched none on file — using the default`);
  } catch (error) {
    console.warn(`  ! could not choose a résumé automatically: ${(error as Error).message} — using the default`);
  }
  return resolveResume();
}

interface FileInputDescription {
  accept: string;
  identity: string;
  context: string;
}

/**
 * Picks a résumé/document uploader without confusing it with a profile-photo
 * control elsewhere on the application page. SEEK currently renders both as
 * hidden file inputs; choosing the first one opens its photo editor and leaves
 * the résumé step untouched.
 */
export function resumeFileInputIndex(inputs: FileInputDescription[]): number {
  let best = { index: -1, score: Number.NEGATIVE_INFINITY };
  inputs.forEach((input, index) => {
    const accept = input.accept.toLowerCase();
    const text = `${input.identity} ${input.context}`.toLowerCase();
    let score = 0;
    if (/\.pdf|\.doc|\.docx|\.rtf|\.txt|application\/pdf|msword|officedocument|text\/plain/.test(accept)) score += 120;
    if (/image\/|\.jpe?g|\.png|\.gif|\.webp|\.heic/.test(accept)) score -= 200;
    if (/\b(resume|résumé|cv|curriculum vitae|document)\b/.test(text)) score += 60;
    if (/profile photo|profile picture|headshot|avatar/.test(text)) score -= 120;
    if (/accepted file types[^\n]{0,100}(?:\.doc|\.pdf)|attach|upload/.test(text)) score += 10;
    if (score > best.score) best = { index, score };
  });
  // A single unlabelled, non-image input is normal on external ATS forms.
  if (best.index >= 0 && (best.score > 0 || (inputs.length === 1 && best.score >= 0))) return best.index;
  return -1;
}

const resumeChoices = new Map<string, Promise<ResumeRecord | null>>();
export function pickResumeForJob(job: JobListing, profile: CandidateProfile): Promise<ResumeRecord | null> {
  const key = JSON.stringify([config.dataDir, job, profile, config.resume.select, loadResumes()]);
  let pending = resumeChoices.get(key);
  if (!pending) { pending = pickResumeUncached(job, profile); resumeChoices.set(key, pending); }
  return pending;
}
