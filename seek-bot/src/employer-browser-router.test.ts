import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'patchright';
import { EmployerBrowserRouter } from './employer-browser-router.js';

function fixture(url: string) {
  const pages: Page[] = [];
  const context = { pages: () => pages };
  const navigations: string[] = [];
  const page = { url: () => url, context: () => context, isClosed: () => false,
    waitForLoadState: async () => {},
    goto: async (next: string) => { url = next; navigations.push(next); } } as unknown as Page;
  pages.push(page);
  return { page, pages, navigations, navigate: (next: string) => { url = next; } };
}

test('direct, same-tab and popup employer entry use one private session; job-board storage never crosses', async () => {
  process.env.BRIGHTDATA_BROWSER_ENABLED = 'true';
  process.env.EMPLOYER_BROWSER_PROVIDER = 'local'; // old saved choice is deliberately ignored
  for (const entry of ['direct', 'same-tab', 'popup']) {
    const local = fixture(entry === 'direct' ? 'https://jobs.lever.co/example/1' : 'https://www.seek.com.au/job/123');
    const remote = fixture('about:blank');
    let opens = 0, closes = 0, stops = 0;
    const router = new EmployerBrowserRouter({
      open: async page => { assert.equal(page.context(), local.page.context()); opens++; return { page: remote.page, close: async () => { closes++; } }; },
      guard: async context => { assert.equal(context, remote.page.context()); return { blocked: () => null, stop: async () => { stops++; } }; },
    });
    if (entry !== 'direct') {
      assert.equal(await router.route(local.page), local.page);
      assert.equal(opens, 0, 'signed-in boards remain local');
      if (entry === 'same-tab') local.navigate('https://jobs.lever.co/example/1');
      else {
        const popup = fixture('about:blank');
        // Popup shares the board context; no cookies/storage APIs are exposed by this fixture.
        const tab = { ...popup.page, context: () => local.page.context() } as Page;
        local.pages.push(tab);
        assert.equal(await router.route(local.page), local.page);
        popup.navigate('https://jobs.lever.co/example/1');
      }
    }
    assert.equal(await router.route(local.page), remote.page);
    assert.deepEqual(remote.navigations, ['https://jobs.lever.co/example/1']);
    assert.equal(opens, 1);
    await router.close(); await router.close();
    assert.equal(closes, 1); assert.equal(stops, 1);
  }
});

test('failed employer connection or navigation cannot fall back locally and is cleaned up', async () => {
  process.env.BRIGHTDATA_BROWSER_ENABLED = 'true';
  const local = fixture('https://employer.example/apply');
  const failed = new EmployerBrowserRouter({ open: async () => { throw new Error('provider unavailable'); }, guard: async () => { throw new Error('unused'); } });
  await assert.rejects(failed.route(local.page), /provider unavailable/);
  assert.deepEqual(local.navigations, []);
  const remote = fixture('about:blank'); let closes = 0;
  const router = new EmployerBrowserRouter({ open: async () => ({ page: remote.page, close: async () => { closes++; } }), guard: async () => { throw new Error('blocked destination'); } });
  await assert.rejects(router.route(local.page), /blocked destination/);
  await router.close(); assert.equal(closes, 1);
  let retired = 0;
  const disconnected = new EmployerBrowserRouter({ open: async () => ({ page: remote.page, close: async () => { retired++; throw new Error('already disconnected'); } }), guard: async () => ({ blocked: () => null, stop: async () => { throw new Error('context closed'); } }) });
  await disconnected.route(local.page);
  await disconnected.close(); await disconnected.close();
  assert.equal(retired, 1, 'disconnect cleanup is idempotent and cannot replace a completed outcome');
  process.env.BRIGHTDATA_BROWSER_ENABLED = 'false'; process.env.EMPLOYER_BROWSER_PROVIDER = 'local';
  assert.equal(await failed.route(local.page), local.page);
});

test('an initial empty response retries in a fresh private session, cleans up and never copies local state', async () => {
  process.env.BRIGHTDATA_BROWSER_ENABLED = 'true';
  const local = fixture('https://employer.example/apply');
  const first = fixture('about:blank'), second = fixture('about:blank');
  first.page.goto = async () => { throw new Error('page.goto: net::ERR_EMPTY_RESPONSE'); };
  let opens = 0, closes = 0, stops = 0;
  const pauses: number[] = [];
  const router = new EmployerBrowserRouter({
    open: async page => { assert.equal(page, local.page); return { page: ++opens === 1 ? first.page : second.page, close: async () => { closes++; } }; },
    guard: async () => ({ blocked: () => null, stop: async () => { stops++; } }),
  }, { now: Date.now, pause: async ms => { pauses.push(ms); } });
  assert.equal(await router.route(local.page), second.page);
  assert.equal(opens, 2); assert.equal(closes, 1); assert.equal(stops, 1);
  assert.deepEqual(local.navigations, []);
  assert.deepEqual(second.navigations, ['https://employer.example/apply']);
  assert.deepEqual(pauses, [1000]);
  await router.close(); assert.equal(closes, 2); assert.equal(stops, 2);
});

test('entry retries are bounded and stop on access policy, certificate errors or an exhausted time window', async () => {
  process.env.BRIGHTDATA_BROWSER_ENABLED = 'true';
  for (const scenario of ['transport', 'provider', 'policy', 'certificate', 'deadline', 'closed', 'committed'] as const) {
    const local = fixture('https://employer.example/apply');
    let opens = 0, closes = 0, stops = 0, now = 0;
    const router = new EmployerBrowserRouter({
      open: async () => {
        opens++;
        const remote = fixture('about:blank');
        if (scenario === 'committed') remote.page.waitForLoadState = async () => { throw new Error('net::ERR_EMPTY_RESPONSE after document commit'); };
        remote.page.goto = async () => {
          if (scenario === 'committed') return null;
          if (scenario === 'deadline') now = 125_000;
          if (scenario === 'closed') local.page.isClosed = () => true;
          throw new Error(scenario === 'certificate' ? 'net::ERR_CERT_AUTHORITY_INVALID' : scenario === 'provider' ? 'Protocol error: Client connect timeout (proxy_error)' : 'net::ERR_EMPTY_RESPONSE');
        };
        return { page: remote.page, close: async () => { closes++; } };
      },
      guard: async () => ({ blocked: () => scenario === 'policy' ? 'Destination disallowed' : null, stop: async () => { stops++; } }),
    }, { now: () => now, pause: async () => {} });
    await assert.rejects(router.route(local.page), /ERR_|Client connect timeout/);
    assert.equal(opens, scenario === 'transport' || scenario === 'provider' ? 3 : 1, scenario);
    assert.equal(closes, opens); assert.equal(stops, opens);
    assert.deepEqual(local.navigations, []);
  }
});
