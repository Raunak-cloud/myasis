import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { config } from './config.js';
import type { ApplicationDocument, PreparedApplication } from './application-review-types.js';
import { convertDocument, type DocumentFormat } from './resume.js';
import { cleanCoverLetter } from './cover-letter-policy.js';
import { applicationRevision, withCoverLetter } from './application-review-content.js';

export const documentHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function insideOwner(path: string, ownerDirectory = config.dataDir): string {
  const owner = realpathSync(ownerDirectory), actual = realpathSync(path), part = relative(owner, actual);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) throw Error('Document artifact is outside this account.');
  return actual;
}
function artifactPath(document: Pick<ApplicationDocument, 'name' | 'sha256'>, ownerDirectory = config.dataDir): string {
  if (!/^[a-f0-9]{64}$/.test(document.sha256) || !document.name || basename(document.name) !== document.name
    || /[\\/\x00-\x1f]/.test(document.name) || document.name.length > 255) throw Error('Invalid immutable document identity.');
  return resolve(ownerDirectory, 'application-document-artifacts', document.sha256, document.name);
}
function ensureOwnerDirectory(path: string, ownerDirectory: string): string {
  const owner = realpathSync(ownerDirectory), part = relative(owner, resolve(path));
  if (!part || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) throw Error('Document artifact is outside this account.');
  let current = owner;
  for (const segment of part.split(sep)) {
    current = resolve(current, segment);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw Error('Document artifact storage must remain inside this account.');
    insideOwner(current, owner);
  }
  return current;
}

/** Snapshot before native upload so the selected bytes cannot change under it. */
export function preserveDocument(path: string, ownerDirectory = config.dataDir, originalName?: string): { path: string; name: string; sha256: string; bytes: number } {
  const source = insideOwner(path, ownerDirectory), bytes = readFileSync(source), name = originalName ?? basename(source), sha256 = documentHash(bytes);
  const target = artifactPath({ name, sha256 }, ownerDirectory);
  ensureOwnerDirectory(resolve(target, '..'), ownerDirectory);
  try { writeFileSync(target, bytes, { flag: 'wx', mode: 0o400 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const saved = verifiedDocumentPath({ name, sha256, bytes: bytes.length }, ownerDirectory);
  return { path: saved, name, sha256, bytes: bytes.length };
}

export function verifiedDocumentPath(document: Pick<ApplicationDocument, 'name' | 'sha256' | 'bytes'>, ownerDirectory = config.dataDir): string {
  const path = artifactPath(document, ownerDirectory);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw Error('The approved document artifact is unavailable. Prepare for confirmation again.');
  const actual = insideOwner(path, ownerDirectory), bytes = readFileSync(actual);
  if (bytes.length !== document.bytes || documentHash(bytes) !== document.sha256) throw Error('The approved document bytes have changed. Prepare for confirmation again.');
  return path;
}

/** The candidate explicitly changes text. Render a new artifact without
 * mutating account configuration or the previously approved source bytes. */
export async function reviseAttachedCoverLetter(current: PreparedApplication, text: string, ownerDirectory: string,
  render: typeof convertDocument = convertDocument): Promise<PreparedApplication> {
  const letter = cleanCoverLetter(text), bound = current.documents?.find(document => document.role === 'cover-letter');
  if (!bound || letter === current.coverLetter) return withCoverLetter(current, letter);
  const application = withCoverLetter({ ...current, documents: current.documents?.filter(document => document.role !== 'cover-letter') }, letter);
  verifiedDocumentPath(bound, ownerDirectory);
  const format = extname(bound.name).slice(1).toLowerCase();
  if (!['txt', 'pdf', 'doc', 'docx', 'rtf'].includes(format)) throw Error('This attached letter format cannot be rendered safely. Prepare a supported replacement for confirmation.');
  const key = documentHash(Buffer.from(JSON.stringify([bound.name, letter, 'candidate-letter-edit-v1'])));
  const directory = resolve(ownerDirectory, 'application-letter-edits', key);
  ensureOwnerDirectory(directory, ownerDirectory);
  const source = resolve(directory, basename(bound.name, extname(bound.name)) + '.txt');
  try { writeFileSync(source, letter, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (readFileSync(insideOwner(source, ownerDirectory), 'utf8') !== letter) throw Error('The candidate letter edit source changed. Retry from the original reviewed version.');
  const rendered = await render(source, format as DocumentFormat, { profile: resolve(directory, 'office-profile') });
  if (!rendered || basename(rendered).toLowerCase() !== bound.name.toLowerCase()) throw Error('The revised attached letter could not be rendered. The original review is unchanged.');
  insideOwner(rendered, ownerDirectory);
  const named = resolve(dirname(rendered), bound.name);
  if (named !== rendered) {
    try { copyFileSync(rendered, named, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (documentHash(readFileSync(insideOwner(named, ownerDirectory))) !== documentHash(readFileSync(rendered))) throw Error('The revised letter filename is occupied by different bytes. The original review is unchanged.');
  }
  const preserved = preserveDocument(named, ownerDirectory, bound.name);
  const replacement: ApplicationDocument = { role: 'cover-letter', provenance: 'text', requiresUpload: true, fileId: 'approved-letter:' + preserved.sha256,
    name: preserved.name, sha256: preserved.sha256, bytes: preserved.bytes, text: letter };
  application.documents = current.documents!.map(document => document === bound ? replacement : document);
  application.revision = applicationRevision(application);
  return application;
}
