import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envReport } from '../env-settings.js';
import { createBlogModel, writerConfig, type WriterConfig } from './models.js';
import { applyCorrections, writePost, type Article } from './writer.js';
import type { Brief } from './signals.js';

const gemini: WriterConfig = { provider: 'gemini', apiKey: 'test-gemini-key', model: 'gemini-3.5-flash' };
const schema = { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] };
const geminiReply = (value: unknown, finishReason = 'STOP') => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: 'not JSON: private reasoning', thought: true }, { text: JSON.stringify(value) }] } }] });

test('A Gemini failure stops blog writing without calling another provider', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    urls.push(String(url));
    return new Response('High demand', { status: 503 });
  });
  await assert.rejects(createBlogModel(gemini).ask('system', 'prompt', schema, 0), /Gemini returned HTTP 503/);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => /^https:\/\/generativelanguage\.googleapis\.com\//.test(url)));
});

test('A temporary Gemini outage retries the same request and can recover', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('High demand', { status: 503 }) : geminiReply({ approved: true }));
  assert.deepEqual(await createBlogModel(gemini).ask('system', 'prompt', schema, 0), { approved: true });
  assert.equal(calls, 2);
});

test('A Gemini authentication failure is not retried', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('Invalid key', { status: 403 }); });
  await assert.rejects(createBlogModel(gemini).ask('system', 'prompt', schema, 0), /HTTP 403/);
  assert.equal(calls, 1);
});

test('Gemini refuses incomplete or blocked responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => geminiReply({ approved: true }, 'MAX_TOKENS'));
  await assert.rejects(createBlogModel(gemini).ask('system', 'prompt', schema, 0), /MAX_TOKENS/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } }));
  await assert.rejects(createBlogModel(gemini).ask('system', 'prompt', schema, 0), /SAFETY/);
});

test('Blogs always use Gemini, including installs with a legacy Celeris provider setting', (t) => {
  const names = ['BLOG_PROVIDER', 'CELERIS_API_KEY', 'GEMINI_API_KEY', 'BLOG_GEMINI_MODEL'];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => names.forEach((name) => { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }));
  process.env.CELERIS_API_KEY = 'test-celeris-key';
  process.env.GEMINI_API_KEY = gemini.apiKey;
  process.env.BLOG_GEMINI_MODEL = '';
  for (const legacy of ['auto', 'celeris', 'gemini', '']) {
    process.env.BLOG_PROVIDER = legacy;
    assert.equal(writerConfig()?.provider, 'gemini');
    assert.equal(writerConfig()?.model, gemini.model);
  }
  process.env.BLOG_GEMINI_MODEL = 'gemini-custom';
  assert.equal(writerConfig()?.model, 'gemini-custom');
  process.env.GEMINI_API_KEY = '';
  assert.equal(writerConfig(), null);
  const entries = envReport().groups.flatMap((group) => group.entries);
  assert.equal(entries.find((entry) => entry.key === 'GEMINI_API_KEY')?.value, null);
  assert.equal(entries.some((entry) => entry.key === 'BLOG_PROVIDER'), false);
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

test('Gemini handles drafting, fact-checking and every revision', async (t) => {
  const values = [article, { approved: false, issues: [{ excerpt: 'Read', problem: 'Unclear', fix: 'Clarify' }] }, { edits: [{ original: article.lead, replacement: 'Consult these releases [S1, S2, S3].' }] }, { approved: true, issues: [] }];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls++;
    assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\//);
    const request = JSON.parse(init.body as string);
    assert.equal(request.generationConfig.maxOutputTokens, 32_768);
    return geminiReply(values.shift());
  });
  const result = await writePost(brief, ['An earlier angle'], gemini);
  assert.equal(result.model, gemini.model);
  assert.equal(result.revisions.length, 1);
  assert.equal(result.article.lead, 'Consult these releases [S1, S2, S3].');
  assert.deepEqual(result.article.sections, article.sections);
  assert.equal(calls, 4);
});

test('A draft that never passes fact-checking is never returned for publishing', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    const properties = request.generationConfig.responseJsonSchema.properties;
    return geminiReply(properties.approved
      ? { approved: false, issues: [{ excerpt: 'Read', problem: 'Unsupported', fix: 'Remove' }] }
      : properties.edits ? { edits: [{ original: article.lead, replacement: article.lead }] } : article);
  });
  await assert.rejects(writePost(brief, [], gemini), /Not published/);
});

test('Fact-check edits preserve unrelated citations and reject ambiguous or missing originals', () => {
  const corrected = applyCorrections(article, { edits: [{ original: article.lead, replacement: 'Only this supported claim remains [S1].' }] });
  assert.equal(corrected.lead, 'Only this supported claim remains [S1].');
  assert.deepEqual(corrected.sections, article.sections);
  assert.equal(article.lead, 'Read these releases [S1, S2, S3].');
  assert.throws(() => applyCorrections(article, { edits: [{ original: '[S1, S2, S3]', replacement: '[S2]' }] }), /exactly one/);
  assert.throws(() => applyCorrections(article, { edits: [{ original: 'Invented excerpt', replacement: 'Replacement' }] }), /exactly one/);
});
