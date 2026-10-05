import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleHash, assertBlogHumanizerReady, blogHumanizerConfig, humanizeArticle, humanizedTextProblem, type BlogHumanizerConfig } from './humanizer.js';
import { prepareForPublication } from './publication.js';
import type { Article } from './writer.js';
import type { Brief } from './signals.js';

const config: BlogHumanizerConfig = { endpoint: { base: 'https://api.featherless.ai', apiKey: 'test-key', model: 'authormist/authormist-originality' }, timeoutMs: 10_000, repetitionPenalty: 1.05, topK: 40 };
const text = 'The unemployment rate increased to 4.6% in August 2026 [S1].';
test('Cover-letter settings cannot disable or make blog humanizing optional', async (t) => {
  const values = { HUMANIZER_URL: config.endpoint.base, HUMANIZER_API_KEY: config.endpoint.apiKey!, HUMANIZER_MODEL: config.endpoint.model, HUMANIZER_MODE: 'off', HUMANIZER_REQUIRED: 'false' };
  const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  t.after(() => Object.keys(values).forEach((name) => { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }));
  Object.assign(process.env, values);
  assert.equal((await blogHumanizerConfig())?.endpoint.model, config.endpoint.model);
  process.env.HUMANIZER_API_KEY = '';
  assert.equal(await blogHumanizerConfig(), null);
});

test('Unavailable humanizer readiness prevents blog generation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Refused', { status: 403 }));
  await assert.rejects(assertBlogHumanizerReady(config), /Not published.*unavailable.*key was refused/);
});

test('Humanizing rejects changed or dropped figures, citations and unchanged text', () => {
  assert.equal(humanizedTextProblem(text, 'In August 2026, unemployment rose to 4.6% [S1].'), null);
  assert.match(humanizedTextProblem(text, text)!, /unchanged/);
  assert.match(humanizedTextProblem(text, 'Unemployment rose to 4.7% in August 2026 [S1].')!, /figure/);
  assert.match(humanizedTextProblem(text, 'Unemployment rose in August 2026 [S1].')!, /figure/);
  assert.match(humanizedTextProblem(text, 'In August 2026, unemployment rose to 4.6% [S2].')!, /citation/);
  assert.match(humanizedTextProblem(text, 'In August 2026, unemployment rose to 4.6%.')!, /citation/);
});

const paragraph = `Evidence supports the latest changes ${Array.from({ length: 210 }, () => 'information').join(' ')} [S1, S2, S3].`;
const article: Article = {
  title: 'Jobs in Australia: planning your next move', slug: 'planning-your-next-move',
  metaDescription: 'What Australian job seekers can learn from the latest labour-market releases, and practical steps for planning their next application.',
  focusKeyword: 'jobs australia', targetSearches: ['jobs australia'], lead: text,
  sections: Array.from({ length: 4 }, (_, i) => ({ heading: `Section ${i}`, paragraphs: [paragraph], bullets: ['Evidence supports these practical actions.'] })),
  takeaways: ['Evidence supports these important findings.'],
};
const brief: Brief = {
  week: '2026-10-05', gatheredAt: '2026-10-05T00:00:00Z',
  searches: [{ seed: 'jobs', suggestion: 'jobs australia', rank: 1, isNew: false }],
  sources: [1, 2, 3].map((n) => ({ ref: `S${n}`, publisher: 'ABS', title: 'Release', url: `https://example.test/${n}`, published: null, excerpt: 'Evidence' })),
  listingSample: null, unavailable: [],
};
const response = (content: string, finish_reason = 'stop') => Response.json({ choices: [{ finish_reason, message: { content } }] });
const rewritten = (draft: string) => draft === text ? 'In August 2026, unemployment rose to 4.6% [S1].' : draft.replace('Evidence supports', 'Research backs');

function humanizerReply(init: RequestInit) {
  const request = JSON.parse(init.body as string);
  const draft = request.messages[1].content.match(/<draft>\n([\s\S]*)\n<\/draft>/)[1];
  return response(rewritten(draft));
}

test('All blog body passages are humanized, preserving SEO fields and original draft', async (t) => {
  const before = structuredClone(article);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { calls++; return humanizerReply(init); });
  const result = await humanizeArticle(article, config);
  assert.equal(result.blocks, 10);
  assert.equal(calls, 10);
  assert.equal(result.article.lead, rewritten(text));
  assert.equal(result.article.sections[0].paragraphs[0], rewritten(paragraph));
  assert.equal(result.article.sections[0].bullets[0], rewritten(article.sections[0].bullets[0]));
  assert.equal(result.article.takeaways[0], rewritten(article.takeaways[0]));
  for (const field of ['title', 'slug', 'metaDescription', 'focusKeyword', 'targetSearches'] as const) assert.deepEqual(result.article[field], article[field]);
  assert.deepEqual(article, before);
});

test('Humanizer failures never fall back to the raw article', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 403 }));
  await assert.rejects(humanizeArticle(article, config), /Not published.*HTTP 403/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => response('Incomplete', 'length'));
  await assert.rejects(humanizeArticle(article, config), /did not finish/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => response(text));
  await assert.rejects(humanizeArticle(article, config), /returned unchanged/);
});

test('Only a humanized article approved by the final Gemini review can publish', async (t) => {
  let reviewed = false;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (String(url).includes('featherless')) return humanizerReply(init);
    const request = JSON.parse(init.body as string);
    const draft = JSON.parse(request.contents[0].parts[0].text.split('DRAFT\n\n').at(-1));
    assert.equal(draft.lead, rewritten(text));
    reviewed = true;
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ approved: true, issues: [] }) }] } }] });
  });
  const result = await prepareForPublication(article, brief, { provider: 'gemini', apiKey: 'key', model: 'gemini-test' }, config);
  assert.ok(reviewed);
  assert.equal(result.humanization.articleHash, articleHash(result.article));
  assert.equal(result.humanization.articleHash, articleHash(Object.fromEntries(Object.entries(result.article).reverse()) as unknown as Article));
  assert.equal(result.humanization.model, config.endpoint.model);
});

test('A failing final fact-check prevents publication even after successful humanizing', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => String(url).includes('featherless')
    ? humanizerReply(init)
    : Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ approved: false, issues: [{ excerpt: 'Unemployment', problem: 'Changed meaning', fix: 'Preserve meaning' }] }) }] } }] }));
  await assert.rejects(prepareForPublication(article, brief, { provider: 'gemini', apiKey: 'key', model: 'gemini-test' }, config), /Not published.*final fact-check/);
});
