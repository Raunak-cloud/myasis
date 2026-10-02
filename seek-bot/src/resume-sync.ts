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
        return match ? { index, name: match[1].trim(), checked } : null;
      }).filter((choice): choice is { index: number; name: string; checked: boolean } => Boolean(choice));
    }, { selector: RADIOS, pattern: DOCUMENT_NAME.source }).catch(() => [] as Array<{ index: number; name: string; checked: boolean }>);
    for (const choice of found) choices.push({ frame, ...choice });
  }
  return choices;
}

/** Owtomate résumé id → the board's copy of it, and the content that copy holds. */
type SyncRecord = Partial<Record<Board, Record<string, { name: string; sha: string }>>>;
const SYNC_FILE = () => resolve(config.dataDir, 'resume-sync.json');
const BOARD_ONLY_FILE = () => resolve(config.dataDir, 'board-resumes.json');

function readJson<T>(path: string, fallback: T): T {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback; } catch { return fallback; }
}

function remember(board: Board, resumeId: string, name: string, sha: string): void {
  const record = readJson<SyncRecord>(SYNC_FILE(), {});
  record[board] = { ...(record[board] ?? {}), [resumeId]: { name, sha } };
  writeFileSync(SYNC_FILE(), JSON.stringify(record, null, 2));
}

/** Saved résumés on a board that Owtomate does not hold, for the dashboard to mention. */
function reportBoardOnly(board: Board, names: string[]): void {
  const report = readJson<Partial<Record<Board, { names: string[]; seenAt: string }>>>(BOARD_ONLY_FILE(), {});
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
  if (match) {
    const wasChecked = match.checked;
    if (!wasChecked && !await select(match)) return { action: 'failed', reason: `The board's copy "${match.name}" could not be selected.` };
    remember(board, chosen.id, match.name, sha);
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
  if (record && record.sha !== sha) {
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
      remember(board, chosen.id, listed.name, sha);
      return { action: 'uploaded', name: listed.name, label: chosen.label, board };
    }
  }
  return { action: 'failed', reason: `Owtomate's résumé was sent to the board's upload but "${uploadedName}" never appeared as a selected choice.` };
}
