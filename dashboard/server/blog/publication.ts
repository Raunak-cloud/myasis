import { publicationProblems, type Article, type WriterConfig } from './writer.js';
import type { Brief } from './signals.js';

/** Weekly, extra and rewritten posts publish the Gemini prose after a final source check. */
export async function prepareDirectPublication(original: Article, brief: Brief, writer: WriterConfig) {
  const article = structuredClone(original);
  const problems = await publicationProblems(brief, original, article, writer);
  if (problems.length) throw new Error(`Not published: the article failed its final fact-check — ${problems.slice(0, 3).join(' | ')}`);
  return { article };
}
