import { getPool, query } from '../server/db/index.js';
import { writerConfig } from '../server/blog/models.js';
import { assertBlogHumanizerReady, blogHumanizerConfig } from '../server/blog/humanizer.js';
import { prepareForPublication } from '../server/blog/publication.js';
import { writePost, type Article } from '../server/blog/writer.js';
import type { Brief } from '../server/blog/signals.js';

// Idempotent: preserve addresses, publish dates and an original copy. Each row is
// replaced only after the same humanizing + final-review gate as new posts.
try {
  const writer = writerConfig();
  const humanizer = await blogHumanizerConfig();
  if (!writer || !humanizer) throw new Error('Configure Gemini and Featherless before humanizing existing blogs.');
  await assertBlogHumanizerReady(humanizer);
  const posts = await query<{ id: string; slug: string; article: Article; brief: Brief }>(
    'SELECT id::text, slug, article, brief FROM blog_posts WHERE humanization IS NULL ORDER BY published_at DESC',
  );
  let failed = 0;
  for (const post of posts) {
    try {
      console.log(`Checking and humanizing ${post.slug}…`);
      const verified = await writePost(post.brief, [], writer, post.article);
      const result = await prepareForPublication(verified.article, post.brief, writer, humanizer);
      const saved = await query(
        `UPDATE blog_posts SET article = $2, original_article = coalesce(original_article, $3::jsonb),
          humanization = $4, updated_at = now(), revisions = revisions || $5::jsonb,
          model = CASE WHEN $6 THEN $7 ELSE model END
         WHERE id = $1::bigint AND humanization IS NULL AND article = $3::jsonb RETURNING id`,
        [post.id, result.article, post.article, result.humanization, JSON.stringify(verified.revisions), verified.revisions.length > 0, verified.model],
      );
      if (!saved.length) throw new Error('The post changed during processing; rerun to use its current version.');
      console.log(`Humanized and verified ${post.slug} (${result.humanization.blocks} passages).`);
    } catch (error) {
      failed++;
      console.error(`${post.slug}: ${(error as Error).message}`);
    }
  }
  const [remaining] = await query<{ count: string }>('SELECT count(*)::text AS count FROM blog_posts WHERE humanization IS NULL');
  console.log(`Remaining blogs without humanizing: ${remaining.count}`);
  if (failed || Number(remaining.count)) process.exitCode = 1;
} finally {
  await getPool().end();
}
