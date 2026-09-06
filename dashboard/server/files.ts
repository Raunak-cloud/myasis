import { existsSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { one, query } from './db/index.js';
import { userResumeDir, userKnowledgeDir, ensureUserDataDir } from './userdata.js';

/**
 * Résumé library and knowledge base — Postgres-backed metadata (`resumes`,
 * `knowledge_items`), scoped to one account, exactly like `billing.ts`. The
 * actual binary files still live on disk (the schema only stores metadata,
 * never blobs), but now under that account's own private directory
 * (`seek-bot/data/users/<userId>/resumes|knowledge/`) instead of the single
 * shared `seek-bot/data/resumes|knowledge/` every account used to share.
 */

const RESUME_EXT = new Set(['.pdf', '.doc', '.docx', '.rtf', '.txt']);
const KNOWLEDGE_EXT = new Set(['.pdf', '.doc', '.docx', '.txt', '.md', '.json', '.csv', '.rtf']);
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Strips any path component from a client-supplied name.
 * The upload endpoints are local-only, but a name like `../../.env` would
 * otherwise let a request write outside the account's data directory.
 */
function safeName(name: string): string {
  const base = basename(name).replace(/[^\w.\-() ]/g, '_');
  return base.slice(0, 120) || 'file';
}

export interface ResumeRecord {
  id: string;
  label: string;
  fileName: string;
  seekName?: string;
  uploadedAt: string;
  size: number;
  notes?: string;
  isDefault?: boolean;
}

export interface KnowledgeItem {
  id: string;
  label: string;
  kind: 'file' | 'note';
  fileName?: string;
  text?: string;
  addedAt: string;
  size?: number;
  enabled: boolean;
}

// ---------------------------------------------------------------- résumés

interface ResumeRow {
  id: string;
  label: string;
  file_name: string;
  seek_name: string | null;
  size_bytes: number;
  is_default: boolean;
  notes: string;
  uploaded_at: Date | string;
}

function rowToResume(r: ResumeRow): ResumeRecord {
  return {
    id: r.id,
    label: r.label,
    fileName: r.file_name,
    seekName: r.seek_name ?? undefined,
    uploadedAt: new Date(r.uploaded_at).toISOString(),
    size: r.size_bytes,
    notes: r.notes || undefined,
    isDefault: r.is_default,
  };
}

export async function listResumes(userId: string): Promise<ResumeRecord[]> {
  const rows = await query<ResumeRow>(
    `SELECT id::text AS id, label, file_name, seek_name, size_bytes, is_default, notes, uploaded_at
       FROM resumes WHERE user_id = $1 ORDER BY uploaded_at`,
    [userId],
  );
  return rows.map(rowToResume);
}

export async function addResume(
  userId: string,
  input: { fileName: string; label?: string; base64: string; notes?: string },
): Promise<{ ok: boolean; error?: string; resume?: ResumeRecord }> {
  const name = safeName(input.fileName);
  const ext = extname(name).toLowerCase();
  if (!RESUME_EXT.has(ext)) {
    return { ok: false, error: `Unsupported type "${ext}". Use PDF, DOC, DOCX, RTF or TXT.` };
  }
  const buf = Buffer.from(input.base64, 'base64');
  if (!buf.length) return { ok: false, error: 'Empty file.' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'File is larger than 8 MB.' };

  ensureUserDataDir(userId);
  const resumeDir = userResumeDir(userId);
  const all = await listResumes(userId);
  // Keep the on-disk name unique without mangling what the user recognises.
  let fileName = name;
  let n = 1;
  while (existsSync(resolve(resumeDir, fileName))) {
    const stem = name.replace(ext, '');
    fileName = `${stem} (${n++})${ext}`;
  }
  writeFileSync(resolve(resumeDir, fileName), buf);

  const row = await one<{ id: string }>(
    `INSERT INTO resumes (user_id, label, file_name, size_bytes, is_default, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text AS id`,
    [
      userId,
      (input.label || name.replace(ext, '')).slice(0, 80),
      fileName,
      buf.length,
      all.length === 0,
      (input.notes ?? '').slice(0, 500),
    ],
  );
  if (!row) return { ok: false, error: 'Could not save the résumé.' };

  return {
    ok: true,
    resume: {
      id: row.id,
      label: (input.label || name.replace(ext, '')).slice(0, 80),
      fileName,
      uploadedAt: new Date().toISOString(),
      size: buf.length,
      notes: input.notes?.slice(0, 500),
      isDefault: all.length === 0,
    },
  };
}

export async function updateResume(
  userId: string,
  id: string,
  patch: Partial<ResumeRecord>,
): Promise<ResumeRecord[]> {
  if (patch.isDefault) {
    await query(`UPDATE resumes SET is_default = false WHERE user_id = $1`, [userId]);
  }
  await query(
    `UPDATE resumes SET
       label = COALESCE($3, label),
       notes = COALESCE($4, notes),
       seek_name = COALESCE($5, seek_name),
       is_default = COALESCE($6, is_default)
     WHERE user_id = $1 AND id = $2`,
    [userId, id, patch.label ?? null, patch.notes ?? null, patch.seekName ?? null, patch.isDefault ?? null],
  );
  return listResumes(userId);
}

export async function deleteResume(userId: string, id: string): Promise<ResumeRecord[]> {
  const all = await listResumes(userId);
  const target = all.find((r) => r.id === id);
  if (target) {
    const path = resolve(userResumeDir(userId), target.fileName);
    if (existsSync(path)) unlinkSync(path);
  }
  await query(`DELETE FROM resumes WHERE user_id = $1 AND id = $2`, [userId, id]);
  const next = await listResumes(userId);
  // Never leave the library without a default.
  if (target?.isDefault && next.length) {
    await query(`UPDATE resumes SET is_default = true WHERE user_id = $1 AND id = $2`, [userId, next[0].id]);
    next[0].isDefault = true;
  }
  return next;
}

// -------------------------------------------------------------- knowledge

interface KnowledgeRow {
  id: string;
  label: string;
  kind: 'file' | 'note';
  file_name: string | null;
  body: string | null;
  size_bytes: number;
  enabled: boolean;
  added_at: Date | string;
}

function rowToKnowledge(r: KnowledgeRow): KnowledgeItem {
  return {
    id: r.id,
    label: r.label,
    kind: r.kind,
    fileName: r.file_name ?? undefined,
    text: r.body ?? undefined,
    addedAt: new Date(r.added_at).toISOString(),
    size: r.size_bytes,
    enabled: r.enabled,
  };
}

export async function listKnowledge(userId: string): Promise<KnowledgeItem[]> {
  const rows = await query<KnowledgeRow>(
    `SELECT id::text AS id, label, kind, file_name, body, size_bytes, enabled, added_at
       FROM knowledge_items WHERE user_id = $1 ORDER BY added_at`,
    [userId],
  );
  return rows.map(rowToKnowledge);
}

export async function addKnowledgeFile(
  userId: string,
  input: { fileName: string; label?: string; base64: string },
): Promise<{ ok: boolean; error?: string; item?: KnowledgeItem }> {
  const name = safeName(input.fileName);
  const ext = extname(name).toLowerCase();
  if (!KNOWLEDGE_EXT.has(ext)) {
    return { ok: false, error: `Unsupported type "${ext}".` };
  }
  const buf = Buffer.from(input.base64, 'base64');
  if (!buf.length) return { ok: false, error: 'Empty file.' };
  if (buf.length > MAX_BYTES) return { ok: false, error: 'File is larger than 8 MB.' };

  ensureUserDataDir(userId);
  const knowledgeDir = userKnowledgeDir(userId);
  let fileName = name;
  let n = 1;
  while (existsSync(resolve(knowledgeDir, fileName))) {
    const stem = name.replace(ext, '');
    fileName = `${stem} (${n++})${ext}`;
  }
  writeFileSync(resolve(knowledgeDir, fileName), buf);

  const label = (input.label || name.replace(ext, '')).slice(0, 80);
  const row = await one<{ id: string }>(
    `INSERT INTO knowledge_items (user_id, label, kind, file_name, size_bytes, enabled)
     VALUES ($1,$2,'file',$3,$4,true) RETURNING id::text AS id`,
    [userId, label, fileName, buf.length],
  );
  if (!row) return { ok: false, error: 'Could not save the file.' };

  return {
    ok: true,
    item: { id: row.id, label, kind: 'file', fileName, addedAt: new Date().toISOString(), size: buf.length, enabled: true },
  };
}

export async function addKnowledgeNote(
  userId: string,
  input: { label: string; text: string },
): Promise<KnowledgeItem> {
  const label = input.label.slice(0, 80) || 'Note';
  const text = input.text.slice(0, 20_000);
  const row = await one<{ id: string }>(
    `INSERT INTO knowledge_items (user_id, label, kind, body, size_bytes, enabled)
     VALUES ($1,$2,'note',$3,$4,true) RETURNING id::text AS id`,
    [userId, label, text, text.length],
  );
  return {
    id: row?.id ?? '',
    label,
    kind: 'note',
    text,
    addedAt: new Date().toISOString(),
    size: text.length,
    enabled: true,
  };
}

export async function updateKnowledge(
  userId: string,
  id: string,
  patch: Partial<KnowledgeItem>,
): Promise<KnowledgeItem[]> {
  await query(
    `UPDATE knowledge_items SET
       label = COALESCE($3, label),
       body = COALESCE($4, body),
       enabled = COALESCE($5, enabled)
     WHERE user_id = $1 AND id = $2`,
    [userId, id, patch.label ?? null, patch.text ?? null, patch.enabled ?? null],
  );
  return listKnowledge(userId);
}

export async function deleteKnowledge(userId: string, id: string): Promise<KnowledgeItem[]> {
  const all = await listKnowledge(userId);
  const target = all.find((i) => i.id === id);
  if (target?.fileName) {
    const path = resolve(userKnowledgeDir(userId), target.fileName);
    if (existsSync(path)) unlinkSync(path);
  }
  await query(`DELETE FROM knowledge_items WHERE user_id = $1 AND id = $2`, [userId, id]);
  return listKnowledge(userId);
}

export async function resolveStored(
  userId: string,
  kind: 'resume' | 'knowledge',
  id: string,
): Promise<{ path: string; fileName: string; label: string } | null> {
  if (kind === 'resume') {
    const r = (await listResumes(userId)).find((x) => x.id === id);
    if (!r) return null;
    return { path: resolve(userResumeDir(userId), r.fileName), fileName: r.fileName, label: r.label };
  }
  const i = (await listKnowledge(userId)).find((x) => x.id === id);
  if (!i?.fileName) return null;
  return { path: resolve(userKnowledgeDir(userId), i.fileName), fileName: i.fileName, label: i.label };
}

export const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Loads seek-bot's compiled, stateless text extractor — a pure function of a file path. */
async function extractor() {
  return import(/* @vite-ignore */ new URL('../../seek-bot/dist/knowledge.js', import.meta.url).href) as Promise<{
    extractText(path: string): Promise<string>;
  }>;
}

/**
 * Extracts readable text using the bot's own extractor, so the preview shows
 * exactly what the model receives rather than a second implementation that
 * might differ.
 */
export async function previewText(
  userId: string,
  kind: 'resume' | 'knowledge',
  id: string,
): Promise<{ ok: boolean; text?: string; label?: string; error?: string }> {
  if (kind === 'knowledge') {
    const item = (await listKnowledge(userId)).find((x) => x.id === id);
    if (item?.kind === 'note') return { ok: true, text: item.text ?? '', label: item.label };
  }
  const found = await resolveStored(userId, kind, id);
  if (!found || !existsSync(found.path)) return { ok: false, error: 'File not found.' };

  try {
    const mod = await extractor();
    const text = await mod.extractText(found.path);
    if (!text.trim()) {
      return {
        ok: true,
        label: found.label,
        text: `(No text could be extracted from ${found.fileName}.\nThe application assistant cannot use content from this file — add a note with the key details instead.)`,
      };
    }
    return { ok: true, text, label: found.label };
  } catch (e) {
    return {
      ok: false,
      error: `Could not extract text: ${(e as Error).message}. Is seek-bot built? Run \`npm run build\` there.`,
    };
  }
}

const CONTEXT_MAX_CHARS = 14_000;
const CONTEXT_PER_ITEM_CHARS = 6_000;

/**
 * The exact assembled block handed to the model — a per-user reimplementation
 * of seek-bot's own `buildKnowledgeContext()`.
 *
 * It cannot simply call that function: `buildKnowledgeContext()` resolves
 * files off the single process-wide `config.dataDir`, which only ever names
 * one account's knowledge folder for the lifetime of this long-running
 * dashboard server. That is fine for a spawned per-run child (fresh process,
 * fresh env var) but wrong here, where one process answers requests for many
 * accounts — so this rebuilds the same assembly logic against this specific
 * account's Postgres rows and directory instead.
 */
export async function fullContext(userId: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const items = (await listKnowledge(userId)).filter((i) => i.enabled);
    if (!items.length) return { ok: true, text: '' };
    const mod = await extractor();
    const chunks: string[] = [];
    let budget = CONTEXT_MAX_CHARS;

    for (const item of items) {
      if (budget <= 0) break;
      let body = '';
      if (item.kind === 'note') {
        body = item.text ?? '';
      } else if (item.fileName) {
        body = await mod.extractText(resolve(userKnowledgeDir(userId), item.fileName)).catch(() => '');
        if (!body.trim()) {
          body = `(could not extract text from ${item.fileName} — add a note with the key details instead)`;
        }
      }
      body = body.replace(/\s+\n/g, '\n').trim();
      if (!body) continue;
      const slice = body.slice(0, Math.min(budget, CONTEXT_PER_ITEM_CHARS));
      budget -= slice.length;
      chunks.push(`### ${item.label}\n${slice}`);
    }

    return { ok: true, text: chunks.join('\n\n') };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Byte size of the extractable context, for the "what the AI sees" preview. */
export async function knowledgeStats(userId: string) {
  const items = await listKnowledge(userId);
  const enabled = items.filter((i) => i.enabled);
  const bytes = enabled.reduce((sum, i) => {
    if (i.kind === 'note') return sum + (i.text?.length ?? 0);
    const p = i.fileName ? resolve(userKnowledgeDir(userId), i.fileName) : '';
    return sum + (p && existsSync(p) ? statSync(p).size : 0);
  }, 0);
  return { total: items.length, enabled: enabled.length, bytes };
}
