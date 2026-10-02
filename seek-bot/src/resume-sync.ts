import type { Frame, Page } from 'patchright';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { config } from './config.js';
import { documentFor, loadResumes, RESUME_DIR, resumeFileInputIndex } from './resume.js';

/**
 * The candidate's résumés in Owtomate are the one source of truth for what a
 * job board sends.
 *
 * SEEK and Indeed keep their own saved résumés and preselect one on every
 * application. The agent used to accept whatever was preselected, so an
 * employer could receive an old SEEK résumé while the answers and the cover
 * letter were written from the current one in Owtomate: over 199 successful
 * applications, every SEEK and Indeed one went out with the board's copy.
 *
 * Before an application leaves its documents step on either board, the
 * résumé Owtomate chose for the job is the one selected there:
 *  - already selected: kept;
 *  - saved on the board but not selected: selected;
 *  - not on the board, or the board's copy is older than Owtomate's file:
 *    uploaded from Owtomate and selected.
 * Which board file holds which Owtomate résumé is remembered by content
 * hash, so a replaced file is uploaded again rather than matched by name.
 * Résumés on the board that Owtomate does not hold are never used; they are
 * reported so the person can bring them into Owtomate if they want them.
 */

export type Board = 'seek' | 'indeed';

export function boardOf(url: string): Board | null {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (/(^|\.)seek\.com(\.au)?$/.test(host)) return 'seek';
  if (/(^|\.)indeed\.com$/.test(host)) return 'indeed';
  return null;
}

