import { config } from '../../config.js';
import { fillField } from '../../dom.js';
import { finishedCoverLetterForJob, fitCoverLetterToLimit } from '../../llm.js';
import { acceptsFormat, pickResumeForJob, RESUME_DIR, documentFor } from '../../resume.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import type { Observation } from '../observe.js';
import { wasHumanized } from '../../humanizer.js';
import { countHealth } from '../../run-health.js';
import { hostOf } from '../../site-auth.js';
import { locate } from '../raw-tools.js';
import { ToolResult, ToolContext, ok, noteAction, siteName } from './context.js';

// Part of the agent's tools, split from tools.ts by concern; tools.ts re-exports it.

/** Writes only to the current field selected by the navigation model. */
export async function doAddCoverLetter(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const upload = ctx.observation.actions.find(action => action.ref === args.ref && action.role === 'file');
  if (upload) return addCoverLetterFile(ctx, upload);
  const field = ctx.observation.fields.find(field => field.ref === args.ref);
  if (field && ['radio', 'select'].includes(field.kind) && typeof args.option === 'string' && field.options?.includes(args.option)) {
    try { await fillField(ctx.page, field, args.option); }
    catch {
      return ok('The cover-letter control changed after the last observation. Re-observe and use the current FIELD ref; do not abandon the application.');
    }
    return ok('Cover-letter option selected. Re-observe, then call add_cover_letter with the writing FIELD ref.');
  }
  /**
   * A writing box inside an embedded form is only in the snapshot (JobAdder's
   * "Tell us more" on dws.hcltech.com), never in the observation. Without
   * this the agent could not write the letter there — nor replace the text
   * another employer's letter had left in it, which the submit audit then
   * rightly refused to send.
   */
  const embedded = !field ? locate(ctx.page, String(args.ref ?? '')) : null;
  const embeddedKind = embedded
    ? await embedded.evaluate((el) => el instanceof HTMLTextAreaElement ? 'textarea'
      : el instanceof HTMLInputElement && ['text', ''].includes(el.type) ? 'text'
        // A rich-text editor (ELMO Talent's "Editor, coverLetterWrite", CKEditor, Quill) is an editable region, not a textarea.
        : (el as HTMLElement).isContentEditable ? 'editor' : 'other').catch(() => 'other')
    : 'other';
  const writable = embedded && embeddedKind !== 'other' ? embedded : null;
  if (!writable && (!field || !['textarea', 'text'].includes(field.kind) || field.sensitive)) {
    return ok('Choose the visible cover-letter FIELD ref. If it is hidden, use click to open the write-letter option, then observe again. Never choose an unrelated text box.');
  }
  const target = writable ?? ctx.page.locator(`[data-field-id="${field!.ref}"]`);
  const label = field?.label ?? 'cover letter';
  let letter = await finishedCoverLetterForJob(ctx.job, ctx.profile);
  if (!letter.trim()) throw new Error('Cover-letter drafting returned no text.');
  const maxLength = await target.evaluate(el => (el as HTMLTextAreaElement).maxLength).catch(() => -1);
  if (Number.isInteger(maxLength) && maxLength >= 0) letter = await fitCoverLetterToLimit(letter, maxLength, ctx.job, ctx.profile);
  try {
    if (field) await fillField(ctx.page, field, letter, 'type');
    else {
      // fill() replaces whatever the box held; read back so a box that rejected it is not reported as written.
      await writable!.fill(letter, { timeout: 10_000 });
      const held = embeddedKind === 'editor'
        ? await writable!.innerText({ timeout: 5_000 })
        : await writable!.inputValue({ timeout: 5_000 });
      if (held.replace(/\s+/g, ' ').trim() !== letter.replace(/\s+/g, ' ').trim()) throw new Error('the box did not keep the letter');
    }
  }
  catch (error) { return ok(`Cover letter not accepted: ${(error as Error).message}. Re-observe and choose the current writing field or resolve the form's validation.`); }
  ctx.coverLetter = letter;
  // Marked, so what the box holds when the form is sent can be read back as the letter that went (recordWhatWasSent).
  await target.evaluate((el) => el.setAttribute('data-owt-letter', '1')).catch(() => {});
  ctx.guards.recordFillSuccess(label);
  if (config.humanizer.enabled) countHealth(wasHumanized(letter) ? 'humanizedLetters' : 'draftLetters');
  ctx.log(`  ✓ ${wasHumanized(letter) ? 'humanized' : config.humanizer.enabled ? 'unhumanized (grounded draft)' : 'personalized'} cover letter added`);
  return ok(`Cover letter verified in ${field?.ref ?? String(args.ref)}. Re-observe the page and handle any remaining fields or validation before continuing.`);
}

