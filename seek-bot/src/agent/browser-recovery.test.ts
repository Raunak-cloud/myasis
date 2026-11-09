import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'patchright';
import { ApplicationBrowserRecovery } from './browser-recovery.js';
import type { Observation } from './observe.js';

function fixture() {
  const pages: Page[] = [];
  let created = 0, unavailable = false;
  const context = { pages: () => pages.filter(page => !page.isClosed()), newPage: async () => {
    if (unavailable) throw Error('Browser disconnected');
    created++; return page('about:blank');
  } };
  const page = (url: string) => {
    let closed = false;
    const value = { url: () => url, isClosed: () => closed, context: () => context, close: async () => { closed = true; } } as unknown as Page;
    pages.push(value); return value;
  };
  const entry = page('https://employer.invalid/application');
  const owned = new Set([entry]), recovery = new ApplicationBrowserRecovery(entry, owned);
  const read = async (page: Page): Promise<Observation> => ({ url: page.url(), title: 'Saved application', fields: [], actions: [], text: 'Existing answers retained' });
  return { page, entry, owned, recovery, read, created: () => created, disconnect: () => { unavailable = true; } };
}

test('a popup closing during inspection returns to its live opener without replaying an action', async () => {
  const f = fixture(), popup = f.page('https://identity.invalid/allow'), unrelated = f.page('https://mail.invalid/inbox');
  f.owned.add(unrelated); f.recovery.opened(popup, f.entry);
  const reads: Page[] = [], failures: unknown[] = [];
  const result = await f.recovery.observe(popup, async page => {
    reads.push(page);
    if (page === popup) { await popup.close(); throw Error('Target page has been closed'); }
    return f.read(page);
  }, error => failures.push(error));
  assert.equal(result.page, f.entry); assert.deepEqual(reads, [popup, f.entry]);
  assert.equal(failures.length, 1); assert.match(result.observation.text, /retained/);
  assert.match(result.note!, /No operation was replayed/); assert.equal(f.created(), 0);
});

test('nested sign-in closures preserve the application rather than choosing an unrelated last tab', async () => {
  const f = fixture(), first = f.page('https://identity.invalid/login'), second = f.page('https://provider.invalid/consent');
  f.recovery.opened(first, f.entry); f.recovery.opened(second, first); f.owned.add(f.page('https://mail.invalid/'));
  await first.close(); await second.close();
  const result = await f.recovery.observe(second, f.read, () => assert.fail('closed popup should not be inspected'));
  assert.equal(result.page, f.entry); assert.match(result.note!, /active tab closed/);
});

test('detached frames, renderer errors and timeouts remain evidence for the next agent decision', async () => {
  for (const message of ['Frame was detached', 'Execution context was destroyed', 'Read timed out']) {
    const f = fixture();
    const result = await f.recovery.observe(f.entry, async () => { throw Error(message); }, () => {});
    assert.equal(result.page, f.entry); assert.equal(result.observation.inspectionError, message);
    assert.match(result.observation.text, /choose another supported recovery/);
    const next = await f.recovery.observe(result.page, f.read, () => assert.fail());
    assert.equal(next.observation.inspectionError, undefined);
  }
});

test('closing the last tab creates a blank surface without navigating or resending', async () => {
  const f = fixture(); await f.entry.close();
  const result = await f.recovery.observe(f.entry, f.read, () => assert.fail());
  assert.equal(result.page.url(), 'about:blank'); assert.equal(f.created(), 1);
});

test('a disconnected browser or failed fallback inspection never invents a receipt or hides the failure', async () => {
  const f = fixture(); await f.entry.close(); f.disconnect();
  const result = await f.recovery.observe(f.entry, async () => { throw Error('Browser disconnected'); }, () => {});
  assert.equal(result.observation.inspectionError, 'Browser disconnected'); assert.equal(f.created(), 0);
  const g = fixture(), popup = g.page('https://identity.invalid/'); g.recovery.opened(popup, g.entry);
  let calls = 0;
  const fallback = await g.recovery.observe(popup, async page => { calls++; await page.close(); throw Error('Surface closed'); }, () => {});
  assert.equal(calls, 2); assert.equal(fallback.observation.inspectionError, 'Surface closed');
});
