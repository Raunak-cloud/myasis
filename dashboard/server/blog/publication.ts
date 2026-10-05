import { humanizeArticle, humanizationRecord, type BlogHumanizerConfig } from './humanizer.js';
import { finishHumanizedPost, type Article, type WriterConfig } from './writer.js';
import type { Brief } from './signals.js';

/** Both publication paths use this gate. There is no fallback to unhumanized prose. */
export async function prepareForPublication(original: Article, brief: Brief, writer: WriterConfig, humanizer: BlogHumanizerConfig) {
  const result = await humanizeArticle(original, humanizer);
  return finalizeHumanizedPublication(original, brief, writer, humanizer, result);
}

/** Also used to finish a privately checkpointed, completed humanizer pass. */
export async function finalizeHumanizedPublication(original: Article, brief: Brief, writer: WriterConfig, humanizer: BlogHumanizerConfig, result: Awaited<ReturnType<typeof humanizeArticle>>) {
  const finished = await finishHumanizedPost(brief, original, result.article, writer);
  return { article: finished.article, humanization: { ...humanizationRecord(finished.article, humanizer, result.blocks), factCheckRepairs: finished.repairs } };
}
