import { humanizeArticle, humanizationRecord, type BlogHumanizerConfig } from './humanizer.js';
import { finishHumanizedPost, publicationProblems, type Article, type WriterConfig } from './writer.js';
import type { Brief } from './signals.js';

/** Weekly, extra and rewritten posts publish the Gemini prose after a final source check. */
export async function prepareDirectPublication(original: Article, brief: Brief, writer: WriterConfig) {
  const article = structuredClone(original);
  const problems = await publicationProblems(brief, original, article, writer);
  if (problems.length) throw new Error(`Not published: the article failed its final fact-check — ${problems.slice(0, 3).join(' | ')}`);
  return { article, humanization: null };
}

/** Retained for an explicitly requested style pass, outside automatic blog publication. */
export async function prepareForPublication(original: Article, brief: Brief, writer: WriterConfig, humanizer: BlogHumanizerConfig) {
  const result = await humanizeArticle(original, humanizer);
  return finalizeHumanizedPublication(original, brief, writer, humanizer, result);
}

/** Also used to finish a privately checkpointed, completed humanizer pass. */
export async function finalizeHumanizedPublication(original: Article, brief: Brief, writer: WriterConfig, humanizer: BlogHumanizerConfig, result: Awaited<ReturnType<typeof humanizeArticle>>) {
  const finished = await finishHumanizedPost(brief, original, result.article, writer);
  return { article: finished.article, humanization: { ...humanizationRecord(finished.article, humanizer, result.blocks), factCheckRepairs: finished.repairs } };
}
