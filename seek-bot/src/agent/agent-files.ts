import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { convertDocument, type DocumentFormat } from '../resume.js';
import type { PreparedApplication } from '../application-review-types.js';
import { agentOnlyUploadInventory, agentOnlyUploadPath } from './agent-only-evidence.js';
import { PDFDocument } from 'pdf-lib';

interface AgentFile { id: string; path: string; sourceId?: string; text?: string; approvedBundle?: boolean }
const formats = ['pdf', 'docx', 'doc', 'rtf', 'txt'];
export const fileIdsProperty = { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1 },
  description: 'Exact file_id values marked uploadable in the candidate inventory, or returned by create_file/convert_file. Supporting files use supporting:<id>; their bare retrieval IDs are not upload IDs. Notes are readable only; use create_file if you choose to attach their text. Empty array clears the selected input. Host paths and URLs are unavailable.' };

/** Private file transport only. The agent chooses the content, format and target.
 * Rendering and conversion never inspect a form or decide whether to upload. */
export class AgentFiles {
  private readonly generated = new Map<string, AgentFile>();
  constructor(private readonly jobId: string, private readonly approved?: PreparedApplication,
    private readonly render: typeof convertDocument = convertDocument) {}

  resolve(id: string): AgentFile {
    const generated = this.generated.get(id);
    const path = generated?.path ?? agentOnlyUploadPath(id);
    if (!path) throw Error(`Choose a file ID from the uploadable inventory file_id values (${JSON.stringify(agentOnlyUploadInventory().map(file => file.file_id))}) or a file_id returned by create_file/convert_file. Bare supporting-document retrieval IDs are not upload IDs; use their explicit supporting:<id> file_id. Notes require create_file when you choose to attach their text. Host paths and other accounts are unavailable.`);
    const file = generated ?? { id, path, sourceId: id };
    if (this.approved && !file.approvedBundle && file.sourceId !== this.approved.resumeId && !(typeof file.text === 'string' && file.text === this.approved.coverLetter)) {
      throw Error('This file is outside the candidate-approved resume and cover letter. Save changed content for candidate confirmation first.');
    }
    return file;
  }

  private directory(key: string): string {
    const owner = realpathSync(config.dataDir);
    const dir = resolve(owner, 'agent-documents', createHash('sha256').update(this.jobId).digest('hex').slice(0, 20), key);
    mkdirSync(dir, { recursive: true });
    const actual = realpathSync(dir), part = relative(owner, actual);
    if (!part || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) throw Error('File storage is outside this account.');
    return actual;
  }

  private describe(file: AgentFile) {
    return { file_id: file.id, name: basename(file.path), bytes: statSync(file.path).size, format: extname(file.path).slice(1) };
  }

  async create(name: string, text: string, format: DocumentFormat) {
    if (!formats.includes(format) || !text.trim()) throw Error('Provide the complete document text and an explicit supported format.');
    // The agent already chose the format explicitly. A plain title without
    // an extension is sufficient; filename punctuation must not force another
    // paid reasoning turn. Conflicting extensions and paths remain invalid.
    if (name && !extname(name)) name += '.' + format;
    if (!name || basename(name) !== name || /[\\/\x00-\x1f]/.test(name) || name.length > 160 || extname(name).toLowerCase() !== '.' + format) {
      throw Error('Choose a plain file name whose extension matches your explicit format.');
    }
    if (this.approved && text !== this.approved.coverLetter) throw Error('Generated content must match the candidate-approved cover letter exactly. Save changes for confirmation first.');
    const key = createHash('sha256').update(JSON.stringify([name, format, text])).digest('hex');
    const source = resolve(this.directory(key), basename(name, extname(name)) + '.txt');
    writeFileSync(source, text, { mode: 0o600 });
    const path = await convertDocument(source, format);
    if (!path) throw Error('The requested file could not be rendered. No file was attached; inspect the error and choose your next action.');
    const file = { id: 'generated:' + key, path, text };
    this.generated.set(file.id, file);
    return this.describe(file);
  }

  async convert(id: string, format: DocumentFormat) {
    if (!formats.includes(format)) throw Error('Choose an explicit supported output format.');
    const original = this.resolve(id);
    // Content-address the source, avoiding stale variants when a CV is replaced.
    const key = createHash('sha256').update(readFileSync(original.path)).update(JSON.stringify([basename(original.path), format])).digest('hex');
    const source = resolve(this.directory(key), basename(original.path));
    if (source !== original.path) copyFileSync(original.path, source);
    const path = await convertDocument(source, format);
    if (!path) throw Error('The requested conversion failed. No file was attached; choose your next action from the actual employer requirements.');
    const file = { ...original, id: 'generated:' + key, path };
    this.generated.set(file.id, file);
    return this.describe(file);
  }

  /** Bundle the exact confirmed letter and resume without model-authored CV text. */
  async combineApprovedDocuments() {
    const approved = this.approved;
    if (!approved?.coverLetter?.trim() || !approved.resumeId || !approved.resumeHash) throw Error('The confirmed letter and a verified resume are required. Prepare for confirmation again.');
    const original = this.resolve(approved.resumeId);
    const bytes = readFileSync(original.path);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== approved.resumeHash) throw Error('The confirmed resume has changed. Prepare for confirmation again.');
    const key = createHash('sha256').update(JSON.stringify([approved.coverLetter, hash, 'approved-bundle-v1'])).digest('hex');
    const dir = this.directory(key);
    const letter = resolve(dir, 'cover-letter.txt');
    const resume = resolve(dir, 'resume' + extname(original.path).toLowerCase());
    writeFileSync(letter, approved.coverLetter, { mode: 0o600 });
    writeFileSync(resume, bytes, { mode: 0o600 });
    const letterPdf = await this.render(letter, 'pdf');
    const resumePdf = await this.render(resume, 'pdf');
    if (!letterPdf || !resumePdf) throw Error('Could not render the confirmed documents as PDF. No file was attached.');
    const output = await PDFDocument.create();
    const counts: number[] = [];
    for (const path of [letterPdf, resumePdf]) {
      const document = await PDFDocument.load(readFileSync(path));
      if (document.getForm().getFields().length) throw Error('Interactive PDF fields cannot be preserved safely in a combined document.');
      counts.push(document.getPageCount());
      for (const page of await output.copyPages(document, document.getPageIndices())) output.addPage(page);
    }
    if (counts.some(count => !count)) throw Error('A confirmed document has no pages.');
    const path = resolve(dir, 'cover-letter-and-resume.pdf');
    writeFileSync(path, await output.save(), { mode: 0o600 });
    const file = { id: 'generated:' + key, path, approvedBundle: true };
    this.generated.set(file.id, file);
    return { ...this.describe(file), letter_pages: counts[0], resume_pages: counts[1] };
  }
}
