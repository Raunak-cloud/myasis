import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chatCompletion, humanizerEndpoint, probeHumanizer } from '../dist/humanizer-endpoint.js';

// A stand-in for a hosted API shaped like Featherless, and for a local llama.cpp. Nothing real is contacted.
const seen = [];
let tier = 'warm';
let busy = 0;
const server = createServer((request, response) => {
  seen.push({ method: request.method, url: request.url, auth: request.headers.authorization ?? null });
  const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.url === '/health') return reply(200, { status: 'ok' });
  if (request.headers.authorization !== 'Bearer good-key') return reply(401, { error: { message: 'You must be signed in to access this resource', code: 'unauthorized' } });
  if (request.url === '/v1/models/authormist%2Fauthormist-originality') return reply(200, { id: 'authormist/authormist-originality', availability: { tier } });
  if (request.url.startsWith('/v1/models/')) return reply(404, { error: { message: 'not found' } });
  if (request.url === '/v1/chat/completions') {
    let raw = '';
    request.on('data', chunk => (raw += chunk));
    return request.on('end', () => (busy-- > 0
      ? reply(429, { error: { message: 'Concurrency limit exceeded' } })
      : reply(200, { choices: [{ message: { content: `model=${JSON.parse(raw).model}` } }], echo: JSON.parse(raw) })));
  }
  reply(404, {});
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const hosted = humanizerEndpoint({ HUMANIZER_URL: `${base}/v1/`, HUMANIZER_API_KEY: 'good-key', HUMANIZER_MODEL: 'authormist/authormist-originality' });
  assert.deepEqual(hosted, { base, apiKey: 'good-key', model: 'authormist/authormist-originality' }, 'a pasted /v1 base is normalised');
  const local = humanizerEndpoint({ HUMANIZER_URL: `${base}/` });
  assert.deepEqual(local, { base, apiKey: undefined, model: 'authormist-originality' }, 'a keyless endpoint is a llama.cpp server');
  assert.equal(humanizerEndpoint({}), null, 'nothing configured means no endpoint');

  assert.deepEqual(await probeHumanizer(hosted), { ready: true, detail: 'model warm' });
  tier = 'cold';
  assert.equal((await probeHumanizer(hosted)).ready, false, 'a cold model is not ready');
  tier = 'warm';
  assert.match((await probeHumanizer({ ...hosted, apiKey: 'bad-key' })).detail, /key was refused/);
  assert.match((await probeHumanizer({ ...hosted, model: 'someone/else' })).detail, /does not serve/);
  assert.equal((await probeHumanizer(local)).ready, true, 'a keyless endpoint is asked for /health');
  assert.equal(seen.at(-1).url, '/health');
  assert.equal(seen.at(-1).auth, null);
  assert.equal((await probeHumanizer({ base: 'http://127.0.0.1:1', model: 'x' }, 1_000)).ready, false, 'an unreachable endpoint is not ready, not an exception');

  busy = 2;
  const before = seen.length;
  const reply = await chatCompletion(hosted, { messages: [{ role: 'user', content: 'hi' }] }, Date.now() + 30_000);
  assert.equal(reply.status, 200, 'a plan at its concurrency limit is retried, not failed');
  const served = await reply.json();
  assert.equal(served.choices[0].message.content, 'model=authormist/authormist-originality');
  assert.deepEqual([served.echo.top_k, served.echo.min_p, served.echo.repetition_penalty], [40, 0.05, 1], 'the sampling defaults of llama.cpp are sent, not left to the server');
  assert.equal(seen.length - before, 3, 'two refusals, then served');
  const tuned = await (await chatCompletion(hosted, { messages: [], top_k: 20 }, Date.now() + 5_000)).json();
  assert.equal(tuned.echo.top_k, 20, 'a value the caller sets wins');

  busy = 9;
  assert.equal((await chatCompletion(hosted, { messages: [] }, Date.now() + 2_000)).status, 429, 'retries stop at the caller\'s deadline');
  busy = 0;
  assert.equal((await chatCompletion({ ...hosted, apiKey: 'bad-key' }, { messages: [] }, Date.now() + 5_000)).status, 401, 'a refused key is not retried');

  console.log('PASS: endpoint normalisation, pinned sampling, warm/cold/401/404 probes, llama.cpp health, 429 retry, deadline, no retry on 401');
} finally {
  server.close();
}
