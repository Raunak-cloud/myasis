import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { relevantEvidence } from './pipeline.js';
import { config } from './config.js';

export interface KnowledgeItem {
  id: string;
  /** Short title shown in the dashboard, e.g. "Full CV" or "Visa details". */
  label: string;
  kind: 'file' | 'note';
  /** For kind==='file': name inside data/knowledge/. */
  fileName?: string;
  /** For kind==='note': the text itself. */
  text?: string;
  addedAt: string;
  size?: number;
  enabled: boolean;
}

const MANIFEST = resolve(config.dataDir, 'knowledge.json');
const ANSWERS = resolve(config.dataDir, 'answers.json');

export interface SavedAnswer {
  question: string;
  answer: string;
}

/**
 * Answers the candidate gave in the dashboard to questions the profile could
 * not cover ("Why do you want to work here?", "Which store location?"). Kept
 * out of the relevance filter on purpose: an answer bank is small and every
 * entry may apply to any job.
 */
export function loadSavedAnswers(): SavedAnswer[] {
  if (!existsSync(ANSWERS)) return [];
  try {
    const raw = JSON.parse(readFileSync(ANSWERS, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is SavedAnswer => Boolean(item && typeof item === 'object' && typeof (item as SavedAnswer).question === 'string' && typeof (item as SavedAnswer).answer === 'string'))
      .filter((item) => item.question.trim() && item.answer.trim())
      .slice(0, 200);
  } catch {
    return [];
  }
}
export const KNOWLEDGE_DIR = resolve(config.dataDir, 'knowledge');

export function loadKnowledge(): KnowledgeItem[] {
  if (!existsSync(MANIFEST)) return [];
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8')) as KnowledgeItem[];
  } catch {
    return [];
  }
}

/** Extracts plain text from the formats a job-seeker actually keeps documents in. */
export async function extractText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (!existsSync(path)) return '';

  if (ext === '.txt' || ext === '.md' || ext === '.json' || ext === '.csv') {
    return readFileSync(path, 'utf8');
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ path });
    return value;
  }
  if (ext === '.pdf') {
    const mod: any = await import('pdf-parse-fork');
    const pdf = mod.default ?? mod;
    const parsed = await pdf(readFileSync(path));
    return parsed?.text ?? '';
  }
  // .doc and anything else: no reliable text extraction without heavier tooling.
  return '';
}

const MAX_CHARS = 14_000;
let contextCache: { signature: string; value: string } | null = null;

function contextSignature(items: KnowledgeItem[]): string {
  const files = items
    .filter((item) => item.kind === 'file' && item.fileName)
    .map((item) => {
      const path = resolve(KNOWLEDGE_DIR, item.fileName!);
      try {
        const stat = statSync(path);
        return `${item.id}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${item.id}:missing`;
      }
    });
  try {
    const manifest = statSync(MANIFEST);
    return `${manifest.size}:${manifest.mtimeMs}|${files.join('|')}`;
  } catch {
    return `missing|${files.join('|')}`;
  }
}

/**
 * Builds the extra-context block handed to the model.
 *
 * This is supplementary evidence for questions `profile.txt` cannot answer — a
 * detailed CV, certifications, visa paperwork, referee details. It is the
 * user's own material, so it is trusted more than a job ad, but it is still
 * *evidence*, not instructions: the caller wraps it accordingly and the model
 * is told it may only ground answers in it, never take direction from it.
 */
export async function buildKnowledgeContext(query = ''): Promise<string> {
  const items = loadKnowledge().filter((i) => i.enabled);
  if (!items.length) return '';

  const signature = contextSignature(items);
  if (contextCache?.signature === signature) return relevantEvidence(contextCache.value, query, MAX_CHARS);

  // Document extraction is independent per item. Running it concurrently
  // removes repeated PDF/DOCX latency while preserving manifest order below.
  const bodies = await Promise.all(
    items.map(async (item) => {
      if (item.kind === 'note') return item.text ?? '';
      if (!item.fileName) return '';
      const body = await extractText(resolve(KNOWLEDGE_DIR, item.fileName)).catch(() => '');
      return body.trim()
        ? body
        : `(could not extract text from ${item.fileName} — add a note with the key details instead)`;
    }),
  );

  const chunks: string[] = [];
  let budget = 300_000;

  for (let i = 0; i < items.length; i++) {
    if (budget <= 0) break;
    const item = items[i];
    let body = bodies[i];
    body = body.replace(/\s+\n/g, '\n').trim();
    if (!body) continue;
    const slice = body.slice(0, Math.min(budget, 60_000));
    budget -= slice.length;
    chunks.push(`### ${item.label}\n${slice}`);
  }

  const value = chunks.join('\n\n');
  contextCache = { signature, value };
  return relevantEvidence(value, query, MAX_CHARS);
}

/** Cheap synchronous check so callers can skip the async build entirely. */
export function hasKnowledge(): boolean {
  return loadKnowledge().some((i) => i.enabled);
}