/** A document file name as boards show it: "Raunak_New_Resume (2).docx". */
const DOCUMENT_NAME = /([^\n\\/:*?"<>|]{1,140}?\.(?:pdf|docx?|rtf|txt))(?![a-z])/i;

/** Names compared without extension, case or punctuation: "Resume (2).pdf" is "resume 2.docx". */
export const sameDocument = (a: string, b: string) => {
  const key = (name: string) => name.toLowerCase().replace(/\.(pdf|docx?|rtf|txt)$/i, '').replace(/[^a-z0-9]+/g, '');
  return key(a).length > 0 && key(a) === key(b);
};

export interface DocumentChoice {
  frame: Frame;
  /** Position among the frame's radios, for clicking it again. */
  index: number;
  name: string;
  checked: boolean;
  /** When the board says this copy was added: SEEK's "Added 20 days ago", Indeed's "September 19". */
  added?: string;
}

/**
 * When a board copy was added, as a time and how precisely the board said it.
 *
 * The board's copy cannot be read, so its name is all that identifies it,
 * and a person can upload a different file under the same name. What the
 * board does show is when each copy was added; a same-named copy added after
 * the one Owtomate recorded is a different file.
 */
export function addedAt(text: string | undefined, now = Date.now()): { at: number; tolerance: number } | null {
  if (!text) return null;
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  const t = text.toLowerCase();
  if (/just now|moments? ago|today/.test(t)) return { at: now, tolerance: day };
  if (/yesterday/.test(t)) return { at: now - day, tolerance: day };
  const relative = t.match(/(?:about|over|almost|nearly)?\s*(\d+|an?|one)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (relative) {
    const count = /^(a|an|one)$/.test(relative[1]) ? 1 : Number(relative[1]);
    const unit = { minute, hour, day, week: 7 * day, month: 30 * day, year: 365 * day }[relative[2] as 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'];
    // A board rounds to its unit: "about 1 month" is anything from about three weeks to six.
    return { at: now - count * unit, tolerance: Math.max(day, unit) };
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const absolute = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  if (absolute) {
    const month = months.indexOf(absolute[1]);
    let year = absolute[3] ? Number(absolute[3]) : new Date(now).getFullYear();
    let at = Date.UTC(year, month, Number(absolute[2]));
    // Without a year, a date "in the future" is last year's.
    if (!absolute[3] && at > now + day) at = Date.UTC(year -= 1, month, Number(absolute[2]));
    return { at, tolerance: 2 * day };
  }
  return null;
}

const RADIOS = 'input[type="radio"], [role="radio"]';

/** Every radio on the page, in any frame, whose label is a document file name: a board's saved résumés. */
export async function documentChoices(page: Page): Promise<DocumentChoice[]> {
  const choices: DocumentChoice[] = [];
  for (const frame of page.frames()) {
    const found = await frame.evaluate(({ selector, pattern }) => {
      const documentName = new RegExp(pattern, 'i');
      const text = (element: Element | null | undefined) => (element as HTMLElement | null)?.innerText?.replace(/\s+/g, ' ').trim() ?? '';
      return [...document.querySelectorAll(selector)].map((element, index) => {
        const input = element as HTMLInputElement;
        const labelledBy = element.getAttribute('aria-labelledby');
        const named = element.getAttribute('aria-label')
          || (labelledBy ? labelledBy.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ') : '')
          || ('labels' in input && input.labels?.length ? text(input.labels[0]) : '')
          || text(element.closest('label'))
          || text(element.parentElement)
          || text(element.parentElement?.parentElement);
        const match = named.match(documentName);
        const checked = input.checked === true || element.getAttribute('aria-checked') === 'true';
        let block: Element = element;
        for (let up = element.parentElement, depth = 0; up && depth < 6 && up.querySelectorAll(selector).length === 1; up = up.parentElement, depth += 1) block = up;
        const added = text(block).match(/added\s+(?:just now|[^.\n]{1,40}?\bago)|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?/i)?.[0];
        return match ? { index, name: match[1].trim(), checked, ...(added ? { added } : {}) } : null;
      }).filter((choice): choice is { index: number; name: string; checked: boolean; added?: string } => Boolean(choice));
    }, { selector: RADIOS, pattern: DOCUMENT_NAME.source }).catch(() => [] as Array<{ index: number; name: string; checked: boolean; added?: string }>);
    for (const choice of found) choices.push({ frame, ...choice });
  }
  return choices;
}

/** Owtomate résumé id → the board's copy of it, and the content that copy holds. */
interface SyncEntry {
  name: string;
  sha: string;
  /** When the board said this copy was added, when Owtomate first recorded it. */
  boardAddedAt?: number;
  boardAddedTolerance?: number;
}
type SyncRecord = Partial<Record<Board, Record<string, SyncEntry>>>;
const SYNC_FILE = () => resolve(config.dataDir, 'resume-sync.json');
const BOARD_ONLY_FILE = () => resolve(config.dataDir, 'board-resumes.json');

function readJson<T>(path: string, fallback: T): T {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback; } catch { return fallback; }
}

function remember(board: Board, resumeId: string, entry: SyncEntry): void {
  const record = readJson<SyncRecord>(SYNC_FILE(), {});
  record[board] = { ...(record[board] ?? {}), [resumeId]: entry };
  writeFileSync(SYNC_FILE(), JSON.stringify(record, null, 2));
}

/** A same-named copy replaced on the board, for the dashboard to explain. */
function reportReplaced(board: Board, name: string, uploadedAs: string): void {
  const report = readJson<Record<string, unknown>>(BOARD_ONLY_FILE(), {});
  const key = `${board}Replaced`;
  const earlier = Array.isArray(report[key]) ? report[key] as Array<{ name: string }> : [];
  report[key] = [...earlier.filter((entry) => entry.name !== name), { name, uploadedAs, at: new Date().toISOString() }];
  writeFileSync(BOARD_ONLY_FILE(), JSON.stringify(report, null, 2));
}

/** Saved résumés on a board that Owtomate does not hold, for the dashboard to mention. */
function reportBoardOnly(board: Board, names: string[]): void {
  const report = readJson<Record<string, unknown>>(BOARD_ONLY_FILE(), {});
  report[board] = { names: [...new Set(names)].sort(), seenAt: new Date().toISOString() };
  writeFileSync(BOARD_ONLY_FILE(), JSON.stringify(report, null, 2));
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function select(choice: DocumentChoice): Promise<boolean> {
  const target = choice.frame.locator(RADIOS).nth(choice.index);
  await target.check({ force: true, timeout: 5_000 }).catch(() => target.click({ force: true, timeout: 5_000 }).catch(() => {}));
  return target.evaluate((element) => (element as HTMLInputElement).checked === true || element.getAttribute('aria-checked') === 'true').catch(() => false);
}

/** The board's document upload in this frame, never a profile-photo input beside it. */
async function uploadInput(frame: Frame) {
  const inputs = frame.locator('input[type="file"]');
  const described = await inputs.evaluateAll((elements) => elements.map((element) => {
    let context = element.parentElement;
    for (let depth = 0; context && depth < 4 && (context.innerText ?? '').trim().length < 20; depth += 1) context = context.parentElement;
    return {
      accept: element.getAttribute('accept') ?? '',
      identity: `${element.getAttribute('name') ?? ''} ${element.getAttribute('id') ?? ''} ${element.getAttribute('aria-label') ?? ''}`,
      context: (context?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
    };
  })).catch(() => []);
  const index = resumeFileInputIndex(described);
  return index >= 0 ? { input: inputs.nth(index), accept: described[index].accept } : null;
}

export type ResumeStepResult =
  | { action: 'none' }
  | { action: 'kept' | 'selected' | 'uploaded'; name: string; label: string; board: Board }
  | { action: 'failed'; reason: string };

/**
 * Makes the résumé Owtomate chose for this job the selected one on a board's
 * documents step. "none" when the page is not a board's résumé choice.
 */
export async function ensureChosenResume(page: Page, chosen: { id: string; label: string; fileName: string; seekName?: string }): Promise<ResumeStepResult> {
  const board = boardOf(page.url());
  if (!board) return { action: 'none' };
  const choices = await documentChoices(page);
  if (!choices.length) return { action: 'none' };

  const file = resolve(RESUME_DIR, chosen.fileName);
  if (!existsSync(file)) return { action: 'failed', reason: `Owtomate's résumé "${chosen.label}" is missing from the account's files.` };
  const sha = sha256(file);
  const record = readJson<SyncRecord>(SYNC_FILE(), {})[board]?.[chosen.id];

  // Board copies that belong to a résumé Owtomate holds; the rest are the board's own.
  const known = loadResumes().flatMap((resume) => [resume.fileName, resume.label, resume.seekName ?? '']).filter(Boolean);
  const synced = Object.values(readJson<SyncRecord>(SYNC_FILE(), {})[board] ?? {}).map((entry) => entry.name);
  const boardOnly = choices.map((choice) => choice.name).filter((name) => ![...known, ...synced].some((own) => sameDocument(own, name)));
  reportBoardOnly(board, boardOnly);

  /**
   * The copy to use. With a record, only the copy holding this exact file
   * counts; a changed file means the board's copy is stale. Without one (a
   * copy the person put there themselves, before Owtomate kept records), the
   * name decides once and the content is recorded from then on.
   */
  const names = record ? (record.sha === sha ? [record.name] : []) : [chosen.seekName ?? '', chosen.fileName, chosen.label].filter(Boolean);
  const matching = choices.filter((choice) => names.some((name) => sameDocument(name, choice.name)));
  const match = matching.find((choice) => choice.checked) ?? matching[0];
  /**
   * A same-named copy the board says was added after the one recorded is a
   * file the person uploaded there themselves: not Owtomate's, whatever its
   * name. Owtomate's copy goes up under its own name and the person is told.
   */
  const shown = addedAt(match?.added);
  const replacedOnBoard = Boolean(match && record?.boardAddedAt !== undefined && shown
    && shown.at - record.boardAddedAt > Math.max(shown.tolerance, record.boardAddedTolerance ?? 0));
  if (match && !replacedOnBoard) {
    const wasChecked = match.checked;
    if (!wasChecked && !await select(match)) return { action: 'failed', reason: `The board's copy "${match.name}" could not be selected.` };
    // The first sighting fixes when the copy was added; later readings of a relative date only drift.
    const firstSeen = record?.name === match.name && record.boardAddedAt !== undefined
      ? { boardAddedAt: record.boardAddedAt, boardAddedTolerance: record.boardAddedTolerance }
      : shown ? { boardAddedAt: shown.at, boardAddedTolerance: shown.tolerance } : {};
    remember(board, chosen.id, { name: match.name, sha, ...firstSeen });
    return { action: wasChecked ? 'kept' : 'selected', name: match.name, label: chosen.label, board };
  }

  // Not on the board, or only an older copy: upload Owtomate's file.
  const frame = choices[0].frame;
  const upload = await uploadInput(frame) ?? (frame === page.mainFrame() ? null : await uploadInput(page.mainFrame()));
  if (!upload) return { action: 'failed', reason: 'The board shows saved résumés but no upload control was found for Owtomate\'s copy.' };
  let document = await documentFor(file, upload.accept);
  if (!document) return { action: 'failed', reason: `The board does not accept "${upload.accept}" and the résumé could not be converted.` };
  /**
   * A replaced file goes up under a new name: the board keeps the old copy
   * under the old one, and an exact name is the only way to tell them apart.
   */
  if ((record && record.sha !== sha) || replacedOnBoard) {
    const dir = resolve(tmpdir(), 'owtomate-resume-sync');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const renamed = resolve(dir, `${basename(document, extname(document))} (updated ${stamp})${extname(document)}`);
    copyFileSync(document, renamed);
    document = renamed;
  }
  const uploadedName = basename(document);
  await upload.input.setInputFiles(document, { timeout: 15_000 }).catch(() => {});

  // The board saves the upload and lists it; wait for it, then make sure it is the one selected.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const now = (await documentChoices(page)).filter((choice) => sameDocument(choice.name, uploadedName));
    const listed = now.find((choice) => choice.checked) ?? now[0];
    if (listed && (listed.checked || await select(listed))) {
      remember(board, chosen.id, { name: listed.name, sha, boardAddedAt: Date.now(), boardAddedTolerance: 24 * 60 * 60_000 });
      if (replacedOnBoard && match) reportReplaced(board, match.name, listed.name);
      return { action: 'uploaded', name: listed.name, label: chosen.label, board };
    }
  }
  return { action: 'failed', reason: `Owtomate's résumé was sent to the board's upload but "${uploadedName}" never appeared as a selected choice.` };
}