/**
 * The same grounded, humanized letter, sent as a document to a form that
 * only takes the cover letter as an upload (Oracle Recruiting Cloud, many
 * PageUp forms). Written as text, then converted to what the input accepts,
 * PDF when it does not say.
 */
export async function addCoverLetterFile(ctx: ToolContext, action: Observation['actions'][number]): Promise<ToolResult> {
  if (/image/i.test(action.text) && !/letter|document|cv|resume/i.test(action.text)) {
    return ok('That upload is for an image, not a cover letter. Choose the cover-letter upload from a fresh observation.');
  }
  const input = ctx.page.locator(`input[type="file"][data-ref-id="${action.ref}"]`);
  const accept = (await input.getAttribute('accept').catch(() => null)) ?? '';
  const document = await coverLetterDocument(ctx, accept);
  if (!document) return ok(`This upload only accepts "${accept}", and the cover letter could not be produced in that format. Look for a text box or another option.`);
  try { await input.setInputFiles(document.file, { timeout: 10_000 }); }
  catch { return ok('The cover-letter upload control changed after the last observation. Re-observe and use the current upload ACTION ref.'); }
  coverLetterSent(ctx, document);
  return ok('Cover letter uploaded as a document. Re-observe: confirm the file appears and resolve any upload error before continuing.');
}

