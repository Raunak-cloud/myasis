import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { convertDocument, type DocumentFormat } from '../resume.js';
import type { ApplicationDocument, PreparedApplication } from '../application-review-types.js';
import { documentHash, preserveDocument, verifiedDocumentPath } from '../application-documents.js';
import { extractText } from '../knowledge.js';
import { observedApprovedCoverLetter, typedCoverLetterControls } from '../application-letter.js';
import {isCoverLetterField} from '../cover-letter-policy.js';
import type { FormField } from '../types.js';
import { agentOnlyUploadInventory, agentOnlyUploadPath } from './agent-only-evidence.js';
import { PDFDocument } from 'pdf-lib';

interface AgentFile { id: string; path: string; sourceId?: string; text?: string; approvedBundle?: boolean; coverLetter?: boolean; provenance?: 'text' | 'file'; sha256?: string; coverLetterDigest?: string }
interface UploadEvent { at: string; selected: UploadedFiles['files']; retiredFileIds: string[] }
export interface UploadedFiles { target: string; files: Array<AgentFile & { sha256: string; bytes: number; name: string }>; removedFileIds?: string[]; events?: UploadEvent[] }
const formats = ['pdf', 'docx', 'doc', 'rtf', 'txt'];
export const fileIdsProperty = { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1 },
  description: 'Exact file_id values marked uploadable in the candidate inventory, or returned by create_file/convert_file. Supporting files use supporting:<id>; their bare retrieval IDs are not upload IDs. Notes are readable only; use create_file if you choose to attach their text. Empty array clears the selected input. Host paths and URLs are unavailable.' };

/** Private file transport only. The agent chooses the content, format and target.
 * Rendering and conversion never inspect a form or decide whether to upload. */
export class AgentFiles {
  private readonly generated = new Map<string, AgentFile>();
  private readonly uploads = new Map<string, UploadedFiles>();
  private witnessedLetter?: string;
  private letterWitness?: FormField[];
  constructor(private readonly jobId: string, private readonly approved?: PreparedApplication,
    private readonly render: typeof convertDocument = convertDocument) {}
  witnessApprovedLetter(fields: FormField[]): void {
    const letter = observedApprovedCoverLetter(this.approved, fields);
    if (typedCoverLetterControls(fields).length) { this.witnessedLetter = undefined; this.letterWitness = undefined; }
    if (letter !== undefined) {
      this.witnessedLetter = letter;
      this.letterWitness = fields.filter(field => !field.sensitive && field.currentValue?.replace(/\s+/g, ' ').trim() === letter.replace(/\s+/g, ' ').trim())
        .map(({ ref, label, kind, inputType, required, currentValue, controlIdentity }) => ({ ref, label, kind, inputType, required, currentValue, controlIdentity }));
    }
  }
  checkpointLetterWitness(): FormField[] | undefined { return this.letterWitness ? structuredClone(this.letterWitness) : undefined; }
  clearLetterWitness():void {this.witnessedLetter=undefined;this.letterWitness=undefined;}
  /** A normal explicit browser inspection is actual readback, not the parent's
   * assertion that a fill succeeded. Bind only a unique non-private letter
   * control, and never promote an unrelated or ambiguous inspection. */
  witnessInspectedLetter(result:unknown,fields:FormField[]=[]):void {
    if(!result||typeof result!=='object')return;
    const record=result as Record<string,unknown>;
    if(Array.isArray(record.fields))return;
    const matching=fields.filter(field=>!field.sensitive&&!field.privateKind&&(record.controlIdentity
      ?field.controlIdentity===record.controlIdentity:typeof record.ref==='string'&&field.ref===record.ref));
    const label=typeof record.label==='string'&&record.label.trim()?record.label:matching.length===1?matching[0].label:undefined;
    if(record.private||record.visible!==true||record.disabled||typeof label!=='string'
      ||!isCoverLetterField(label)||typeof record.value!=='string'
      ||!(record.tag==='textarea'||record.tag==='input'&&['text','search'].includes(String(record.type))))return;
    if(record.invalid==='true'||record.validation){this.clearLetterWitness();return;}
    this.witnessApprovedLetter([{ref:String(record.ref??''),label,kind:record.tag==='textarea'?'textarea':'text',
      inputType:String(record.type),required:Boolean(record.required),currentValue:record.value,controlIdentity:typeof record.controlIdentity==='string'?record.controlIdentity:undefined}]);
  }
  recheckLetterWitness(fields:FormField[]):void {
    const current=typedCoverLetterControls(fields);
    if(this.letterWitness&&current.length&&(current.some(field=>field.validationError)||!observedApprovedCoverLetter(this.approved,fields)))this.clearLetterWitness();
  }
  private get approvedLetter(): string | undefined { return this.approved?.coverLetter ?? this.witnessedLetter; }

