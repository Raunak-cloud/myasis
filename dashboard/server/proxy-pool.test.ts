import { COOLDOWN_MS, planPool, planSync, type FetchedProxy, type PoolRow } from './proxy-pool.js';

/**
 * The pool's rule, on its own: who should hold which proxy, and what a fresh
 * list from Webshare means for the accounts holding them. No database, no
 * network — the same functions the server runs, fed by hand.
 */
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

const NOW = Date.parse('2026-09-20T00:00:00Z');
const AU = { countries: ['AU'], now: NOW, cooldownMs: COOLDOWN_MS };

function proxy(id: string, extra: Partial<PoolRow> = {}): PoolRow {
  return {
    id,
    planId: '1',
    address: `203.0.113.${id.replace(/\D/g, '') || '1'}`,
    port: 7000,
    username: 'user',
    password: 'pass',
    countryCode: 'AU',
    city: 'Sydney',
    valid: true,
    userId: null,
    lastUserId: null,
    releasedAt: null,
    ...extra,
  };
}
const fetched = (row: PoolRow): FetchedProxy => ({
  id: row.id, planId: row.planId, address: row.address, port: row.port, username: row.username,
  password: row.password, countryCode: row.countryCode, city: row.city, valid: row.valid,
});
const none = new Set<string>();

// ---- giving out

let plan = planPool([proxy('p1'), proxy('p2')], ['alice', 'bob'], none, AU);
check('each paying account is given its own proxy', plan.assign.length === 2 && new Set(plan.assign.map((a) => a.proxyId)).size === 2 && !plan.waiting.length);

plan = planPool([proxy('p1')], ['alice', 'bob'], none, AU);
check('when the pool is short, the earliest customer is served first', plan.assign.length === 1 && plan.assign[0].userId === 'alice' && plan.waiting.join() === 'bob');

plan = planPool([proxy('p1', { userId: 'alice' })], ['alice'], none, AU);
check('an account that holds one keeps it, untouched', !plan.assign.length && !plan.release.length);

plan = planPool([proxy('p1', { countryCode: 'IT' }), proxy('p2', { valid: false })], ['alice'], none, AU);
check('a proxy outside the countries, or not working, is never given', !plan.assign.length && plan.waiting.join() === 'alice');

plan = planPool([proxy('p1')], ['alice'], new Set(['203.0.113.1:7000']), AU);
check('a proxy set by hand for an account is never pooled', !plan.assign.length);

// ---- taking back

plan = planPool([proxy('p1', { userId: 'alice' })], [], none, AU);
check('an account with no paid applications left gives its proxy back', plan.release.join() === 'p1');

plan = planPool([proxy('p1', { userId: 'alice' })], ['bob'], none, AU);
check('and the one given back is not handed straight to someone else', plan.release.join() === 'p1' && !plan.assign.length && plan.waiting.join() === 'bob');

plan = planPool([proxy('p1', { userId: 'alice' })], ['alice'], new Set(['203.0.113.1:7000']), AU);
check('a pooled proxy an operator then sets by hand is taken back from the pool', plan.release.join() === 'p1');

// ---- sticky addresses and cooling down

const justReleased = new Date(NOW - 60_000);
const longAgo = new Date(NOW - COOLDOWN_MS - 60_000);

plan = planPool([proxy('p1', { lastUserId: 'alice', releasedAt: justReleased })], ['bob'], none, AU);
check('an address given up minutes ago is not given to another account', !plan.assign.length);

plan = planPool([proxy('p1', { lastUserId: 'alice', releasedAt: justReleased })], ['alice'], none, AU);
check('but its old holder can have it straight back', plan.assign[0]?.proxyId === 'p1');

plan = planPool([proxy('p1'), proxy('p2', { lastUserId: 'alice', releasedAt: longAgo })], ['alice'], none, AU);
check('a returning customer gets their old address before a fresh one', plan.assign[0]?.proxyId === 'p2');

plan = planPool([proxy('p1', { lastUserId: 'carol', releasedAt: longAgo }), proxy('p2')], ['alice'], none, AU);
check('a new customer gets a never-used address before a used one', plan.assign[0]?.proxyId === 'p2');

plan = planPool([proxy('p1', { lastUserId: 'carol', releasedAt: longAgo })], ['alice'], none, AU);
check('a used address is given out again once it has cooled down', plan.assign[0]?.proxyId === 'p1');

// ---- syncing with Webshare

const held = proxy('p1', { userId: 'alice' });
let sync = planSync([held], [fetched(held)], []);
check('an unchanged list changes nothing', !sync.remove.length && !sync.moves.length && !sync.changed.length);

sync = planSync([held], [{ ...fetched(held), password: 'rotated' }], []);
check('a new proxy password reaches the account holding it', sync.changed.join() === 'alice' && !sync.remove.length);

const replacement = proxy('p9', { address: '198.51.100.9', port: 8123 });
sync = planSync([held], [fetched(replacement)], [{ from: '203.0.113.1:7000', to: '198.51.100.9:8123' }]);
check('a proxy Webshare swapped out is removed', sync.remove.join() === 'p1');
check('and its account moves to the proxy that replaced it', sync.moves.length === 1 && sync.moves[0].userId === 'alice' && sync.moves[0].to === 'p9');

const middle = '192.0.2.50:9000';
sync = planSync([held], [fetched(replacement)], [{ from: '203.0.113.1:7000', to: middle }, { from: middle, to: '198.51.100.9:8123' }]);
check('a swap of a swap is followed to where the proxy is now', sync.moves[0]?.to === 'p9');

sync = planSync([held], [fetched(proxy('p5'))], []);
check('a proxy that simply disappeared frees its account for a new one', sync.remove.join() === 'p1' && !sync.moves.length && sync.changed.join() === 'alice');

const taken = proxy('p9', { address: '198.51.100.9', port: 8123, userId: 'bob' });
sync = planSync([held, taken], [fetched(taken)], [{ from: '203.0.113.1:7000', to: '198.51.100.9:8123' }]);
check('an account is never moved onto a proxy someone else holds', !sync.moves.length);

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
