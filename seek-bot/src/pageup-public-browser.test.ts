import assert from 'node:assert/strict';
import test from 'node:test';
import type { Browser, BrowserContext } from 'patchright';
import { renderPublicPageup } from './pageup-public-browser.js';

const url = 'https://careers.fixture.org/jobs/search?query=Data+Analyst&page=2';
type Handler = Parameters<BrowserContext['route']>[1];
function fixture(options: { final?: string; status?: number; delayedLaunch?: number; stalledPage?: boolean } = {}) {
  let closed = 0, handler: Handler;
  let duringNavigation = async () => {};
  const page = {
    goto: async (requested: string, navigation: any) => { assert.equal(requested, url); assert.ok(navigation.timeout > 0 && navigation.timeout <= 30_000); await duringNavigation(); return { status: () =>  options.status ?? 200 }; },
    waitForFunction: async (_: unknown, search: boolean) => { assert.equal(search, true); if (options.stalledPage) await new Promise(() => {}); },
    url: () => options.final ?? url,
    content: async () => '<main>Public search results</main>',
  };
  const browser = {
    newContext: async (settings: any) => {
      assert.equal(settings.storageState, undefined);
      assert.deepEqual(settings, { viewport: null, serviceWorkers: 'block', acceptDownloads: false });
      return { route: async (_: string, fn: Handler) => { handler = fn; }, newPage: async () => page };
    },
    close: async () => { closed++; },
  } as unknown as Browser;
  const launch = async (settings: any) => {
    assert.equal(settings.chromiumSandbox, true);
    assert.equal(settings.userDataDir, undefined);
    if (options.delayedLaunch) await new Promise(resolve => setTimeout(resolve, options.delayedLaunch));
    return browser;
  };
  const validated: string[] = [];
  const validatePublicUrl = async (raw: string) => {
    validated.push(raw);
    if (new URL(raw).hostname === '127.0.0.1') throw Error('Private address');
    return raw;
  };
  async function request(raw: string, method = 'GET', navigation = false) {
    let result = '';
    await handler!({ request: () => ({ url: () => raw, method: () => method, isNavigationRequest: () => navigation }),
      abort: async () => { result = 'blocked'; }, fallback: async () => { result = 'allowed'; } } as any, {} as any);
    return result;
  }
  return { launch, validatePublicUrl, request, validated, closed: () => closed, inspectRoutes: (fn: () => Promise<void>) => { duringNavigation = fn; } };
}

test('public PageUp browser has a disposable sandboxed session and preserves query/page', async () => {
  const f = fixture();
  assert.deepEqual(await renderPublicPageup(url, f), { url, html: '<main>Public search results</main>' });
  assert.ok(f.closed() > 0);
  assert.ok(f.validated.includes(url));
});

test('public PageUp browser validates assets and blocks private hosts, account posts and off-site navigations', async () => {
  const f = fixture();
  f.inspectRoutes(async () => {
    assert.equal(await f.request('https://127.0.0.1/asset'), 'blocked');
    assert.equal(await f.request('https://assets.fixture.org/image.png'), 'allowed');
    assert.equal(await f.request(url, 'POST', true), 'blocked');
    assert.equal(await f.request('https://careers.fixture.org/account', 'POST'), 'blocked');
    assert.equal(await f.request('https://other.fixture.org/jobs/search', 'GET', true), 'blocked');
    assert.equal(await f.request('https://test.token.awswaf.com/verify', 'POST'), 'allowed');
  });
  await renderPublicPageup(url, f);
});

test('public PageUp browser cannot replace the employer or search query and always closes on errors', async () => {
  for (const options of [{ final: 'https://other.fixture.org/jobs/search' }, { final: url.replace('page=2', 'page=1') }, { status: 403 }]) {
    const f = fixture(options);
    await assert.rejects(renderPublicPageup(url, f), /left the requested|HTTP 403/);
    assert.ok(f.closed() > 0);
  }
});

test('public PageUp browser closes stalled operations and a browser that launches after its deadline', async () => {
  for (const options of [{ stalledPage: true }, { delayedLaunch: 80 }]) {
    const f = fixture(options);
    await assert.rejects(renderPublicPageup(url, { ...f, timeoutMs: 25 }), /did not respond/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(f.closed() > 0, 'late browsers must also close');
  }
});

test('public address validation shares the deadline and cannot launch a late browser', async () => {
  let launches = 0;
  const f = fixture();
  await assert.rejects(renderPublicPageup(url, { ...f, timeoutMs: 25,
    validatePublicUrl: async raw => { await new Promise(resolve => setTimeout(resolve, 80)); return raw; },
    launch: async options => { launches++; return f.launch(options); },
  }), /did not respond/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(launches, 0);
});
