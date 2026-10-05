import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askCelerisForJson } from '../search-terms.js';
import { envReport } from '../env-settings.js';
import { createBlogModel, writerConfig, type WriterConfig } from './models.js';
import { writePost, type Article } from './writer.js';
import type { Brief } from './signals.js';

const celeris: WriterConfig = { provider: 'celeris', apiKey: 'test-celeris-key', model: 'celeris-1-magnus' };
const gemini: WriterConfig = { provider: 'gemini', apiKey: 'test-gemini-key', model: 'gemini-3.8-flash' };
const schema = { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] };
const completion = (value: unknown, finish_reason = 'stop') => Response.json({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] });
const geminiReply = (value: unknown, finishReason = 'STOP') => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: 'not JSON: private reasoning', thought: true }, { text: JSON.stringify(value) }] } }] });

test('Celeris caps the multiplied blog budget and rejects even valid-looking truncated JSON', async (t) => {
  let budget = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    budget = JSON.parse(init.body as string).max_tokens;
    return completion({ approved: true }, 'length');
  });
  const result = await askCelerisForJson(celeris.apiKey, 'system', 'prompt', schema, 0, { maxOutputTokens: 32_768 });
  assert.equal(budget, 16_384);
  assert.equal(result.ok, false);
  assert.equal(result.tokenLimitReached, true);
});

test('Auto keeps Celeris when it completes successfully', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => { urls.push(String(url)); return completion({ approved: true }); });
  const model = createBlogModel({ ...celeris, fallback: gemini });
  assert.deepEqual(await model.ask('system', 'prompt', schema, 0), { approved: true });
  assert.equal(model.model(), celeris.model);
  assert.equal(urls.length, 1);
});

test('A token limit switches to Gemini with the same prompt and schema, and stays there', async (t) => {
  const requests: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(init.body as string) });
    return requests.length === 1 ? completion({}, 'length') : geminiReply({ approved: true });
  });
  const model = createBlogModel({ ...celeris, fallback: gemini });
  assert.deepEqual(await model.ask('system', 'draft', schema, 0.7), { approved: true });
  await model.ask('review system', 'review', schema, 0.1);
  assert.equal(model.model(), gemini.model);
  assert.equal(requests.length, 3);
  assert.match(requests[1].url, /generativelanguage.googleapis.com/);
  assert.match(requests[2].url, /generativelanguage.googleapis.com/);
  assert.deepEqual(requests[1].body.systemInstruction.parts, [{ text: 'system' }]);
  assert.equal(requests[1].body.contents[0].parts[0].text, 'draft');
  assert.deepEqual(requests[1].body.generationConfig.responseJsonSchema, schema);
  assert.equal(requests[1].body.generationConfig.maxOutputTokens, 32_768);
});

test('A serving-endpoint output-limit rejection also falls back; an auth failure does not', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ error: { message: 'The requested output token limit exceeds this model maximum.' } }, { status: 400 })
    : geminiReply({ approved: true }));
  const model = createBlogModel({ ...celeris, fallback: gemini });
  await model.ask('system', 'prompt', schema, 0);
  assert.equal(calls, 2);
  t.mock.restoreAll();
  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('invalid key', { status: 401 }); });
  await assert.rejects(createBlogModel({ ...celeris, fallback: gemini }).ask('system', 'prompt', schema, 0), /HTTP 401/);
  assert.equal(calls, 1);
});

test('Without a Gemini fallback the token-limit error explains how to configure it', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => completion({}, 'length'));
  await assert.rejects(createBlogModel(celeris).ask('system', 'prompt', schema, 0), /GEMINI_API_KEY/);
});

test('Gemini refuses incomplete or blocked responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => geminiReply({ approved: true }, 'MAX_TOKENS'));
  await assert.rejects(createBlogModel(gemini).ask('system', 'prompt', schema, 0), /MAX_TOKENS/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } }));
  await assert.rejects(createBlogModel(gemini).ask('system', 'prompt', schema, 0), /SAFETY/);
});

test('Provider settings honor explicit choices, support Gemini alone, and mask its key', (t) => {
  const names = ['BLOG_PROVIDER', 'CELERIS_API_KEY', 'GEMINI_API_KEY', 'BLOG_GEMINI_MODEL'];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => names.forEach((name) => { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }));
  process.env.CELERIS_API_KEY = celeris.apiKey;
  process.env.GEMINI_API_KEY = gemini.apiKey;
  process.env.BLOG_GEMINI_MODEL = '';
  process.env.BLOG_PROVIDER = 'auto';
  assert.equal(writerConfig()?.fallback?.provider, 'gemini');
  process.env.BLOG_PROVIDER = 'celeris';
  assert.equal(writerConfig()?.fallback, undefined);
  process.env.BLOG_PROVIDER = 'gemini';
  assert.equal(writerConfig()?.provider, 'gemini');
  process.env.BLOG_PROVIDER = 'auto';
  process.env.CELERIS_API_KEY = '';
  assert.equal(writerConfig()?.provider, 'gemini');
  process.env.GEMINI_API_KEY = '';
  assert.equal(writerConfig(), null);
  process.env.GEMINI_API_KEY = gemini.apiKey;
  const entry = envReport().groups.flatMap((group) => group.entries).find((entry) => entry.key === 'GEMINI_API_KEY');
  assert.equal(entry?.value, null);
});

const words = Array.from({ length: 210 }, () => 'evidence').join(' ');
const article: Article = {
  title: 'Australian job seekers: planning your next move', slug: 'planning-your-next-move',
  metaDescription: 'What Australian job seekers can learn from the latest labour-market releases, and practical steps for planning their next application.',
  focusKeyword: 'jobs australia', targetSearches: ['jobs australia'], lead: 'Read these releases [S1, S2, S3].',
  sections: Array.from({ length: 4 }, (_, index) => ({ heading: `Section ${index}`, paragraphs: [`${words} [S1, S2, S3]`], bullets: [] })),
  takeaways: ['One', 'Two', 'Three'],
};
const brief: Brief = {
  week: '2026-10-05', gatheredAt: '2026-10-05T00:00:00Z',
  searches: [{ seed: 'jobs', suggestion: 'jobs australia', rank: 1, isNew: false }],
  sources: [1, 2, 3].map((n) => ({ ref: `S${n}`, publisher: 'ABS', title: 'Release', url: `https://example.test/${n}`, published: null, excerpt: 'Evidence' })),
  listingSample: null, unavailable: [],
};

test('Fallback preserves fact-checking and revisions and records the model actually used', async (t) => {
  const values = [article, { approved: false, issues: [{ excerpt: 'Read', problem: 'Unclear', fix: 'Clarify' }] }, article, { approved: true, issues: [] }];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? completion({}, 'length') : geminiReply(values.shift()));
  const result = await writePost(brief, ['An earlier angle'], { ...celeris, fallback: gemini });
  assert.equal(result.model, gemini.model);
  assert.equal(result.revisions.length, 1);
  assert.equal(calls, 5);
});

test('A draft that never passes fact-checking is never returned for publishing', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    return geminiReply(request.generationConfig.responseJsonSchema.properties.approved
      ? { approved: false, issues: [{ excerpt: 'Read', problem: 'Unsupported', fix: 'Remove' }] } : article);
  });
  await assert.rejects(writePost(brief, [], gemini), /Not published/);
});
