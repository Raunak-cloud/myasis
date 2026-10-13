import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('./content.js', import.meta.url), 'utf8');

function fixture(sendMessage = async () => ({ ok: true, data: { ok: true } })) {
  const panels = [];
  const storage = new Map();
  const context = createContext({
    location: { pathname: '/job/123' },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setInterval: () => {},
    chrome: { runtime: { sendMessage, onMessage: { addListener: () => {} } } },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { innerText: 'Fixture form', appendChild: panel => panels.push(panel) },
      createElement: () => {
        const children = new Map();
        return {
          dataset: {},
          remove() { this.removed = true; },
          querySelector(selector) {
            if (!children.has(selector)) children.set(selector, {});
            return children.get(selector);
          },
        };
      },
    },
  });
  runInContext(source, context);
  return { context, panels, storage, run: code => runInContext(code, context) };
}

test('filling after dismissing the panel attaches a visible panel again', () => {
  const f = fixture();
  f.run('ui()');
  f.panels[0].querySelector('.myasis-x').onclick();
  f.run("say('Reading again')");
  assert.equal(f.panels.length, 2);
  assert.equal(f.panels[0].removed, true);
  assert.equal(f.panels[1].querySelector('.myasis-body').innerHTML, 'Reading again');
});

test('failed recording remains retryable and only confirmed recording suppresses repeats', async () => {
  let attempts = 0;
  const f = fixture(async () => {
    attempts++;
    if (attempts === 1) throw Error('Fixture network failure');
    return { ok: true, data: { ok: attempts > 2 } };
  });
  await f.run('reportSuccess()');
  assert.equal(f.storage.size, 0);
  await f.run('reportSuccess()');
  assert.equal(f.storage.size, 0);
  assert.equal(f.panels[0].dataset.tone, 'warn');
  await f.run('reportSuccess()');
  assert.equal(f.storage.get('myasis-reported-123'), '1');
  await f.run('reportSuccess()');
  assert.equal(attempts, 3);
});

test('page questions and model explanations display as text instead of injected HTML', async () => {
  const f = fixture(async () => ({ ok: true, data: {
    ok: true,
    answers: [{ ref: 'f0', grounded: false, rationale: '<img src=x onerror=alert(1)>' }],
  } }));
  f.run("extractFields = () => [{ ref: 'f0', label: '<script>evil()</script>' }]");
  await f.run('assist()');
  const html = f.panels[0].querySelector('.myasis-body').innerHTML;
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
});

test('server errors cannot inject markup into the panel', async () => {
  const f = fixture(async () => ({ ok: false, error: '<img src=x>' }));
  f.run("extractFields = () => [{ ref: 'f0', label: 'Name' }]");
  await f.run('assist()');
  assert.ok(f.panels[0].querySelector('.myasis-body').innerHTML.includes('&lt;img src=x&gt;'));
});

test('service worker forwards the signed-in dashboard session', async () => {
  let options;
  const context = createContext({
    fetch: async (_url, init) => { options = init; return { ok: true, json: async () => [] }; },
    chrome: { runtime: { onMessage: { addListener: () => {} } } },
  });
  runInContext(readFileSync(new URL('./background.js', import.meta.url), 'utf8'), context);
  await runInContext("callApi('/api/queue')", context);
  assert.equal(options.credentials, 'include');
});
