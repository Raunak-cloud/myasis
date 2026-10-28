import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, basename, dirname, extname } from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

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

const manifest = () => resolve(config.dataDir, 'resumes.json');
export const resumeDirectory = () => resolve(config.dataDir, 'resumes');

export function loadResumes(): ResumeRecord[] {
  const path = manifest();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ResumeRecord[];
  } catch {
    return [];
  }
}

export type DocumentFormat = 'pdf' | 'docx' | 'doc' | 'rtf' | 'txt';

/**
 * Convert an account document only to a format explicitly chosen by the
 * applying agent. Employer HTML is never parsed into a conversion or veto.
 * LibreOffice retains the document layout; variants remain beside the source.
 */
export async function convertDocument(file: string, format: DocumentFormat): Promise<string | null> {
  const ext = extname(file).toLowerCase();
  const target = `.${format}`;
  if (ext === target) return file;
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
