import { humanizeArticle, humanizationRecord, type BlogHumanizerConfig } from './humanizer.js';
import { publicationProblems, type Article, type WriterConfig } from './writer.js';
import type { Brief } from './signals.js';

/** Both publication paths use this gate. There is no fallback to unhumanized prose. */
export async function prepareForPublication(original: Article, brief: Brief, writer: WriterConfig, humanizer: BlogHumanizerConfig) {
  let notes: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await humanizeArticle(original, humanizer, notes);
    notes = await publicationProblems(brief, original, result.article, writer);
    if (!notes.length) {
      return { article: result.article, humanization: humanizationRecord(result.article, humanizer, result.blocks) };
    }
    console.warn(`[blog] humanized article review ${attempt + 1}/2: ${notes.join(' | ')}`);
  }
  throw new Error(`Not published: the humanized article failed its final fact-check — ${notes.slice(0, 3).join(' | ')}`);
}