  checkpoint(): Array<AgentFile> { return [...this.generated.values()].map(file=>({...file})); }
  checkpointUploads(): UploadedFiles[] { return structuredClone([...this.uploads.values()]); }
  restoreUploads(uploads: UploadedFiles[] = []): void {
    for (const upload of uploads) this.uploads.set(upload.target, { ...upload, files: upload.files.map(file => ({ ...file,
      path: verifiedDocumentPath(file) })) });
  }
  uploadSelection(ids: string[]): UploadedFiles['files'] {
    return ids.map(id => { const file = this.resolve(id); return { ...file, ...preserveDocument(file.path) }; });
  }
  validateReplacements(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 10 || value.some(id => typeof id !== 'string' || !id.trim()) || new Set(value).size !== value.length)
      throw Error('replaces_file_ids must be a unique array of previously uploaded file IDs.');
    const known = new Set([...this.uploads.values()].flatMap(upload => upload.files.map(file => file.id)));
    if (value.some(id => !known.has(id))) throw Error('Only exact files previously uploaded in this owner application can be replaced. No browser action ran.');
    return value as string[];
  }
  recordUpload(target: string, files: UploadedFiles['files'], replaces: string[] = []): void {
    this.validateReplacements(replaces);
    for (const [key, upload] of this.uploads) if (key !== target && upload.files.some(file => replaces.includes(file.id))) {
      this.uploads.set(key, { ...upload, files: upload.files.filter(file => !replaces.includes(file.id)),
        removedFileIds: [...new Set([...(upload.removedFileIds ?? []), ...upload.files.filter(file => replaces.includes(file.id)).map(file => file.id)])] });
    }
    const previous = this.uploads.get(target);
    const retired = [...new Set([...replaces, ...(previous?.files ?? []).filter(file => !files.some(value => value.id === file.id && value.sha256 === file.sha256)).map(file => file.id)])];
    const removedFileIds = [...new Set([...(previous?.removedFileIds ?? []), ...retired])]
      .filter(id => !files.some(file => file.id === id));
    this.uploads.set(target, { target, files, ...(removedFileIds.length ? { removedFileIds } : {}),
      events: [...(previous?.events ?? []), { at: new Date().toISOString(), selected: structuredClone(files), retiredFileIds: retired }] });
  }

  /** Explicit roles bind exact uploaded bytes; names never determine document roles. */
  async reviewDocuments(resumeId: string, coverLetterFileId: string | undefined, supportingFileIds: string[] | undefined): Promise<ApplicationDocument[] | undefined> {
    const uploaded = [...this.uploads.values()].flatMap(upload => upload.files);
    const removed = new Set([...this.uploads.values()].flatMap(upload => upload.removedFileIds ?? []));
    const approved = this.approved?.documents ?? [];
    if (approved.some(document => document.requiresUpload && !uploaded.some(file => file.id === document.fileId && file.sha256 === document.sha256
      || document.provenance === 'text' && document.text !== undefined && file.coverLetterDigest === documentHash(Buffer.from(document.text)))))
      throw Error('A candidate-revised attachment has not been uploaded. Select its exact approved file_id and inspect the employer response before preparing; the same filename does not prove matching bytes.');
    const declarations = [
      ...(coverLetterFileId ? [{ id: coverLetterFileId, role: 'cover-letter' as const }] : []),
      ...(supportingFileIds ?? []).map(id => ({ id, role: 'supporting' as const })),
    ];
    if (!declarations.length && this.approved && coverLetterFileId === undefined && supportingFileIds === undefined) {
      for (const file of uploaded.filter(file => file.coverLetter && file.text === this.approvedLetter))
        if (!declarations.some(item => item.id === file.id)) declarations.push({ id: file.id, role: 'cover-letter' });
    }
    if (new Set(declarations.map(item => item.id)).size !== declarations.length) throw Error('Assign each attached file one explicit document role.');
    const nonResume = uploaded.filter(file => file.sourceId !== resumeId && !file.approvedBundle);
    // Approved reconstructions retain the exact existing document declaration
    // when no new arguments were supplied. A new draft must name every upload.
    if (this.approved?.documents && coverLetterFileId === undefined && supportingFileIds === undefined
      && !nonResume.some(file => file.coverLetter && !approved.some(document => document.fileId === file.id && document.sha256 === file.sha256))) {
      if (approved.some(document => removed.has(document.fileId) && !uploaded.some(file => file.id === document.fileId)))
        throw Error('An approved attachment was explicitly removed. Restore the exact approved file before sending; the job remains approved.');
      for (const document of approved) verifiedDocumentPath(document);
      if (nonResume.some(file => !approved.some(document => document.fileId === file.id && document.sha256 === file.sha256)))
        throw Error('An attachment differs from the approved documents. Restore the exact approved documents before sending; do not prepare the job again.');
      return approved.map(document => ({ ...document }));
    }
    if (nonResume.some(file => !declarations.some(item => item.id === file.id))) throw Error('Declare every attached non-resume file using cover_letter_file_id or supporting_file_ids before preparing. Do not infer a role from a filename.');
    const documents: ApplicationDocument[] = [];
    for (const declaration of declarations) {
      const matches = uploaded.filter(file => file.id === declaration.id);
      const identities = new Set(matches.map(file => file.sha256));
      if (!matches.length || identities.size !== 1) throw Error(`The declared document has no unambiguous successful native upload (${declaration.id}; active file IDs: ${JSON.stringify([...new Set(uploaded.map(file => file.id))])}). Inspect and attach the exact intended file first.`);
      const file = matches[0];
      if (file.sourceId === resumeId || file.approvedBundle) throw Error('The selected resume or combined approved bundle cannot be relabelled as another document.');
      const path = verifiedDocumentPath(file);
      const text = file.text ?? await extractText(path);
      if (declaration.role === 'cover-letter' && !text.trim()) throw Error('The attached cover letter has no readable source text. Use a readable source document; do not invent its contents.');
      documents.push({ role: declaration.role, provenance: file.provenance ?? 'file', fileId: file.id, name: file.name, sha256: file.sha256, bytes: file.bytes,
        ...(text ? { text } : {}) });
    }
    if (this.approved && coverLetterFileId === undefined && supportingFileIds === undefined) {
      for (const document of approved.filter(document => document.role === 'supporting')) {
        verifiedDocumentPath(document);
        if (!documents.some(value => value.fileId === document.fileId)) documents.push({ ...document });
      }
    }
    if (documents.filter(document => document.role === 'cover-letter').length > 1) throw Error('More than one cover-letter attachment is active. Inspect the actual saved attachments and retain the intended one.');
    return documents.length ? documents : undefined;
  }
  restore(files: Array<AgentFile>): void {
    const owner = realpathSync(config.dataDir);
    for(const file of files) {
      const path = realpathSync(file.path), part = relative(owner,path);
      if(!part || isAbsolute(part) || part === '..' || part.startsWith('..'+sep)) throw Error('Restored document is outside this account.');
      this.generated.set(file.id,{...file,path});
      this.resolve(file.id); // Apply the normal candidate approval gate as well.
    }
  }

  resolve(id: string): AgentFile {
    const bound = this.approved?.documents?.find(document => document.fileId === id);
    if (bound) return { id, path: verifiedDocumentPath(bound), sourceId: id, text: bound.text, provenance: bound.provenance ?? 'file', coverLetter: bound.role === 'cover-letter' };
    const generated = this.generated.get(id);
    const path = generated?.path ?? agentOnlyUploadPath(id);
    if (!path) throw Error(`Choose a file ID from the uploadable inventory file_id values (${JSON.stringify(agentOnlyUploadInventory().map(file => file.file_id))}) or a file_id returned by create_file/convert_file. Bare supporting-document retrieval IDs are not upload IDs; use their explicit supporting:<id> file_id. Notes require create_file when you choose to attach their text. Host paths and other accounts are unavailable.`);
    const file = generated ?? { id, path, sourceId: id, provenance: 'file' as const };
    if (file.sha256 && documentHash(readFileSync(file.path)) !== file.sha256) throw Error('The generated document bytes have changed. Recreate the exact authorized document.');
    if (this.approved?.resumeId && this.approved.resumeId === file.sourceId && this.approved.resumeHash) {
      const original = agentOnlyUploadPath(this.approved.resumeId);
      if (!original || documentHash(readFileSync(original)) !== this.approved.resumeHash) throw Error('The confirmed resume has changed. Restore the exact approved document before sending; do not prepare the job again.');
    }
    if (this.approved && !file.approvedBundle && file.sourceId !== this.approved.resumeId && !(typeof file.text === 'string' && file.text === this.approvedLetter)) {
      throw Error('This file is outside the candidate-approved resume and cover letter. Use the exact approved document; do not prepare the job again.');
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
    if (this.approved && text !== this.approvedLetter) throw Error('Generated content must match the candidate-approved cover letter exactly. Restore the exact approved text; do not prepare the job again.');
    const key = createHash('sha256').update(JSON.stringify([name, format, text])).digest('hex');
    const source = resolve(this.directory(key), basename(name, extname(name)) + '.txt');
    writeFileSync(source, text, { mode: 0o600 });
    const path = await this.render(source, format);
    if (!path) throw Error('The requested file could not be rendered. No file was attached; inspect the error and choose your next action.');
    const file = { id: 'generated:' + key, path, text, provenance: 'text' as const, sha256: documentHash(readFileSync(path)) };
    this.generated.set(file.id, file);
    return this.describe(file);
  }

  /** Render the selected immutable approval directly; the model chooses only
   * the filename/format, so transcription cannot alter confirmed content. */
  async createApprovedLetter(name: string, format: DocumentFormat) {
    if (!this.approvedLetter?.trim()) throw Error('This application has no candidate-approved cover letter. Inspect the actual letter opportunity and candidate evidence; do not prepare the job again.');
    const bound = this.approved?.documents?.find(document => document.role === 'cover-letter');
    if (bound && extname(bound.name).toLowerCase() === '.' + format) {
      return this.describe(this.resolve(bound.fileId));
    }
    const result = await this.create(name, this.approvedLetter, format);
    this.generated.get(result.file_id)!.coverLetter = true;
    this.generated.get(result.file_id)!.coverLetterDigest = documentHash(Buffer.from(this.approvedLetter));
    return result;
  }

  async convert(id: string, format: DocumentFormat) {
    if (!formats.includes(format)) throw Error('Choose an explicit supported output format.');
    const original = this.resolve(id);
    // Content-address the source, avoiding stale variants when a CV is replaced.
    const key = createHash('sha256').update(readFileSync(original.path)).update(JSON.stringify([basename(original.path), format])).digest('hex');
    const source = resolve(this.directory(key), basename(original.path));
    if (source !== original.path) copyFileSync(original.path, source);
    const path = await this.render(source, format);
    if (!path) throw Error('The requested conversion failed. No file was attached; choose your next action from the actual employer requirements.');
    const file = { ...original, id: 'generated:' + key, path, sha256: documentHash(readFileSync(path)) };
    this.generated.set(file.id, file);
    return this.describe(file);
  }

  /** Bundle the exact confirmed letter and resume without model-authored CV text. */
  async combineApprovedDocuments() {
    const approved = this.approved;
    const letterText = this.approvedLetter;
    if (!letterText?.trim() || !approved?.resumeId || !approved.resumeHash) throw Error('The confirmed letter and a verified resume are required. Restore the exact approved document before sending; do not prepare the job again.');
    const original = this.resolve(approved.resumeId);
    const bytes = readFileSync(original.path);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== approved.resumeHash) throw Error('The confirmed resume has changed. Restore the exact approved document before sending; do not prepare the job again.');
    const key = createHash('sha256').update(JSON.stringify([letterText, hash, 'approved-bundle-v1'])).digest('hex');
    const dir = this.directory(key);
    const letter = resolve(dir, 'cover-letter.txt');
    const resume = resolve(dir, 'resume' + extname(original.path).toLowerCase());
    writeFileSync(letter, letterText, { mode: 0o600 });
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
    const file = { id: 'generated:' + key, path, approvedBundle: true, sha256: documentHash(readFileSync(path)), coverLetterDigest: documentHash(Buffer.from(letterText)) };
    this.generated.set(file.id, file);
    return { ...this.describe(file), letter_pages: counts[0], resume_pages: counts[1] };
  }
}
