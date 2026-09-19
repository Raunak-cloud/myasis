import assert from 'node:assert/strict';

/**
 * The job ranking against a stand-in Celeris that fails the way the real one
 * did in production: a batch too big for its reply comes back as a 400 saying
 * the output "did not parse as JSON ... after one resample". Nothing real is
 * contacted.
 */
process.env.CELERIS_API_KEY ||= 'test-key';
const { rankJobsForReview } = await import('../dist/llm.js');

const profile = { name: 'Test', nationality: 'Australian citizen', phone: '0400000000', email: 't@example.com', expectedSalary: '90000', noticePeriod: '2 weeks', experienceSummary: 'Developer', skills: ['TypeScript'] };
const jobs = Array.from({ length: 45 }, (_, i) => ({ id: `job${i}`, platform: 'indeed', title: `Developer ${i}`, company: `Co ${i}`, location: 'Sydney', url: 'https://x' }));
const REAL_ERROR = '{"error":{"message":"response_format could not be satisfied: the model output did not parse as JSON (or validate against json_schema) after one resample.","type":"BadRequestError","param":null,"code":400},"usage":{"prompt_tokens":3460,"total_tokens":5460,"completion_tokens":2000}}';

let calls = 0;
let mode = 'too-big';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls++;
  const body = JSON.parse(init.body);
  const ids = body.response_format.json_schema.schema.properties.jobs.items.properties.reviewId.enum;
  if (mode === 'down' || (mode === 'down-after-first' && calls > 1)) throw new TypeError('fetch failed');
  if (mode === 'too-big' && ids.length > 5) return new Response(REAL_ERROR, { status: 400 });
  const content = JSON.stringify({ jobs: ids.map((reviewId, i) => ({ reviewId, priority: 90 - i, reason: 'fits' })) });
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { completion_tokens: 10 } }), { status: 200 });
};

try {
  const ranked = await rankJobsForReview(jobs, profile);
  assert.equal(ranked.size, 45, 'a batch Celeris cannot format is split until it can, and every job is still ranked');
  console.log(`PASS  the production error splits the batch instead of losing the run's ranking (${ranked.size}/45 ranked, ${calls} calls)`);

  mode = 'down-after-first'; calls = 0;
  const partial = await rankJobsForReview(jobs, profile);
  assert.equal(partial.size, 20, 'rankings made before Celeris went down are kept');
  console.log(`PASS  rankings already made survive Celeris going down part-way (${partial.size} kept)`);

  mode = 'down'; calls = 0;
  await assert.rejects(rankJobsForReview(jobs, profile), /fetch failed/);
  console.log('PASS  with Celeris down from the start, the caller is told (and falls back to search order)');
} finally {
  globalThis.fetch = realFetch;
}
