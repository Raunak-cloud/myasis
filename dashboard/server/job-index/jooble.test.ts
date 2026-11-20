import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JoobleSearchError, searchJooble } from './jooble.js';

const key = 'example-secret/a+b';
const request = { keywords: 'software engineer', location: 'Sydney NSW', page: 1 };
const firstLink = 'https://au.jooble.org/jdp/5616975719627000837?utm_source=example';
const listing = {
  title: ' Senior <strong>Software Engineer</strong> ',
  company: 'Example Co',
  location: 'Sydney, NSW',
  salary: '140,000 - 160,000 AUD',
  type: 'Full-time',
  source: 'Example Careers',
  link: firstLink,
  snippet: '<script>ignore this</script>',
};

test('uses the Australian API and returns only display fields and pagination', async () => {
  const read: typeof fetch = async (url, options) => {
    assert.equal(url, `https://au.jooble.org/api/${encodeURIComponent(key)}`);
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    assert.equal(options.signal?.aborted, false);
    assert.equal(new Headers(options.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(options.body)), {
      keywords: 'software engineer', location: 'Sydney NSW', page: '2', ResultOnPage: 20,
    });
    return Response.json({ totalCount: 41, jobs: [listing] });
  };
  const result = await searchJooble(key, { keywords: '  software engineer ', location: ' Sydney NSW ', page: 2 }, read);
  assert.deepEqual(result, {
    jobs: [{ title: 'Senior Software Engineer', company: 'Example Co', location: 'Sydney, NSW', salary: listing.salary, type: listing.type, source: listing.source, url: firstLink }],
    page: 2,
    hasMore: true,
  });
  const final = await searchJooble(key, { ...request, page: 3 }, async () => Response.json({ totalCount: 41, jobs: [listing] }));
  assert.equal(final.hasMore, false);
});

test('returns verified Jooble links without duplicate IDs or reflected credentials', async () => {
  const secondLink = 'https://au.jooble.org/desc/-5616975719627000837';
  const result = await searchJooble(key, request, async () => Response.json({
    totalCount: 10,
    jobs: [
      listing,
      { ...listing, link: 'https://au.jooble.org/desc/5616975719627000837' },
      { ...listing, link: `${secondLink}#fragment`, company: `<p>${key}</p>`, salary: null },
      { ...listing, link: `https://au.jooble.org/jdp/1234?value=${encodeURIComponent(key)}` },
      { ...listing, link: `https://au.jooble.org/api/${encodeURIComponent(key)}` },
      { ...listing, link: 'javascript:alert(1)' },
      { ...listing, link: 'http://au.jooble.org/jdp/1' },
      { ...listing, link: 'https://au.jooble.org.evil.invalid/jdp/1' },
      { ...listing, link: 'https://someone@au.jooble.org/jdp/1' },
      { ...listing, link: 'https://us.jooble.org/jdp/1' },
      { ...listing, link: 'https://au.jooble.org/redirect?destination=https://evil.invalid' },
      { ...listing, title: key },
    ],
  }));
  assert.deepEqual(result.jobs.map(job => job.url), [firstLink, secondLink]);
  assert.deepEqual([result.jobs[1].company, result.jobs[1].salary], ['', '']);
  assert.doesNotMatch(JSON.stringify(result), /example-secret/);
});

test('rejects invalid inputs and missing credentials without an upstream request', async () => {
  const shouldNotRead: typeof fetch = async () => assert.fail('should not call Jooble');
  for (const input of [null, [], { ...request, keywords: ' ' }, { ...request, location: 'x'.repeat(161) }, { ...request, page: 0 }, { ...request, page: 1.5 }, { ...request, page: '1' }]) {
    await assert.rejects(searchJooble(key, input, shouldNotRead), { status: 400 });
  }
  for (const invalidKey of ['', '..']) {
    await assert.rejects(searchJooble(invalidKey, request, shouldNotRead), { status: 503 });
  }
});

test('reports quota, access, network, and malformed responses without echoing upstream data', async () => {
  const testCases: [number, typeof fetch][] = [
    [503, async () => new Response(key, { status: 403 })],
    [429, async () => new Response(key, { status: 429 })],
    [502, async () => new Response(key, { status: 500 })],
    [502, async () => new Response(`<html>${key}</html>`)],
    [502, async () => Response.json({ jobs: [], totalCount: key })],
    [502, async (url) => { throw new Error(String(url)); }],
  ];
  for (const [status, read] of testCases) {
    await assert.rejects(searchJooble(key, request, read), error => {
      assert.ok(error instanceof JoobleSearchError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /example-secret|https?:\/\//);
      return true;
    });
  }
  assert.deepEqual(await searchJooble(key, request, async () => Response.json({ jobs: [], totalCount: 0 })), { jobs: [], page: 1, hasMore: false });
});
