import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'patchright';
import { EmployerBrowserRouter } from './employer-browser-router.js';

function fixture(url: string) {
  const pages: Page[] = [];
  const context = { pages: () => pages };
  const navigations: string[] = [];
  const page = { url: () => url, context: () => context, isClosed: () => false,
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
  process.env.BRIGHTDATA_BROWSER_ENABLED = 'false'; process.env.EMPLOYER_BROWSER_PROVIDER = 'local';
  assert.equal(await failed.route(local.page), local.page);
});
