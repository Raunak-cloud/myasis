import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareDirectPublication } from './publication.js';
import type { Article, WriterConfig } from './writer.js';
import type { Brief } from './signals.js';

const writer: WriterConfig = { provider: 'gemini', apiKey: 'test-key', model: 'gemini-test' };
const brief: Brief = {
  week: '2026-10-05', gatheredAt: '2026-10-05T00:00:00Z',
  searches: [{ seed: 'jobs', suggestion: 'jobs australia', rank: 1, isNew: false }],
  sources: [1, 2, 3].map((n) => ({ ref: `S${n}`, publisher: 'ABS', title: 'Release', url: `https://example.test/${n}`, published: null, excerpt: 'Evidence' })),
  listingSample: null, unavailable: [],
};
const article: Article = {
  title: 'Jobs in Australia: planning your next move', slug: 'planning-your-next-move',
  metaDescription: 'What Australian job seekers can learn from the latest labour-market releases, and practical steps for planning their next application.',
  focusKeyword: 'jobs australia', targetSearches: ['jobs australia'],
  lead: 'The unemployment rate increased to 4.6% in August 2026 [S1].',
  sections: Array.from({ length: 4 }, (_, i) => ({ heading: `Section ${i}`, paragraphs: [`Evidence supports the latest changes ${Array.from({ length: 210 }, () => 'information').join(' ')} [S1, S2, S3].`], bullets: [] })),
  takeaways: ['Check the evidence before planning your next application.'],
};
const verdict = (approved: boolean) => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ approved, issues: [] }) }] } }] });

test('direct publication preserves Gemini prose and never calls a humanizer', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    calls.push(String(url));
    assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\//);
    return verdict(true);
  });
  const result = await prepareDirectPublication(article, brief, writer);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.article, article);
  assert.notEqual(result.article, article);
  assert.equal(result.humanization, null);
});

test('direct publication still refuses an unapproved source review', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => verdict(false));
  await assert.rejects(prepareDirectPublication(article, brief, writer), /Not published.*final fact-check/);
});

test('direct publication rejects an invalid citation before contacting the writer', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not contact a model'); });
  await assert.rejects(prepareDirectPublication({ ...article, lead: 'An unsupported claim [S99].' }, brief, writer), /Not published.*S99/);
});
