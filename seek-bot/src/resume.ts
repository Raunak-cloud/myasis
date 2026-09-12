import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
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
      reason: 'upload-disabled' | 'local-file-missing' | 'upload-control-missing';
    };

/**
 * Chooses which résumé this application should use.
 *
 * Preference order matters. Selecting an existing SEEK document changes
 * nothing about the profile, so it is always tried first. Uploading adds a new
 * document to the user's SEEK account — a profile modification — so it only
 * happens when explicitly allowed.
 */
export async function selectResume(
  page: Page,
  wanted: ResumeRecord | null,
  allowUpload: boolean,
): Promise<ResumeOutcome> {
  const radios = page.locator('input[type=radio][name="document-select"]');
  const count = await radios.count();
  if (count === 0) return { status: 'kept-default', name: '(no document step)' };

  const options: Array<{ idx: number; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const label = clean(
      await radios
        .nth(i)
        .evaluate((el) => {
          const wrap = (el as HTMLElement).closest('label');
          if (wrap?.textContent) return wrap.textContent;
          const id = el.getAttribute('id');
          const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          return byFor?.textContent ?? '';
        })
        .catch(() => ''),
    );
    options.push({ idx: i, label });
  }

  const realDocs = options.filter((o) => !/don't include|do not include/i.test(o.label));

  if (!wanted) {
    const current = realDocs.find(async (_o) => true);
    return { status: 'kept-default', name: current?.label ?? realDocs[0]?.label ?? 'unknown' };
  }

  // 1. Already on SEEK? Just tick it.
  const target = normaliseName(wanted.seekName ?? wanted.fileName);
  const match = realDocs.find((o) => normaliseName(o.label) === target);
  if (match) {
    await checkRadio(radios.nth(match.idx));
    return { status: 'selected', name: match.label };
  }

  // 2. Not there — upload only with permission.
  const localPath = resolve(RESUME_DIR, wanted.fileName);
  if (!allowUpload) {
    return {
      status: 'unavailable',
      wanted: wanted.label,
      available: realDocs.map((o) => o.label),
      reason: 'upload-disabled',
    };
  }
  if (!existsSync(localPath)) {
    return {
      status: 'unavailable',
      wanted: wanted.label,
      available: realDocs.map((o) => o.label),
      reason: 'local-file-missing',
    };
  }

  const fileInput = page
    .locator('input[type=file][accept*="docx"], input[type=file][accept*="pdf"]')
    .first();
  if (!(await fileInput.count())) {
    return {
      status: 'unavailable',
      wanted: wanted.label,
      available: realDocs.map((o) => o.label),
      reason: 'upload-control-missing',
    };
  }

  await fileInput.setInputFiles(localPath);

  // SEEK re-renders the radio list once the upload finishes.
  await page
    .locator(`text=${basename(wanted.fileName)}`)
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => {});

  /**
   * The upload also opens a dialog into `#braid-modal-container`, which
   * swallows pointer events for the whole page. Left open, the next click on
   * the step's Continue button is intercepted until it times out. Wait for it
   * to clear on its own, then press Escape if it lingers.
   */
  const modalContent = page.locator('#braid-modal-container > *').first();
  const settled = await modalContent
    .waitFor({ state: 'hidden', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!settled) {
    await page.keyboard.press('Escape').catch(() => {});
    await modalContent.waitFor({ state: 'hidden', timeout: 4_000 }).catch(() => {});
  }
  return { status: 'uploaded', name: wanted.fileName };
}

const resumeChoices = new Map<string, Promise<ResumeRecord | null>>();
export function pickResumeForJob(job: JobListing, profile: CandidateProfile): Promise<ResumeRecord | null> {
  const key = JSON.stringify([config.dataDir, job, profile, config.resume.select, loadResumes()]);
  let pending = resumeChoices.get(key);
  if (!pending) { pending = pickResumeUncached(job, profile); resumeChoices.set(key, pending); }
  return pending;
}
