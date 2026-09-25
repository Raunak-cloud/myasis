import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, basename, dirname, extname } from 'node:path';
import { promisify } from 'node:util';
import type { Page } from 'patchright';
import { config } from './config.js';
import { extractText } from './knowledge.js';
import { relevantEvidence } from './pipeline.js';
import { chooseResume } from './llm.js';
import type { CandidateProfile, JobListing } from './types.js';

export interface ResumeRecord {
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
 * The résumé in a format this upload accepts.
 *
 * Employer forms restrict uploads ("PDF only" is common) while candidates
 * keep whatever they wrote in. The same document is converted once, with
 * LibreOffice so the layout survives, and kept beside the original for every
 * later form. Null when no accepted format can be produced.
 */
export async function resumeFileFor(file: string, accept: string): Promise<string | null> {
  const ext = extname(file).toLowerCase();
  if (acceptsFormat(accept, ext)) return file;
  const target = ['.pdf', '.docx', '.doc', '.rtf', '.txt'].find((candidate) => candidate !== ext && acceptsFormat(accept, candidate));
  if (!target) return null;
  const converted = resolve(dirname(file), `${basename(file, extname(file))}${target}`);
  if (existsSync(converted)) return converted;
  const profile = resolve(tmpdir(), `owtomate-lo-${process.getuid?.() ?? 'user'}`);
  const run = promisify(execFile);
  await run('soffice', [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', target.slice(1), '--outdir', dirname(file), file], { timeout: 90_000 })
    .catch((error) => console.warn(`  ! could not convert the résumé to ${target}: ${(error as Error).message.split('\n')[0]}`));
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

const clean = (s: string) => s.replace(/[​-‍⁠﻿ ]/g, '').trim();

/** Normalises for comparison: "Raunak_New_Resume (1).docx" ≈ "raunak new resume 1" */
function normaliseName(s: string): string {
  return clean(s)
    .toLowerCase()
    .replace(/\.(docx?|pdf|rtf|txt)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * SEEK's Braid radios are custom components: the real `<input>` is
 * `tabindex="-1"` and visually hidden, and state lives in `aria-checked` driven
 * by React. Patchright's `.check()` clicks it but then blocks waiting for
 * `checked` to flip, which never happens — so drive the label instead, the way
 * a person would, and verify via `aria-checked`.
 */
async function checkRadio(radio: import('patchright').Locator): Promise<void> {
  const page = radio.page();
  const id = await radio.getAttribute('id').catch(() => null);

  if (id) {
    const label = page.locator(`label[for="${id}"]`).first();
    if (await label.count()) {
      await label.click({ timeout: 8_000 }).catch(() => {});
    }
  }

  const settled = await radio
    .evaluate(
      (el) =>
        (el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true',
    )
    .catch(() => false);
  if (settled) return;

  // Fall back to a direct click, then a synthetic event as a last resort.
  await radio.click({ force: true, timeout: 5_000 }).catch(() => {});
  const after = await radio
    .evaluate(
      (el) =>
        (el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true',
    )
    .catch(() => false);
  if (after) return;

  await radio
    .evaluate((el) => {
      (el as HTMLInputElement).click();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })
    .catch(() => {});
}

export type ResumeOutcome =
  | { status: 'selected'; name: string }
  | { status: 'uploaded'; name: string }
  | { status: 'kept-default'; name: string }
  | {
      status: 'unavailable';
      wanted: string;
      available: string[];
      reason: 'upload-disabled' | 'local-file-missing' | 'upload-control-missing' | 'upload-failed';
    };

export interface FileInputDescription {
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

type FileLocator = ReturnType<Page['locator']>;

async function describeFileInput(input: FileLocator): Promise<FileInputDescription> {
  return input.evaluate((el) => {
    const file = el as HTMLInputElement;
    const id = file.id;
    const explicitLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '' : '';
    const labelledBy = (file.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((ref) => document.getElementById(ref)?.textContent ?? '')
      .join(' ');
    let context = '';
    let ancestor: HTMLElement | null = file.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parentElement) {
      const text = ancestor.innerText?.trim() ?? '';
      if (text.length > context.length && text.length < 600) context = text;
    }
    return {
      accept: file.accept ?? '',
      identity: [file.name, file.id, file.getAttribute('aria-label'), explicitLabel, labelledBy].filter(Boolean).join(' '),
      context,
    };
  }).catch(() => ({ accept: '', identity: '', context: '' }));
}

async function resumeFileInput(page: Page): Promise<ReturnType<Page['locator']> | null> {
  const inputs = page.locator('input[type=file]');
  const count = await inputs.count().catch(() => 0);
  const descriptions: FileInputDescription[] = [];
  for (let index = 0; index < count; index++) {
    descriptions.push(await describeFileInput(inputs.nth(index)));
  }
  const index = resumeFileInputIndex(descriptions);
  return index >= 0 ? inputs.nth(index) : null;
}

/** Uses the model's observed ref only when deterministic discovery found nothing. */
async function modelChosenResumeInput(page: Page, ref?: string): Promise<FileLocator | null> {
  if (!ref) return null;
  const input = page.locator(`[data-ref-id="${ref}"]`).first();
  if (await input.count().catch(() => 0) < 1) return null;
  const type = await input.getAttribute('type').catch(() => null);
  if (type?.toLowerCase() !== 'file') return null;
  const description = await describeFileInput(input);
  return resumeFileInputIndex([description]) === 0 ? input : null;
}

/** A document choice on a board's résumé step, whatever the board calls it. */
interface DocumentChoice {
  idx: number;
  label: string;
  checked: boolean;
}

const FILE_LIKE = /\.(docx?|pdf|rtf|txt)\b|uploaded/i;

/**
 * Every radio on the page that stands for a document. SEEK names its group
 * `document-select`; Indeed's list is unnamed but each label is a file
 * name with an upload date. Any radio whose label reads like a file is one.
 */
async function documentChoices(page: Page): Promise<{ radios: ReturnType<Page['locator']>; choices: DocumentChoice[] }> {
  const radios = page.locator('input[type=radio]');
  const count = await radios.count().catch(() => 0);
  const choices: DocumentChoice[] = [];
  for (let i = 0; i < count; i++) {
    const info = await radios
      .nth(i)
      .evaluate((el) => {
        const input = el as HTMLInputElement;
        const wrap = input.closest('label');
        const id = input.getAttribute('id');
        const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const described = (input.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((ref) => document.getElementById(ref)?.textContent ?? '')
          .join(' ');
        return {
          label: wrap?.textContent || byFor?.textContent || described || input.getAttribute('aria-label') || '',
          group: input.name,
          checked: input.checked || input.getAttribute('aria-checked') === 'true',
        };
      })
      .catch(() => null);
    if (!info) continue;
    const label = clean(info.label);
    if (info.group !== 'document-select' && !FILE_LIKE.test(label)) continue;
    choices.push({ idx: i, label, checked: info.checked });
  }
  return { radios, choices };
}

/** The choice whose label names this résumé, ignoring extension, spacing and an upload date after it. */
function matchChoice(choices: DocumentChoice[], wanted: ResumeRecord): DocumentChoice | undefined {
  const target = normaliseName(wanted.seekName ?? wanted.fileName);
  if (!target) return undefined;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The name, then either the end or a word that is not a bare number ("resume 2" is a different file).
  const pattern = new RegExp(`^${escaped}(?: (?!\\d+\\b)|$)`);
  return choices.find((choice) => pattern.test(normaliseName(choice.label)));
}

/**
 * Chooses which résumé this application should use, on any board or site.
 *
 * Preference order matters. Selecting a document already on the account
 * changes nothing about the profile, so it is always tried first. Uploading
 * adds a document to the account — a profile modification — so it happens
 * only when the run allows it. When the résumé chosen for this job is not on
 * the board and can be uploaded, it is, and then selected; only when there is
 * nowhere to upload does the step fall back to what the board already holds,
 * and says so.
 */
export async function selectResume(
  page: Page,
  wanted: ResumeRecord | null,
  allowUpload: boolean,
  modelSelectedRef?: string,
): Promise<ResumeOutcome> {
  const { radios, choices } = await documentChoices(page);
  const realDocs = choices.filter((o) => !/don't include|do not include/i.test(o.label));
  const fileInput = await resumeFileInput(page) ?? await modelChosenResumeInput(page, modelSelectedRef);
  const canUpload = fileInput !== null;

  if (!realDocs.length && !canUpload) return { status: 'kept-default', name: '(no document step)' };

  if (!wanted) {
    const current = realDocs.find((o) => o.checked) ?? realDocs[0];
    return { status: 'kept-default', name: current?.label ?? 'unknown' };
  }

  // 1. Already on the account? Choose it.
  const match = matchChoice(realDocs, wanted);
  if (match) {
    if (!match.checked) await checkRadio(radios.nth(match.idx));
    return { status: 'selected', name: match.label };
  }

  // 2. Not there — upload only with permission, and only where there is somewhere to upload to.
  const localPath = resolve(RESUME_DIR, wanted.fileName);
  const available = realDocs.map((o) => o.label);
  if (!allowUpload) return { status: 'unavailable', wanted: wanted.label, available, reason: 'upload-disabled' };
  if (!existsSync(localPath)) return { status: 'unavailable', wanted: wanted.label, available, reason: 'local-file-missing' };
  if (!canUpload) return { status: 'unavailable', wanted: wanted.label, available, reason: 'upload-control-missing' };

  await fileInput!.setInputFiles(localPath);

  // The board re-renders its list once the upload finishes; the new file appears by name (extension may change).
  const stem = basename(wanted.fileName).replace(/\.(docx?|pdf|rtf|txt)$/i, '');
  await page
    .locator(`text=${stem}`)
    .first()
    .waitFor({ state: 'visible', timeout: 25_000 })
    .catch(() => {});

  /**
   * SEEK's upload opens a dialog into `#braid-modal-container`, which swallows
   * pointer events for the whole page. Left open, the next click on the step's
   * Continue button is intercepted until it times out. Wait for it to clear on
   * its own, then press Escape if it lingers.
   */
  const modalContent = page.locator('#braid-modal-container > *').first();
  if (await modalContent.count().catch(() => 0)) {
    const settled = await modalContent
      .waitFor({ state: 'hidden', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!settled) {
      await page.keyboard.press('Escape').catch(() => {});
      await modalContent.waitFor({ state: 'hidden', timeout: 4_000 }).catch(() => {});
    }
  }

  // Select the uploaded document when the list now offers it; a list that replaced its only entry has it chosen already.
  const after = await documentChoices(page);
  const afterDocs = after.choices.filter((o) => !/don't include|do not include/i.test(o.label));
  const beforeNames = new Set(realDocs.map((doc) => normaliseName(doc.label)));
  const retainedFile = await fileInput!.inputValue().catch(() => '');
  const uploaded = matchChoice(afterDocs, wanted)
    ?? afterDocs.find((doc) => !beforeNames.has(normaliseName(doc.label)))
    ?? (afterDocs.length === 1 ? afterDocs[0] : undefined);
  if (!uploaded) {
    // External ATS forms retain the chosen file directly instead of adding a
    // document radio like SEEK does. A non-empty native value is the browser's
    // deterministic confirmation that setInputFiles stuck.
    if (retainedFile) return { status: 'uploaded', name: retainedFile.replace(/^.*[\\/]/, '') || wanted.fileName };
    return { status: 'unavailable', wanted: wanted.label, available, reason: 'upload-failed' };
  }
  if (!uploaded.checked) await checkRadio(after.radios.nth(uploaded.idx));
  return { status: 'uploaded', name: uploaded.label };
}

const resumeChoices = new Map<string, Promise<ResumeRecord | null>>();
export function pickResumeForJob(job: JobListing, profile: CandidateProfile): Promise<ResumeRecord | null> {
  const key = JSON.stringify([config.dataDir, job, profile, config.resume.select, loadResumes()]);
  let pending = resumeChoices.get(key);
  if (!pending) { pending = pickResumeUncached(job, profile); resumeChoices.set(key, pending); }
  return pending;
}