/** The grounded letter as a file this upload accepts: PDF when it may, otherwise what it lists. */
export async function coverLetterDocument(ctx: ToolContext, accept: string): Promise<{ file: string; letter: string } | null> {
  const letter = await finishedCoverLetterForJob(ctx.job, ctx.profile);
  if (!letter.trim()) throw new Error('Cover-letter drafting returned no text.');
  const dir = resolve(config.dataDir, 'cover-letters');
  mkdirSync(dir, { recursive: true });
  const name = `Cover Letter - ${ctx.profile.name} - ${ctx.job.company}`.replace(/[^\w .-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const text = resolve(dir, `${name}.txt`);
  writeFileSync(text, letter);
  // A document reads better than plain text; plain text is the fallback a form that lists .txt still takes.
  const file = (acceptsFormat(accept, '.pdf') ? await documentFor(text, '.pdf') : null) ?? (await documentFor(text, accept));
  return file ? { file, letter } : null;
}

export function coverLetterSent(ctx: ToolContext, document: { file: string; letter: string }): void {
  ctx.coverLetter = document.letter;
  ctx.guards.recordProgress();
  if (config.humanizer.enabled) countHealth(wasHumanized(document.letter) ? 'humanizedLetters' : 'draftLetters');
  ctx.log(`  ✓ ${wasHumanized(document.letter) ? 'humanized' : config.humanizer.enabled ? 'unhumanized (grounded draft)' : 'personalized'} cover letter uploaded as ${extname(document.file).slice(1).toUpperCase()}`);
}

/** The approved resume as a file this upload accepts, or why not. */
export async function resumeDocument(ctx: ToolContext, accept: string, format = ''): Promise<{ file: string; label: string } | { error: string }> {
  const wanted = await pickResumeForJob(ctx.job, ctx.profile);
  if (!wanted) return { error: 'No approved local resume is available.' };
  if (!config.resume.allowUpload) return { error: 'Resume uploading is disabled.' };
  const file = resolve(RESUME_DIR, wanted.fileName);
  const within = relative(RESUME_DIR, file);
  if (!within || within.startsWith('..') || isAbsolute(within) || !existsSync(file)) return { error: 'The approved resume file is unavailable.' };
  const upload = await documentFor(file, format || accept);
  if (!upload) return { error: `This upload only accepts "${accept}", and the resume could not be produced in that format.` };
  return { file: upload, label: wanted.label };
}

export function resumeSent(ctx: ToolContext, label: string): void {
  ctx.resumeUsed = label;
  const site = hostOf(ctx.page.url());
  noteAction(ctx, { kind: 'resume-uploaded', site, detail: `Sent "${label}" to the resume upload control on ${siteName(site)}.` });
}

/** The model selects the control; this tool supplies only the approved local document. */
export async function doAttachResume(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const wanted = await pickResumeForJob(ctx.job, ctx.profile);
  if (!wanted) return ok('No approved local resume is available. Finish with cannot_complete; do not choose an arbitrary document.');
  const ref = typeof args.ref === 'string' ? args.ref : '';
  const field = ctx.observation.fields.find(field => field.ref === ref);
  const action = ctx.observation.actions.find(action => action.ref === ref && action.role === 'file');
  const identity = `Resume to use: "${wanted.seekName || wanted.fileName}" (label "${wanted.label}").`;
  if (field && ['radio', 'select'].includes(field.kind)) {
    const option = typeof args.option === 'string' ? args.option : '';
    const normal = (value: string) => value.toLowerCase().replace(/\.(docx?|pdf|rtf|txt)\b/g, '').replace(/[^a-z0-9]/g, '');
    const names = [wanted.seekName, wanted.fileName, wanted.label].filter((name): name is string => Boolean(name));
    if (!field.options?.includes(option) || !names.some(name => normal(name).length >= 3 && normal(option).includes(normal(name)))) {
      return ok(`${identity} Choose its exact observed option, or upload it; do not select a different document.`);
    }
    try { await fillField(ctx.page, field, option); }
    catch {
      return ok(`${identity} The resume control changed after the last observation. Re-observe and use the current FIELD or upload ACTION ref; do not abandon the application.`);
    }
    ctx.resumeUsed = wanted.label;
    ctx.guards.recordFillSuccess(field.label);
    return ok('Resume selection verified. Re-observe before continuing.');
  }
  if (!action || action.disabled || !/^a\d+$/.test(ref)) {
    return ok(`${identity} Pass the observed resume upload ACTION ref, or a radio/select FIELD ref plus its exact option. If the control is hidden, open it with click and observe again. Do not use a photo upload.`);
  }
  const input = ctx.page.locator(`input[type="file"][data-ref-id="${ref}"]`);
  const accept = await input.getAttribute('accept') ?? '';
  if (/image\//i.test(accept) && !/pdf|word|document|\.doc|\.rtf|\.txt/i.test(accept)) {
    return ok('That upload accepts images, not a resume. Choose the document upload from a fresh observation.');
  }
  const format = typeof args.format === 'string' && /^(pdf|docx|doc|rtf|txt)$/.test(args.format) ? `.${args.format}` : '';
  const document = await resumeDocument(ctx, accept, format);
  if ('error' in document) return ok(`${identity} ${document.error} Select a matching existing document or another upload option on the page; otherwise finish with cannot_complete.`);
  try { await input.setInputFiles(document.file, { timeout: 10_000 }); }
  catch {
    return ok(`${identity} The resume upload control changed after the last observation. Re-observe and use the current upload ACTION ref; do not abandon the application.`);
  }
  const retained = await input.evaluate((element) => (element as HTMLInputElement).files?.[0]?.name ?? '').catch(() => '');
  if (retained) resumeSent(ctx, wanted.label);
  // File transport is not proof of server acceptance. Let the model read the next
  // observation, choose the uploaded document, and recover from any site error.
  return ok(`Resume file sent to the selected control${retained ? ` ("${retained}")` : ''}. Re-observe: confirm the document appears and select it with attach_resume if needed; resolve upload errors before continuing. This is not application success.`);
}
